# Code navigator — S1 through S4

**Branch:** `operator/a30080` · commit `a9d5428` · 2026-08-24 · Code lane
**Design:** `dev/results/code-navigator-design.md` (operator/311c00)
**Stack:** `dev/results/code-navigator-research.md` (operator/7d8780) — both copied onto this branch

**Corrections applied:** backend is Electron MAIN, not `src-tauri`. Viewer is CodeMirror 6, not
§6's hand-written tokenizer. §6's five token roles are preserved exactly.

---

## S1 — the filesystem seam (`electron/src/main/files.ts`)

The design says one thing about this module louder than the rest:

> Every one of them MUST reject paths that escape `root` after canonicalisation. This is the only
> new attack surface the feature opens … the kind of check that gets added after the first bug
> report rather than before if it isn't written down here.

So the guard is the first thing in the file, it is a pure function, and it is tested against every
escape shape rather than the one that came to mind: `..`, an absolute path, a **sibling whose name
merely starts with the root** (`/a/rootkit` vs `/a/root` — the bug a bare `startsWith` ships), and
**a symlink pointing out of the root** (the candidate is canonicalised before comparing, so the
symlink's target is what gets judged).

- **`fileTree`** — lazy, one directory per expand. `SKIP_DIRS` is checked **by name before
  recursing**, never as a filter after a walk: the whole point is never touching `node_modules`'s
  tens of thousands of entries. Symlinked directories are not followed — that is how a walk
  escapes its root, and a tree UI has no way to render the cycle it would find. `showIgnored`
  lists the skipped directories but still does not descend into them.
- **`fileRead`** — `stat` first, then a **NUL byte in the first 8 KB**, which is the exact window
  git, `file` and ripgrep use; matching it avoids "Operator says binary, git says text". A binary
  file is never read into a string. Over the cap it **truncates at a line boundary** and reports
  the true byte count — the design's rule is that a file is never a refusal, and the cap is about
  IPC payload size, not about what CodeMirror can render.
- **`fs.watch(root, {recursive: true})`** — FSEvents-backed on macOS, so on a macOS-only app it is
  the same watching chokidar would do with no dependency. Its two rough edges are handled rather
  than ignored: it fires inside ignored directories (`coalesceChanges` drops them, so an
  `npm install` inside a lane refreshes nothing) and it does no batching (150ms debounce).
  Refcounted per root — both placements read the same worktree and must not open two streams —
  and stopped in `teardown()`, because an FSEvents stream is a real OS resource.

**A bug the tests caught.** `relative(root, abs)` was computed against the root **as given**, not
its canonical form, so under a `/tmp`-shaped root (which macOS resolves to `/private/tmp`) every
repo-relative path climbed out with `../..`. This is the same firmlink trap `worktree.ts:realOf`
documents, met from the other side, and the temp directory a test runs in is exactly such a path —
which is why it surfaced immediately instead of on someone's machine.

## S2 — the viewer

CodeMirror 6 read-only, at the pinned versions (`view` 6.43.9, `state` 6.7.1, `language` 6.12.4,
`language-data` 6.5.2, `@lezer/highlight` 1.2.3).

**One theme object for all six palettes**, and this is why CM6 rather than Shiki or Monaco:
`EditorView.theme` generates a real stylesheet through `style-mod`, so `color: 'var(--magenta)'`
is ordinary CSS that resolves at paint time. Shiki and Monaco both bake hex into a theme
definition, which would have meant **six** JSON files kept in sync with `themes/*.ts` by hand.
Nothing re-mounts on a theme switch; the variables repaint.

§6's mapping, unchanged: keyword→`--magenta`, string→`--green`, number→`--yellow`,
comment→`--fg-muted`, type/function→`--blue`, everything else→`--fg`. Six roles is a deliberate
floor — a twenty-role grammar would need a palette per theme and would be the first thing to rot.

**Grammars load per extension** through `language-data`, so the build splits into **119 chunks**
and a language a session never opens is never fetched. `vite build` is green.

**Read-only without the disabled feel** (§7): `EditorState.readOnly` **and**
`EditorView.editable.of(false)` — not the same thing, and the second is what stops the DOM being
`contentEditable` at all, which is what keeps a caret from appearing. Selection is fully painted,
because selecting and copying is the point of a viewer. The footer says `read-only` once,
positively. And the answer to "I want to change this" is the app's own: `Ask the lane about L60 →`
hands the line to the lane through the same `submitQueue` the Plan tab uses.

**Arrival** (§4.3): a `color-mix(… var(--accent) 10%, transparent)` wash on the target lines — a
tint, never a fill or a border, so nothing re-rasterizes on a radiused edge — which fades after 2s
to a persistent gutter `▸`. A permanent highlight becomes noise the moment you scroll; no mark at
all loses the answer to "which line was it?".

**Changed on disk**: the agent is *actively editing* these files, so this is the common case, not
an edge one. The view does not re-render underneath a reader — a `↻ changed on disk` row appears
and re-reads on click.

## S3 — the main view

`MainView` gains `'files'`; the toolbar's segmented control gains a fourth segment in the style it
already has. `paneVisibility` needed only its type widened — anything but `terminal` already hides
the pane.

**`SplitPane` is deliberately not used here**, even though it is exactly this shape: it pads its
index column (`12px 10px`) for a list of names, and a file tree's rows are full-bleed hit targets
whose indentation carries the hierarchy. Padding insets every row equally, which reads as a margin
error rather than as structure. The load-bearing half — two independent scrollers — is reproduced
directly.

## S4 — the routing rule and the panel

`lib/code-nav.ts`, tests written first. The design is explicit about which half matters:

> The principle B and C encode: a deep link never replaces the surface you clicked it in.

That sentence is its own test, so it cannot be refactored away by accident. Rule A comes first and
makes links **idempotent** (two links in a row cannot ping-pong the reader between surfaces —
also its own test). The width vetoes apply **at most once**: both surfaces too narrow is a real
window shape, and a veto that could fire twice would be an infinite argument between them.

`panelForm`'s thresholds (560 / 340) live in the same module as the rule, so the router and the
panel cannot disagree about what "too narrow" means. The shipped default of 460 is the **medium**
form, which is pinned by a test since it is the one that ships.

`parseFileHref` is hand-written rather than `new URL()`: a repo-relative path is not a valid URL
path component once it contains a `#` or a `%`, and round-tripping mangles it. The `:line` suffix
is anchored on **trailing digits**, so `weird:name.ts` stays a filename while `a.ts:60` is a line
link. It returns `null` for anything that is not one of our links — the regression the design
names as the one to watch, since `operator://` and `https://` go through the same canvas hit-test.

## Deliberately not built

- **Search (S7).** Not in S1–S4. The correction to the design's finding #1 is recorded here so it
  is not lost: **`@vscode/ripgrep` is the answer, not the `grep`/`ignore` Rust crates** — it ships
  a bundled `rg` binary with JSON output, which solves "there is no ripgrep on this Mac" without
  needing a Rust backend that no longer exists. I did not add the dependency, because an unused
  package and an IPC method nothing calls are worse than a note. Say the word and it is an hour.
- S5/S6 (deep links from the diff and the transcript). The scheme, the parser and the routing rule
  are all built and tested; what is missing is the two call sites that emit links.
- The `⌘⇧F` chord, the `⧉`/`⌥↗` actions, and the `⌄` recent-files menu.

## Checks

| | |
|---|---|
| `tsc --noEmit` (root) | **0** |
| `tsc --noEmit -p electron/tsconfig.json` | **0** |
| `vitest run` (electron) | **350 passed, 0 failed** (was 314) |
| `npm test` (root) | **834 passed / 33 failed** — the 33 unchanged |
| `vite build` | green; 119 chunks, grammars split out |

70 new tests: every path-escape shape, the ignore filter at depth, lazy listing and symlink
refusal, binary sniffing, truncation at a line boundary, line counting that matches `wc -l`, the
language table, watcher coalescing; then the whole routing rule, the href round-trip, the panel
forms and the breadcrumb shortener.

## Not verified

**Nothing has been seen on screen.** The viewer, the tree, the theme against six palettes, and the
arrival wash are all unexercised in a real window — GUI verification is yours. Worth an eyeball,
in this order:

1. Open **Files** in the main view on a lane with a worktree; the tree lists the repo without
   `node_modules`, and a file opens highlighted.
2. The design's §6 note: check **`--yellow` and `--green` on the three LIGHT palettes**, which is
   where every previous ink in this app has failed its contrast floor.
3. Open Files in the right panel at the default 460 and drag it below 340 — the form should change
   at the threshold, and line numbers should survive both.
4. Open the repo's largest file and watch memory. The design calls this "the riskiest thing in the
   whole feature" for a renderer that dies at ~1.2 GB; CM6 virtualizes, but that is a claim from
   its docs until it is measured here.
