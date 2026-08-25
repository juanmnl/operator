# Files — a read-only code navigator, in both placements

**Design, 2026-08-24. Design only; nothing here is built.** Covers the main-view mode, the
right-panel tab, the deep-link routing rule, and an ordered build plan.

---

## 0. What was checked first, and the four findings that changed the design

| # | Finding | Where | Consequence |
|---|---|---|---|
| 1 | **There is no ripgrep binary on this Mac.** `rg` resolves to a *zsh function* shimming to the Claude Code binary; `whence -p rg` finds nothing, and nothing sits at `/opt/homebrew/bin/rg` or `/usr/local/bin/rg`. | shell + filesystem | A design that shells out to `rg` ships a search that finds nothing on the primary user's own machine — and a zsh function does not exist in Operator's spawned process at all. Search must use ripgrep's **libraries** (`grep` + `ignore` crates) in `src-tauri`. §5. |
| 2 | **The transcript is a `<canvas>`, not DOM** — `CanvasConversation` lays out with `CanvasRenderingContext2D` and hit-tests words. It *already* carries per-word `href` + `linkAtXY()` + a click that calls `openExternal`. | `CanvasConversation.tsx:159, 897-911, 969` | Deep links from the transcript cannot be `<a>` tags — but they don't need to be. The link plane exists; this adds an internal URL scheme and one branch before `openExternal`. Cheapest possible integration, and §4 leans on it. |
| 3 | **Every theme already ships a per-palette ANSI set as CSS vars** — `--red --green --yellow --blue --magenta --cyan`, tuned against each background, in all six palettes. | `src/renderer/themes/*.ts` | Syntax highlighting needs **no new per-theme design work** and no hardcoded colours. Five token roles map onto tokens that already exist. §6. |
| 4 | **There are six palettes, not four themes** — three identities (Mission Control, Mr Pink, 1984) × light/dark. The standalone "Light" identity was removed. | `themes/index.ts:31-49` | The brief and `CLAUDE.md` both say four. Verification is against six. |

Two more, load-bearing but unsurprising: `SplitPane` (index 240 + detail, two independent
scrollers) is exactly the main view's layout and is already extracted; and `TOOLBAR_BAND_H = 44`
/ `PANEL_SUBHEAD_H = 30` from `lib/chrome` are the only two header heights this may use.

---

## 1. What Files is, in one line

> **The lane's worktree, readable in place, at the line the agent was talking about.**

Not an editor with editing removed. The whole point is arrival — a `path:line` in the
transcript, a diff hunk, a task's change — landing you on the line with the code around it,
without leaving Operator and without breaking the lane's checkout. Browsing is the fallback,
not the headline.

Two placements, one viewer component, one nav state per session.

---

## 2. Placement A — the main view

