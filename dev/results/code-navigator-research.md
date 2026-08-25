# Read-only code navigator — viewer engine + fs seam research

**Scope:** research only, no code changed. Verified against `npm view` (live registry, so
versions below are current as of this session), official docs (codemirror.net, shiki.style,
chokidar/vscode-ripgrep on GitHub), the installed `electron ^43.4.1` (bundles **Node 24.17–24.18**
— confirmed via Electron's own release notes), and one direct experiment on this machine showing
`rg` is *not* actually installed system-wide (see § ripgrep). Checked the existing codebase first:
there is **no existing code-viewer engine anywhere in the repo** — `DiffBody.tsx` is a hand-rolled
diff-line parser with zero third-party editor dependency, and `package.json` has no
CodeMirror/Monaco/Shiki today. This is a green-field pick, not a "match what's already there."

## Viewer engine comparison

### Bundle size added to the Vite build

| | Added to bundle | Source |
|---|---|---|
| **CodeMirror 6** (hand-picked packages, no `codemirror` meta-package) | **~50–90KB gzip** for `@codemirror/state` + `@codemirror/view` + `@codemirror/language` + one `@lezer/highlight`; each additional `@codemirror/lang-*` grammar is a few KB and can be **dynamically imported per file extension**, so unused languages never ship | codemirror.net bundling docs; live `npm view` sizes below |
| **Shiki** | **~700KB–1.2MB gzip** for the pre-composed "full"/"web" bundles (all themes+langs); the fine-grained bundle API lets you trim to just the languages/themes you register, but the WASM Oniguruma engine itself is a fixed ~500KB-class cost unless you switch to the JS-regex engine (smaller, faster startup, slightly less-accurate grammars) | shiki.style/guide/bundles |
| **Monaco** | **~2.4MB+ gzip** even trimmed; **5–10MB uncompressed** for the full editor incl. its own worker bundles (JSON/CSS/HTML/TS language services) | search synthesis (multiple sources, consistent numbers) |

Live registry versions pulled just now (`npm view <pkg> version`):

```
codemirror                 6.0.2   (meta-package — skip it, hand-pick below instead)
@codemirror/view           6.43.9
@codemirror/state          6.7.1
@codemirror/language       6.12.4
@codemirror/language-data  6.5.2   (lazy per-extension grammar loader)
@codemirror/lang-javascript 6.2.5
@lezer/highlight           1.2.3
monaco-editor               0.56.0
shiki                       4.4.3
```

**CodeMirror 6 wins by roughly 10-25x** over Monaco and 8-15x over a stock Shiki bundle, and its
per-language grammars are the only one of the three that tree-shake to near-zero for languages
the user never opens.

### Memory per open file

This matters concretely here: **the renderer is already killed and respawned hourly at
~1.1–1.2GB** (project memory: `project_chat_markdown_freeze.md`), and closing lanes doesn't scope
that retention down. Adding an editor engine that holds heavy per-document state multiplies that
risk per open file/tab.

- **CodeMirror 6**: minimal per-doc overhead — its `Text` data structure is a rope, and it only
  *renders* DOM nodes for the visible viewport (true virtualization, not "render everything then
  clip with `overflow`"). A closed tab's `EditorState` can be dropped entirely and re-created from
  the source string cheaply. This is the cheapest of the three per open file by a wide margin.
- **Shiki is not a persistent widget** — it tokenizes text into HTML once and hands you a string.
  If you feed a whole large file through it and mount the resulting HTML in the DOM, you get an
  **unvirtualized DOM tree the size of the whole file** (no viewport clipping at all) — for a
  10k-line file that's 10k+ styled `<span>`-laden DOM nodes sitting in memory even when scrolled
  off-screen, which is a materially worse profile than CodeMirror for exactly the large-file case
  this navigator needs to handle. Shiki only wins on memory if you *also* build a virtualized list
  around it (see below) — at which point you've reimplemented a chunk of what CodeMirror already
  does.
- **Monaco** ships a full text-model + tokenizer + multiple web workers per editor instance —
  each open file spins up worker threads with their own heap, and Monaco's own model retains
  significant metadata (undo stack, folding ranges, bracket-pair-colorization state) even in a
  read-only configuration. Heaviest of the three per open file.

### Handling 10k+ line and 5MB files (virtualization)

- **CodeMirror 6**: designed for this. The [official "huge doc" demo](https://codemirror.net/examples/million/)
  loads a document of several million lines; the viewport-only DOM rendering keeps scroll smooth,
  and the Lezer incremental parser has a **self-limiting work budget** — if you scroll fast enough
  that highlighting can't keep up, it intentionally stops highlighting rather than blocking the
  main thread or draining battery, then catches back up when scrolling settles. This is exactly
  the graceful-degradation behavior a 5MB minified file needs.
- **Shiki**: no virtualization concept at all — it's a string-in, HTML-out tokenizer. A 5MB file
  run through Shiki either blocks synchronously for a non-trivial parse (Oniguruma/WASM grammars
  are not free on huge inputs) or needs to be chunked by the caller, and the resulting DOM has no
  built-in windowing — you'd need to pair it with `react-window`/similar and re-highlight only the
  visible chunk on scroll, which is real, non-trivial glue code.
- **Monaco**: handles large files reasonably (VS Code itself uses it), but its heavier per-model
  cost and worker-based tokenization make it the most expensive of the three to keep several
  large files open simultaneously — and Monaco's workers need to be loaded via classic
  `Worker`/blob URLs, which needs care under Operator's renderer sandbox (`sandbox: true,
  nodeIntegration: false, webSecurity: true` — `index.ts:93-97`); Vite has a community plugin
  (`vite-plugin-monaco-editor`) to wire this up, but it's another moving part CodeMirror doesn't
  need (CM6 needs no web workers at all for this use case).

### Mapping to the app's 4 CSS-var themes

Operator's whole styling system is semantic CSS variables, no hardcoded colors anywhere
(`feedback_ui_style` project memory; confirmed in `src/renderer/styles.css` — `--bg`, `--surface`,
`--muted`, `--accent-fg`, `--add-fg`/`--del-fg`, etc., swapped per theme). Any engine chosen here
has to paint through those variables, not a fixed hex palette per theme.

- **CodeMirror 6**: `EditorView.theme()` and `HighlightStyle.define()` both take **plain CSS
  string values** — the docs' own examples use fixed hex (`color: "white"`, `{tag: tags.keyword,
  color: "#fc6"}`) purely for simplicity, but under the hood `EditorView.theme` is generating a
  real stylesheet via the `style-mod` library, so `color: "var(--fg)"` /
  `backgroundColor: "var(--bg-surface)"` is valid CSS and resolves live at paint time exactly like
  any other CSS rule — **one `HighlightStyle` built once, referencing the app's existing variable
  names, is all four themes for free**, with no per-theme JS objects to maintain and no re-mount
  needed when the user switches themes (the variables just repaint). This is the only one of the
  three engines where "theme = CSS vars" is a first-class, load-bearing feature of the theming
  API rather than a workaround.
- **Shiki**: themes are **VS Code `.json` theme definitions with baked-in hex/rgba colors** —
  Shiki's whole value proposition is pixel-matching a specific named VS Code theme, which is the
  opposite of "resolve from CSS vars." You'd have to either fork/generate a synthetic Shiki theme
  file per Operator theme (four JSON files to keep in sync with the CSS vars by hand) or bypass
  Shiki's theme system and use its tokenizer only for *scope names*, then map those scopes to CSS
  classes yourself — at which point Shiki is providing grammars only, not theming, and you're back
  to hand-writing the CSS-var mapping regardless.
- **Monaco**: same shape as Shiki — themes are defined via `monaco.editor.defineTheme()` with
  fixed hex `rules` per token type; CSS variables are not natively supported, same
  four-JSON-files-by-hand problem.

### Line-range highlight + scroll-to-line API

- **CodeMirror 6**: both are standard, documented patterns.
  - Scroll-to-line: dispatch `EditorView.scrollIntoView(pos, {y: "center"})` as a transaction
    effect — `view.dispatch({effects: EditorView.scrollIntoView(pos, {y: "center"})})`. Stable,
    documented API present since the 6.0 release; noted here from established CM6 usage rather
    than a fresh doc fetch (the reference page's summarizer kept truncating before reaching the
    `view` package section) — worth a 2-minute confirmation against `codemirror.net/docs/ref/`
    before wiring it up, but this is not a contested or version-fragile API.
  - Line-range highlight: the [official "zebra stripes" example](https://codemirror.net/examples/zebra/)
    (fetched directly) is literally this pattern already: a `ViewPlugin` builds a `DecorationSet`
    from `Decoration.line({attributes: {class: "..."}})` for a computed set of line numbers,
    updating on `viewportChanged`/`docChanged`. Swap "every Nth line" for "lines in the requested
    range" and it's exactly a scroll-to-and-highlight-range feature.
- **Shiki**: no concept of "current viewport" or scroll position at all (it's not a widget) — you'd
  implement both scroll-to-line and range-highlight yourself in whatever container renders its
  HTML output.
- **Monaco**: has both (`editor.revealLineInCenter()`, `deltaDecorations`), comparable to CM6
  functionally, just heavier to carry for what this feature needs.

### Later upgrade path to editing

This is CodeMirror's strongest structural argument: **a read-only CM6 view and an editable one are
the same engine, same document model, same decorations/extensions API** — going from "viewer" to
"editor" later is `EditorState.readOnly.of(true)` → `false` (or dropping the `EditorView.editable`
facet) plus adding `@codemirror/commands`' `defaultKeymap` and, if wanted,
`@codemirror/autocomplete`/`@codemirror/lint`. No engine swap, no rewritten theming, no rewritten
virtualization. There's also `@codemirror/merge` (**6.12.2** on the registry) if a future diff/
merge view is ever wanted, built on the same primitives.

Shiki has no editing story at all — it's a highlighter, not an editor; "upgrading" it to editing
means bolting on a completely separate editing layer (i.e., picking CodeMirror or Monaco anyway,
later, as a second engine). Monaco can obviously edit (it's VS Code's editor), so it doesn't lose
on this axis — but choosing it today to "future-proof" editing pays the full worker/bundle/memory
cost from day one for a feature that isn't being built yet.

### Verdict

**CodeMirror 6**, hand-picked packages (not the `codemirror` meta-package, which pulls in
autocomplete/lint/search extras a read-only viewer doesn't need), with `@codemirror/language-data`
for lazy per-extension grammar loading. It wins bundle size and memory outright, has native
virtualization for the large-file requirement, is the only engine whose theming API treats CSS
variables as first-class rather than a workaround, has the exact line-highlight/scroll-to-line
primitives needed already documented as first-party examples, and the "later, editing" path is a
config flip on the same engine rather than a second integration.

## Filesystem seam (Electron main)

### `listDir` — lazy, ignoring `node_modules`/`.git`/`target`

Use `fs.promises.readdir(dir, {withFileTypes: true})` **one directory at a time**, called again
per expand — not a recursive walk up front. This is the natural way to get "lazy": the renderer
asks for one directory's immediate children when the user expands a tree node, main reads just
that one level. Skip the heavy directories **by name check before recursing into them**, not by
filtering results after a full walk — the whole point of "lazy" is never touching
`node_modules`'s tens of thousands of files in the first place:

```ts
const SKIP = new Set(['node_modules', '.git', 'target', 'dist', 'build', '.next', '__pycache__'])
// in the readdir loop: if (entry.isDirectory() && SKIP.has(entry.name)) continue
```

No dependency needed — `fs.readdir` + `Dirent.isDirectory()`/`isSymbolicLink()` (skip symlinks by
default to avoid cycles, same as most tree UIs) is the whole implementation. This mirrors the
existing worktree/reap code's own "skip by name before recursing" pattern already used elsewhere
in the codebase for the same class of directories (`project_worktree_reap_current_state.md`
project memory notes Cargo `target/` as a top offender by size — same directory this feature
should also skip for the same reason).

### `readFile` with size cap + binary detection

- **Size cap**: `fs.promises.stat(path)` first, reject/truncate before reading if
  `stat.size > CAP` (recommend the same order of magnitude as the pty's own `HISTORY_CAP` concept
  in `terminals.ts:22` — a few hundred KB to low-single-digit MB is the right range for "render in
  a text view," not "load a 5MB minified bundle into a DOM-backed editor's undo-tracked model.").
  For a file over the cap, either refuse and tell the renderer "too large to preview" or (better,
  matching CM6's own scaling story above) read it anyway but skip the size check specifically for
  the *editor's* virtualization — the cap is really about protecting IPC payload size and Node
  string/Buffer allocation, not the editor's own capability, so tune it to "how big an IPC message
  is reasonable," not "how big a file CodeMirror can show."
- **Binary detection**: read only the **first ~8000 bytes** (`fs.promises.open(path,'r')` +
  `fh.read(buffer, 0, 8000, 0)`, matching git's and ripgrep's own heuristic window) and check for
  a NUL byte (`0x00`) — the same algorithm `git diff`/`file`/ripgrep itself use to decide
  "binary." This needs **no dependency** (`isbinaryfile` on npm — **6.0.0** on the registry — is a
  fine drop-in if a slightly more thorough heuristic is wanted, but the null-byte-in-first-8KB
  check is what the tools this app already shells out to (`git`, `rg`) use themselves, so matching
  it avoids "Operator says binary, git says text" disagreements).

### chokidar vs `fs.watch` for refreshing tree/file on lane edits

Operator is **macOS-only** (per `CLAUDE.md`: signed+notarized DMG, Platform: darwin) — this
narrows the decision a lot, because the two options' real trade-off is cross-platform recursive
support, and there's only one platform here.

- **Native `fs.watch(dir, {recursive: true})`**: fully supported on macOS (backed by FSEvents,
  the same mechanism chokidar itself uses on macOS) and on Windows, but **not** on Linux — a
  constraint that doesn't matter for this app. Zero dependencies, zero bytes added to the bundle.
  Caveats to design around, not blockers: (a) events fire for changes *inside* ignored directories
  too (`node_modules` churn from `npm install`) — filter the reported relative path against the
  same `SKIP` set used in `listDir` before deciding to refresh anything; (b) rapid-fire bursts
  (git operations, a formatter rewriting many files) need a small debounce (100–200ms, coalesce by
  directory) before triggering a tree refresh, since `fs.watch` gives you no batching on its own.
- **chokidar** (registry: **5.0.0**, confirmed via `npm view`): worth knowing what changed before
  reaching for it — v4 **dropped glob-pattern `ignored` support entirely** (now a function
  `(path, stats) => boolean`, a regex, or an array of exact literal paths — no more
  `ignored: '**/node_modules/**'`), and v5 is **ESM-only**, needs **Node ≥ 20.19** (Electron 43
  bundles Node 24.17+, confirmed via Electron's own release notes, so this is not a blocker here),
  and is down to **one dependency** (`readdirp`) at **~80KB** package size — chokidar hasn't
  bundled `fsevents` since v4, so on macOS it's now effectively a thin coordination layer over the
  same FSEvents-backed native watching `fs.watch` already gives you, plus `awaitWriteFinish`
  (waits for a file's size to stabilize before firing, so a half-written atomic-rename save from a
  lane's editor doesn't get read mid-write) and normalized add/change/unlink events.

**Recommendation: native `fs.watch(dir, {recursive: true})` with a small manual debounce and a
path-prefix filter reusing the `listDir` skip-set.** Given the app is macOS-only, chokidar's main
selling point over the platform's native API (cross-platform recursive watching) is moot, and its
`awaitWriteFinish` convenience is easy to approximate for this feature's actual need — a debounced
re-`stat`-then-reread on the *currently open* file, which naturally tolerates a mid-write read
(the next debounced pass just re-reads it once it settles) without needing chokidar's bookkeeping.
If atomic-write correctness for the tree view (not just the open file) becomes a real pain point
later, chokidar 5 is a lean, well-scoped fallback — it is not a case of "avoid it," just "the
native API already covers this app's actual platform matrix for free."

### Ripgrep availability + JSON search API

**Verified directly on this machine, not assumed:** there is **no real system-installed `rg`**.
`command rg` (bypassing shell functions) returns `command not found`, and `brew list ripgrep` says
`No such keg`. The `rg` that appears to work interactively is a **shell function Claude Code's own
CLI installs into shell snapshots**, shimmed to Claude Code's own bundled ripgrep binary — it is
not a real, generically-available system binary, and nothing about it would be present for an
Operator end user who doesn't happen to have Claude Code's shell integration loaded. **Depending
on "system `rg`" for a shipped feature is not viable** — this isn't a theoretical caveat, it's the
actual state of the very machine this was tested on.

**Use `@vscode/ripgrep`** (registry: **1.18.0**, confirmed via `npm view`) — the same package VS
Code itself ships. It resolves a prebuilt `rg` binary for the current `process.platform`/`arch`
with `const { rgPath } = require('@vscode/ripgrep')`, no postinstall network fetch, no runtime
compilation. For a signed/notarized macOS-only build this adds one architecture's binary (a few
MB) to the app bundle — small next to Electron's own footprint, and it's the only choice that
actually works on every user's machine rather than just the dev's.

**JSON API design**: spawn `rgPath` with `--json` plus scoping/safety flags, and parse **NDJSON**
(one JSON object per line, not a JSON array) from stdout:

```
rg --json --line-number --with-filename --max-filesize=<CAP> \
   --glob '!node_modules' --glob '!.git' --glob '!target' \
   -- <pattern> <dir>
```

Each line is one of `{"type":"begin",...}`, `{"type":"match","data":{"path":..,"line_number":..,"lines":..,"submatches":[{"match":..,"start":..,"end":..}]}}`,
`{"type":"end",...}`, `{"type":"summary",...}` — parse line-by-line as they stream (don't buffer
the whole stdout and `JSON.parse` it as one array), so results can start rendering before the
search finishes on a large repo. Note `--glob '!node_modules'` etc. here is ripgrep's *own*
ignore syntax (real gitignore-style globs — unrelated to chokidar's glob removal above, which was
specifically about chokidar's own `ignored` option) — ripgrep also already respects `.gitignore`
by default, so the explicit globs are only needed for directories not covered by the repo's
`.gitignore` (or when searching outside a git repo).

## Recommended stack — concrete versions

```
@codemirror/view           6.43.9
@codemirror/state          6.7.1
@codemirror/language       6.12.4
@codemirror/language-data  6.5.2     // lazy grammar loading per file extension
@lezer/highlight           1.2.3     // tag vocabulary for the HighlightStyle
@vscode/ripgrep            1.18.0    // bundled rg binary, no system dependency
```

Explicitly **not** adding: `codemirror` meta-package (pulls in unneeded autocomplete/search/lint),
`monaco-editor` (too heavy for a read-only navigator, worker/CSP friction under the sandboxed
renderer), `shiki` (no virtualization or scroll API — would need CodeMirror or an equivalent
built around it anyway, and its theme system fights the CSS-var requirement rather than helping),
`chokidar` (native `fs.watch` covers this app's macOS-only platform matrix without a dependency),
`isbinaryfile` (the null-byte-in-first-8KB check needs no package and matches the heuristic
`git`/`rg` already use).

Individual `@codemirror/lang-*` packages (javascript, python, rust, css, html, json, markdown,
etc.) load on demand via `@codemirror/language-data`'s `languages` registry, matched by file
extension, dynamically imported per opened file — so a session that only ever opens `.ts` files
never pays for the Python/Rust/CSS grammars.