`MainView` gains `'files'`: `'terminal' | 'chat' | 'preview' | 'files'`. The toolbar's segmented
control gains a fourth segment, in the same style it already has (transparent track,
`--overlay-subtle` on the active segment, `--accent` ink, no fill).

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ▤  Code · operator/311c00   ⑂ operator/311c00     CONSOLE CHAT PREVIEW ▏FILES▕   ⋯ ▦ │  44
├──────────────────────────────────────────────────────────────────────────────────────┤
│ ⌕ search this project                        lane worktree ▾   read-only             │  30
├───────────────────────────┬──────────────────────────────────────────────────────────┤
│ ▾ src                     │  src/renderer/lib/model-config.ts          ⧉  ⌥↗  ↑ lane │
│   ▾ renderer              │ ┌──────────────────────────────────────────────────────┐ │
│     ▾ components          │ │ 54 │ const setBool = (v: boolean | undefined): v is … │ │
│       ▸ session        M2 │ │ 55 │                                                  │ │
│       ▸ settings          │ │ 56 │ /** Resolve one lane's launch config.            │ │
│     ▾ lib                 │ │ 57 │  *                                               │ │
│         chrome.ts         │ │ 58 │  *  Per FIELD, first defined wins: the lane's …  │ │
│         lane-color.ts     │ │ 59 │  */                                              │ │
│      ▸  model-config.ts M │ │▸60 │ export function resolveAgentConfig(              │ │
│         roster.ts       M │ │ 61 │   role: Role,                                    │ │
│     ▸ views               │ │ 62 │   projectDefaults?: Project['defaults'],         │ │
│   ▾ shared                │ │ 63 │ ): ResolvedAgentConfig {                         │ │
│       types.ts          M │ │ 64 │   const pin = …                                  │ │
│ ▾ src-tauri                 │ └──────────────────────────────────────────────────────┘ │
│   ▾ src                   │  ts · 412 lines · 14.2 KB          Ask the lane about L60 │
│       lib.rs         M+31 │                                                          │
└───────────────────────────┴──────────────────────────────────────────────────────────┘
```

- **Left column = `SplitPane`'s index at 240**, the house width. It scrolls on its own; the
  viewer scrolls on its own. No draggable divider — the extracted component deliberately has
  none, and adding one here would be the first consumer to ask.
- **`M` / `A` / `??`** at a row's right edge are the **porcelain status letters `DiffBody`
  already renders** (`DiffBody.tsx:152`), same glyphs, same `--fg-muted`, same 9px mono. A
  collapsed directory carries the count of modified files beneath it (`M2`) so a change is never
  hidden behind a closed folder. `+31` on a row is `--add-fg`, the diff's own token.
- **`▸60`** in the gutter is the deep-link arrival mark. §4.
- **`lane worktree ▾`** switches the root to the project's main checkout. A `Segmented` would be
  wrong here — it is a source selector, not a setting, and it needs to name a branch. A `PopMenu`
  with two rows: `lane worktree — operator/311c00` and `project — main`, the second with its
  own status letters resolved against `main`.
- **`read-only`** is a mono chip in the sub-head, stated once, positively. §7.

### 2.1 Search, in the main view

Search takes over the **index column**, not the viewer — the file you were reading stays on
screen, which is what makes jumping between hits cheap.

```
├───────────────────────────┬──────────────────────────────────────────────────────────┤
│ ⌕ resolveAgentConfig    ✕ │  src/renderer/lib/model-config.ts          ⧉  ⌥↗  ↑ lane │
│ Aa  .*  ⌗ path filter     │ ┌──────────────────────────────────────────────────────┐ │
│ 14 matches · 6 files      │ │ 58 │  *  Per FIELD, first defined wins: the lane's …  │ │
│                           │ │ 59 │  */                                              │ │
│ src/renderer/lib          │ │▸60 │ export function resolveAgentConfig(              │ │
│  model-config.ts        3 │ │ 61 │   role: Role,                                    │ │
│   60  export function re… │ │ 62 │   projectDefaults?: Project['defaults'],         │ │
│   98    return resolveAg… │ │ 63 │ ): ResolvedAgentConfig {                         │ │
│  roster.ts              1 │ │ 64 │   const pin = …                                  │ │
│   22    const cfg = reso… │ │ 65 │                                                  │ │
│                           │ └──────────────────────────────────────────────────────┘ │
│ src/renderer/components   │  ts · 412 lines · 14.2 KB          Ask the lane about L60 │
│  RosterPanel.tsx        6 │                                                          │
│   1319  {model} · {effo…  │                                                          │
│                           │                                                          │
│ ⏱ stopped at 1,000 match… │                                                          │
└───────────────────────────┴──────────────────────────────────────────────────────────┘
```

Grouped by directory then file, match line numbers in the gutter, the matched substring in
`--accent` ink (never a fill). One click = viewer at that line. `↑`/`↓` walk hits without
touching the mouse; the viewer follows.

**The cap is stated, never silent** — `stopped at 1,000 matches (6,412 files searched)`. A
truncated result set that looks complete is the failure mode worth designing against.

---

## 3. Placement B — the right panel

`PanelTab` gains `'files'`: `'plan' | 'diff' | 'chat' | 'files'`. Same tab row, same
`TOOLBAR_BAND_H`, same uppercase mono tabs with `--accent` on the active one.

The panel has **three forms, by measured width**, and the thresholds are derived rather than
picked: JetBrains Mono at 11px is ≈6.6px/char, so 80 columns of code ≈ 528px of text.

| Width | Form |
|---|---|
| **≥ 560** | Breadcrumb + viewer, with a `▤` disclosure that overlays the tree as a 200px sheet from the left. |
| **340 – 560** | Breadcrumb + viewer. Tree only via the disclosure. Line numbers stay. |
| **< 340** | File only. Breadcrumb collapses to the file name plus a `⌄` menu; line numbers keep their column (they are the addressing scheme — dropping them is what makes a deep link unverifiable). |

Default `CONVERSATION_PANEL_W` is 460, so **the middle form is the one that ships by default**
and deserves the most attention:

```
┌────────────────────────────────────────────┐
│  PLAN   DIFF   CHAT   ▏FILES▕              │ 44
├────────────────────────────────────────────┤
│ ▤  …/renderer/lib/model-config.ts      ⌕ ⧉ │ 30
├────────────────────────────────────────────┤
│  56 │ /** Resolve one lane's launch config.│
│  57 │  *                                   │
│  58 │  *  Per FIELD, first defined wins: … │
│  59 │  */                                  │
│ ▸60 │ export function resolveAgentConfig(  │
│  61 │   role: Role,                        │
│  62 │   projectDefaults?: Project['defaul… │
│  63 │ ): ResolvedAgentConfig {             │
│  64 │   const pin = …                      │
│                                            │
├────────────────────────────────────────────┤
│ read-only · ts · 412 lines   Ask the lane → │
└────────────────────────────────────────────┘
```

Narrow form, < 340:

```
┌──────────────────────────────┐
│ PLAN DIFF CHAT ▏FILES▕       │
├──────────────────────────────┤
│ model-config.ts ⌄        ⌕ ⧉ │
├──────────────────────────────┤
│  59 │  */                    │
│ ▸60 │ export function resolv… │
│  61 │   role: Role,          │
│  62 │   projectDefaults?: P… │
├──────────────────────────────┤
│ read-only · L60      Ask →   │
└──────────────────────────────┘
```

Long lines **scroll horizontally inside the viewer**; they never wrap. Wrapping renumbers
nothing but destroys the one-line-one-number contract a deep link depends on. The `⌄` menu
carries: recent files in this session, the changed-file list, and `Open the tree…`.

---

## 4. Deep links — the routing rule

### 4.1 The scheme

One internal URL, used by every source:

```
operator://file/<abs-or-repo-relative-path>[:line[:endLine]][?root=lane|project]
```

Sources, and what each already has to hand:

| Source | Where the path comes from | Integration cost |
|---|---|---|
| **Transcript tool-call line** | `ToolBlock.target` (the summarizer's path, present on Read/Edit/Write/Grep) via `runDetail()` | The canvas link plane already exists — give the target word an `href` and branch in the click handler before `openExternal`. |
| **Diff hunk header** | `DiffBody`'s `@@ -a,b +c,d @@` line — the `+c` is the line number, the section's `file.path` is the file | The `@@` row is already its own element; it becomes a button. |
| **Diff file header** | `file.path` | Already a button (the collapse toggle) — the path span gets its own click. |
| **Task card** | `ProjectTask.diffStat` carries counts, **not paths** — verified | So a task card links to *its diff*, and the file list within it links onward. Don't invent per-file data the task doesn't have. |
| **Search result** | its own row | direct |
| **Command palette** | `Open file…` | direct |

### 4.2 The rule

`resolveFileTarget(origin, layout, widths) → 'main' | 'panel'`, one pure function in
`lib/code-nav.ts`, with tests. Evaluated in order:

```
A.  Files is ALREADY open in one of the two surfaces        → that surface.
B.  origin === 'panel'                                      → main view.
C.  origin === 'main'                                       → panel  (open it if closed).
D.  origin === 'elsewhere'  (task card, palette, sidebar)    → main content ≥ 900 ? main : panel.
E.  …then one width veto, applied to whatever A–D chose:
        chose 'panel' and panel width  < 340   → main
        chose 'main'  and main content < 640   → panel
```

**The principle B and C encode: a deep link never replaces the surface you clicked it in.**
Clicking a path in the transcript you are reading must not close that transcript — so a
main-view click opens the panel, and a panel click opens the main view. This is the rule the
whole thing lives or dies on; the width numbers are secondary.

**A comes first and is not a special case.** It makes the link idempotent: once the viewer is
somewhere, every subsequent link goes to that same viewer. Without it, clicking two paths in a
row could ping-pong the reader between two surfaces.

**The numbers.** `900 = 240 (SplitPane index) + 660 (≈100 columns at 6.6px/char)` — the width
at which the main view can show the tree *and* a full line. `640` is the same 100 columns
without a tree; below it the main view has no advantage over the panel and the veto sends the
link to the panel instead. `340` is the panel's file-only floor from §3.

**Measure the content box, not `window.innerWidth`.** The sidebar (collapsible) and the panel
(460 by default) both eat it, and a rule keyed on the window would send a link to a 300px main
view on a laptop with both open.

### 4.3 Arrival

Landing at a line has to be visible without being loud:

- The target line gets a **tint wash** — `color-mix(in srgb, var(--accent) 10%, transparent)` —
  the same technique the diff's `@@` row already uses, and a `▸` in the gutter. No border, no
  fill, nothing that re-rasterizes on a radiused edge.
- The wash **fades after 2s** to a persistent, quieter gutter `▸`. A permanent highlight becomes
  noise the moment you scroll; no mark at all loses the answer to "which line was it?".
- A range (`:60:74`, from a hunk) tints the whole range and scrolls its **first** line to ⅓
  height, not to the top — context above the target is the reason you followed the link.
- If the main view was hijacked (rule B), the sub-head grows a one-click way back:
  `← Chat`, naming the view it displaced. `Esc` does the same. A deep link that steals the
  main surface must be exactly one gesture reversible.
- **Path not found** (the agent edited a file that has since been deleted, or the link points
  outside the root): the viewer shows the path, says `Not in this worktree`, and offers
  `Look in project — main ↗`. Never a blank pane, never a silent no-op — a dead link that does
  nothing reads as the feature being broken.

---

## 5. Search — the engine

`grep` + `grep-searcher` + `ignore` crates in `src-tauri` (ripgrep's own libraries: same regex
engine, same `.gitignore` semantics, same binary-file detection). Not a `Command::new("rg")`,
for finding #1 — and not a Tauri sidecar either, which would add a second binary to sign and
notarize on every release for no capability the crates don't already give.

```rust
#[tauri::command]
async fn file_search(root: String, query: String, opts: SearchOpts) -> Result<String, String>
// streams `file-search-hit` events; returns a summary { matches, files, capped }
```

Streaming rather than a single return: the first hits should paint while the walk is still
running, and a 6,000-file repo must not block the bridge. Caps — 1,000 matches, 200 files,
5s wall clock — are **reported**, never silent (§2.1).

`opts`: `{ caseSensitive, regex, pathGlob, includeIgnored }`. `includeIgnored` defaults **off**,
which is the whole reason to use `ignore` rather than a hand-rolled walk: searching
`node_modules` and `target/` is both slow and useless, and the repo's own worktree trace put
Cargo `target/` at the top of the disk-usage list.

---

## 6. Syntax highlighting — five roles, zero new colours

A hand-written tokenizer in `lib/syntax.ts`, following the precedent already set by
`lib/canvas-md.ts` (the chat renders markdown with a pure tokenizer rather than
`react-markdown`, deliberately). No new dependency.

**Five token roles, and they map onto tokens every palette already defines** (finding #3):

| Role | Token | Why that one |
|---|---|---|
| keyword / control | `--magenta` | the reserved-word hue in all six xterm palettes |
| string / char | `--green` | ditto |
| number / constant / boolean | `--yellow` | ditto |
| comment / doc | `--fg-muted` | comments are meta ink, and this is the app's meta ink |
| type / class / function name | `--blue` | ditto |
| everything else | `--fg` | plain code is body text |

Six roles is a deliberate floor. A 20-role TextMate grammar would need a palette per theme and
would be the first thing to rot; six roles keyed to hues that already exist survive a seventh
theme with no work at all. Contrast is inherited from palettes already tuned for terminal text
on that exact background — the one thing worth measuring at build time is `--yellow` and
`--green` on the three *light* palettes, which is where every previous ink in this app has
failed its floor.

**Grammars: the repo's own languages first** — TS/TSX/JS, Rust, JSON, CSS, Markdown, TOML,
shell. Anything else renders as plain mono, which is honest and never wrong. A file whose
language is unknown says so in the footer (`plain text`) rather than pretending.

---

## 7. Read-only, without the disabled feel

The rule: **never draw a disabled editor.** No greyed toolbar, no `contentEditable` with a
caret that goes nowhere, no `readOnly` input styling, no tooltip explaining what you can't do.

Instead the surface is *positively* a viewer, and says so once:

- One mono chip, `read-only`, in the sub-head — where `PANEL_SUBHEAD_H` bands already carry
  status. Stated, not apologised for.
- **Text selection works.** This is a viewer; selecting and copying is the point, and it is
  the reason the viewer is DOM and not canvas (unlike the transcript).
- The actions that DO exist are the ones on screen: `⧉` copy path (`⌥⧉` copies `path:line`),
  `⌥↗` reveal in Finder / open in the user's editor, `↑ lane` switch root.
- **And the answer to "I want to change this" is the app's own answer:**
  `Ask the lane about L60 →` sends `` `src/renderer/lib/model-config.ts:60` `` plus the selected
  range into the lane's composer, through `submitQueue` exactly as the Plan tab's "Send to
  agent" does. Editing isn't missing; it is delegated to the thing that edits. That single
  affordance is what stops the surface reading as crippled.

---

## 8. States, limits, and the failure modes worth designing

The renderer is killed and respawned at ~1.1–1.2GB (the user experiences this as *"the app
restarts"*), and the chat's freeze was fixed with a memo plus a 16KB cap. A file viewer is
exactly the surface that reintroduces both, so the limits are part of the design, not tuning:

| Situation | Behaviour |
|---|---|
| **Any file** | Line list is **virtualized** — visible window + 40 lines of overscan. Highlighting runs per visible line, memoized by line text, never over the whole file up front. |
| **> 5,000 lines or > 512 KB** | Opens **plain**, no highlighting, with a sub-head note: `Large file — highlighting off`. Still fully scrollable and searchable. Never a refusal. |
| **> 8 MB** | Header + first 2,000 lines, with `Showing the first 2,000 of ~140,000 lines · Reveal in Finder ↗`. The count is the true count. |
| **Binary** | Detected by the same null-byte rule the searcher uses. `Binary file · 2.4 MB · Reveal in Finder ↗`. No hexdump — nobody asked for one. |
| **Tree** | Lazy per directory. No recursive walk on open; `.gitignore` respected via the same `ignore` crate, with a `⌥` toggle to show ignored entries (dimmed). |
| **Empty file** | `Empty file · 0 bytes` centred in the viewer, not a blank pane. |
| **Loading** | Tree: the directory row shows a `⋯` in place of its chevron. Viewer: the sub-head fills in first (path, size), the lines follow — the file's identity is known before its contents. No page spinner. |
| **No session / no worktree** | `No lane open. Files reads the worktree of the lane you're in.` with the project's main checkout offered as a root. |
| **File changed on disk while open** | The agent is *actively editing* these files, so this is the common case, not an edge one. A `↻ changed on disk` chip appears in the sub-head; the view does **not** silently re-render underneath a reader. Clicking re-reads and keeps the line. |

**Themes.** Every colour is a token: `--fg`, `--fg-muted`, `--border`, `--bg-surface`,
`--overlay-subtle`, `--accent`, the six ANSI vars, and `--add-fg`/`--del-fg`/`--add-bg` for the
change marks. No opacity stacked on `--fg-muted`. No solid accent fills — the arrival wash and
the search-hit ink are both `color-mix` against transparent. No focus rings. Verified against
**six palettes**, not four (finding #4).

---

## 9. Components and props

```
src/renderer/lib/code-nav.ts          resolveFileTarget() + parseFileHref() — pure, tested
src/renderer/lib/syntax.ts            tokenize(text, lang) → Token[] — pure, tested
src/renderer/components/files/
    FilesView.tsx        main-view mode; composes SplitPane(index=FileTree|SearchResults, detail=FileViewer)
    FilesPanel.tsx       right-panel tab; the three width forms; hosts the same FileViewer
    FileTree.tsx         lazy tree + status marks
    FileViewer.tsx       THE shared viewer — virtualized lines, gutter, arrival mark
    SearchResults.tsx    grouped hits
    Breadcrumb.tsx       path row with the ⌄ menu
```

```ts
// The one viewer, shared by both placements. Everything placement-specific is a prop.
export function FileViewer(props: {
  root: string                      // worktree or main checkout, absolute
  path: string                      // repo-relative
  /** Deep-link target. `[from, to]` for a hunk range; the wash decays, the gutter mark stays. */
  highlight?: [number, number]
  /** Density + which chrome is affordable. Drives line numbers, breadcrumb, footer. */
  form: 'wide' | 'medium' | 'narrow'
  /** Change marks from the SAME source the Diff tab uses — no second differ. */
  change?: FileChange
  onOpen(path: string, line?: number): void      // in-file links (imports), later
  onAsk(path: string, range?: [number, number]): void
}): JSX.Element
```

```ts
export function FileTree(props: {
  root: string
  /** Lazily filled; the component asks for a directory the first time it opens. */
  onExpand(dir: string): Promise<TreeEntry[]>
  changed: Record<string, FileChange>   // path → status/added/removed, from worktreeDiff
  selected?: string
  onSelect(path: string): void
  showIgnored?: boolean
}): JSX.Element
```

**Nav state** is per session, mirroring `sessionLayouts`:

```ts
type FilesNav = {
  root: 'lane' | 'project'
  path?: string
  line?: number
  range?: [number, number]
  expanded: string[]        // directories
  recent: string[]          // the ⌄ menu, capped at 10
  query?: string
}
```

Persisted in `localStorage` beside the layout, keyed by session id. `MainView` and `PanelTab`
each gain `'files'`; `DEFAULT_LAYOUT` is unchanged, so nothing opens onto Files by surprise.

**New bridge calls** (three; all read-only, all path-guarded to the session's root):

```ts
fileTree(root: string, dir: string, showIgnored?: boolean): Promise<TreeEntry[]>
fileRead(root: string, path: string, maxBytes?: number): Promise<FileContent>
   // { text, lines, bytes, truncated, binary, language }
fileSearch(root: string, query: string, opts: SearchOpts): Promise<SearchSummary>
   // streams `file-search-hit` events
```

Every one of them **must reject paths that escape `root`** after canonicalisation. This is the
only new attack surface the feature opens, it is a two-line check, and it is the kind of check
that gets added after the first bug report rather than before if it isn't written down here.

**Keyboard.** Exactly **one** new chord: `⌘⇧F` — search in Files. `lib/key-routing.ts` records a
deliberate decision that *"plain ⌘O / ⌘P have no app meaning, so they stay the terminal's"*, so
quick-open is **not** ⌘P; it is a command-palette entry (`Open file…`), reached by the ⌘K that
already exists. `⌘⇧F` follows the established shifted-navigation pattern (`⌘⇧O`, `⌘⇧P`) and
`f` is free. Inside Files: `↑`/`↓` walk search hits, `Esc` leaves a hijacked main view.

---

## 10. Build plan, in order

Each step is shippable and independently verifiable.

**S1 — `fileRead` + `FileViewer`, plain.** The Rust command with its path guard, the virtualized
line list, line numbers, the size caps, binary and empty states. No highlighting, no tree, no
placement — mounted behind a temporary palette entry.
*Verify:* open `src-tauri/src/lib.rs` (the repo's largest file), scroll to the end, watch memory;
open a PNG and get the binary state; try `../../../etc/passwd` and get refused.
**The riskiest thing in the whole feature is a big file in a renderer that dies at 1.2GB**, so it
goes first, alone, where it can be measured.

**S2 — `lib/syntax.ts` + highlighting.** Tokenizer with tests per language, the six-role mapping
onto the ANSI vars.
*Verify:* one file per grammar, screenshotted in all **six** palettes; `--yellow` and `--green`
contrast-checked on the three light ones.

**S3 — `fileTree` + `FileTree`, and the main view.** `MainView` gains `'files'`, the toolbar
gains its fourth segment, `SplitPane` composes tree + viewer. Change marks wired from the
existing `worktreeDiff` — reused, not re-derived.
*Verify:* the tree's `M` letters match the Diff tab's exactly for the same worktree; a
four-segment toolbar still fits at the narrowest usable window.

**S4 — `lib/code-nav.ts` + the panel placement.** `PanelTab` gains `'files'`, the three width
forms, and the routing rule as a tested pure function *before* anything calls it.
*Verify:* the rule's table — B and C in both directions, A's idempotence, each width veto — as
unit tests, then by hand at 460px and at 320px.

**S5 — deep links from the diff.** Hunk header and file header become link sources. The
narrowest source, and the one whose data is already exactly right.
*Verify:* click a `@@ -60,8 +60,14 @@` and land on line 60 with the range tinted.

**S6 — deep links from the transcript.** `operator://file/…` hrefs on tool-target words in the
canvas, and the branch in `CanvasConversation`'s click handler before `openExternal`.
*Verify:* a `Read src/app.ts` line opens the file; an ordinary `https://` link still opens the
browser — that regression is the one to watch, since both go through the same hit-test.

**S7 — `fileSearch`.** The `grep`/`ignore` crates, streaming hits, the results column, `⌘⇧F`,
the reported caps.
*Verify:* a query with >1,000 hits reports the cap; `node_modules` is absent by default and
present with `includeIgnored`; a search on a cold repo paints its first hits before it finishes.

**S8 — the arrival polish and the ask affordance.** Fade timing, `← Chat` / `Esc`, `Ask the lane
about L60 →` through `submitQueue`, the `↻ changed on disk` chip, task-card → diff → file.

**Not in this plan, deliberately:** editing in any form, go-to-definition or any language
service, git blame, a diff *inside* the viewer (the Diff tab is the diff), image preview, and a
draggable tree divider. Each is a defensible next feature; none of them is what a deep link
needs to land.

---

## 11. Open questions

1. **Which `target` strings actually carry a line number.** `ToolBlock.target` comes from the
   transcript summarizer; whether an `Edit` target is ever `path:line` or always a bare path is
   unverified. If it is always bare, S6 links land at line 1 — still useful, but the design's
   headline is weaker, and the fix is in `transcript.rs`, not the UI. Settle this by sampling
   real `chat.db` rows before S6, not during it.
2. **Whether the four-segment toolbar survives the narrowest window.** `Console Chat Preview
   Files` at 10px mono uppercase is ≈240px of segmented control in a band that also holds the
   title, the branch chip and the right cluster. Measure at S3; if it doesn't fit, the answer is
   to drop the *segment labels to glyphs below a threshold*, not to hide Files.
3. **Where nav state belongs when a lane's worktree is removed.** A suspended task-scoped lane
   keeps its `SavedSession` but loses its directory. Files should fall back to `root: 'project'`
   and say so, rather than showing an empty tree — but that interacts with worktree reaping and
   is worth confirming against the real lifecycle before S3.
4. **Six palettes, not four.** `CLAUDE.md` still says "4 themes: Mission Control, Mr Pink, Light,
   1984". The Light identity was removed in favour of a per-identity light/dark toggle. Worth
   correcting in `CLAUDE.md` independently of this feature — every future design brief inherits
   that sentence.
