# Side panel and rail collapse/expand: layout-shift redesign (2026-09-25, Design lane)

Branch `operator/57440`. Covers both collapsible surfaces: the left rail (`ProjectRail`, toggled by
`SidebarToggle` / ⌘B) and the right side panel (Plan / Diff / Preview, `CanvasPanel`).

## How it was measured

Two rigs. First the Vite renderer's mock harness (`dev/mock.html`) in Playwright's Chromium, the
same engine as the Electron shell, which gives the full theme/width matrix. Then the real Electron
dev app, running this branch with a live Claude Code lane, driven over CDP (section "Electron,
real pty" below), which is where the pty and TUI numbers that matter come from. The two disagree
on one baseline fact, the panel's refit timing, and Electron is the one to trust. Probe: `dev/drive-panel-collapse-shift.mjs` (committed). For each toggle it records
700ms of frames from the moment of the key/click and reports:

- how many frames the content card's width and left edge changed on;
- how many frames the terminal element's width changed on (its subtree being re-laid out);
- how many rail text leaves changed position or width between frames (re-truncation, re-centring,
  a right-aligned status sliding with the edge);
- every pty resize the renderer sent (`terminalResize`), with its time after the toggle;
- Chromium's `LayoutCount` / `LayoutDuration` across the toggle.

Baseline = `git archive HEAD` (65ffdd2) served on the same port with the same probe. Matrix:
dark and light (`mission-control-dark` / `-light`), 1440×900 and 1000×900, and 1440 with
`prefers-reduced-motion: reduce`. Screenshots mid-transition were checked by eye in both themes.

## Before (HEAD 65ffdd2), 1440×900, dark

Light theme gives the same counts (±1 frame). 1000px gives the same counts with different column numbers.

| Toggle | Card width changed on | Terminal element width changed on | Rail text leaves moved | pty resizes (ms after toggle) | Layouts / layout time |
|---|---|---|---|---|---|
| Rail collapse | 15 frames | 15 frames | 2 | 1 (145→170 cols) @ 330 | 24 / 8ms |
| Rail expand | 15 frames | 15 frames | 14 | 1 (170→145) @ 330 | 23 / 8ms |
| Panel open | 1 frame (−468px hard cut) | 1 | 0 | 1 (145→85) @ 35, same frame | 10 / 10ms |
| Panel close | 1 frame (+468px hard cut) | 1 | 0 | 1 (85→145) @ 14, same frame | 5 / 3ms |

What moved, in words:

- **Rail.** The strip animated `width` 264↔70 over 260ms, and the content card, a flex sibling,
  was re-laid out on every frame together with its whole subtree, the terminal panes included. The
  terminal's cols were already held (`sidebarAnimating` → `suspendFit`), so the text did not rewrap
  per frame, but the element resized on all 15 frames and refit once at ~330ms (a 320ms guess
  timer). Inside the rail, `collapsed` flipped at t=0, so the collapsed layout was drawn into a strip
  still 264 wide: the group headers re-centred as it narrowed (2 leaves). On expand, the 14 name and
  status leaves re-truncated and the right-aligned status column slid with the edge on every frame.
- **Panel.** No animation. The panel mounted or unmounted in one frame and the card jumped by the
  panel's width (468px). In the harness the terminal refit in that same frame. In Electron, with a
  live lane, opening was **two separate jumps**: the card at 12ms and the terminal refit at 182ms,
  because the fit waits for pty output to go quiet. Either way the card, the toolbar chips, the
  footer, the terminal text and the main-view Preview all changed without any transition. The panel's contents, including a Preview iframe, were unmounted
  on every close and rebuilt on every open.
- **Reduced motion** was ignored: the rail animated identically with `prefers-reduced-motion: reduce`.
- **Other terminals.** The scratch shell (`ShellSheet`) did not get `suspendFit`, so when it was
  open it refit and resized its pty on every frame of ⌘B. Grid panes (`GridTerminalPane`) have their
  own ResizeObserver with no hold, so the active one resized on every frame too. The mock does not
  exercise either one.

## After, same matrix

| Toggle | Card width changed on | Terminal element width changed on | Rail text leaves moved | pty resizes (ms after toggle) | Layouts / layout time |
|---|---|---|---|---|---|
| Rail collapse | 15 frames (animated) | 0 | 0 | 1 @ 311 | 25 / 7ms |
| Rail expand | 15 frames (animated) | 1 (at settle) | 0 | 1 @ 310 | 24 / 6ms |
| Panel open | 14 frames, 62→278ms | 1 (at settle) | 0 | 1 @ 353 | 26 / 10ms |
| Panel close | 15 frames, 32→266ms | 1 (at settle) | 0 | 1 @ 308 | 23 / 5ms |
| Reduced motion, any toggle | 1 step | 1 | 0 | 1 @ 10–36 | 5–39 / 3–8ms |

Light and 1000px match within ±1 frame. The panel-open start varies from 46 to 80ms across runs:
that is the mount, followed by the two-frame hold described below.

- The terminal element no longer resizes during a move. Every toggle sends **exactly one pty
  resize, after the edge has stopped**. The Claude Code TUI still redraws once at the new width;
  that is the cost of the terminal getting wider or narrower at all (see "Why not an overlay").
- The rail's own text does not move or re-truncate during either transition (14 → 0 on expand,
  2 → 0 on collapse).
- The panel now slides in and out over 260ms instead of cutting. Its contents are laid out once at
  their final width and do not rewrap: 0 panel text blocks changed height, and the surface's width
  changed only once (when it mounted) while its left edge moved on 15–16 frames.
- Total layout time per toggle is unchanged or lower (8→6–7ms for the rail). The panel does more
  layout passes than the hard cut (27 vs 10) because the card's box now animates, but they cost the
  same total time (~10ms over the whole move) because the terminal stack is out of the per-frame
  layout.
- Reduced motion is honoured: one step, one refit.

## What changed and why

1. **`src/renderer/lib/layout-motion.ts` (new).** One definition of a layout move: duration and
   curve (the rail's existing 260ms `cubic-bezier(0.4, 0, 0.2, 1)`, now shared with the panel),
   `layoutTransition()` (returns `none` under reduced motion), `pinWidth()`, and
   `useReducedMotion()`, which moved here from `StatusWave` so both users share it. There are no
   motion tokens in `styles.css`, so the TS constants are the single source of truth.
2. **Heavy content is pinned for the whole move** (`DashboardView`). The terminal panes and the
   main-view Preview now sit in one absolutely positioned layer inside the stack. While a move runs,
   that layer is held at `pinW`, the wider of the move's two widths: a narrowing move keeps its
   start width, and a widening move takes its end width at once. The moving edge therefore only
   covers or uncovers finished content and never exposes an empty strip. The layer resizes once, and
   every terminal (lane panes and the scratch shell) holds its fit until the move settles. A
   reversal mid-move keeps a pin that covers both endpoints (unit-tested in `layout-motion.test.ts`).
3. **The card's box still animates.** A transform on the card was the alternative, and it breaks
   the right-anchored chrome. The toolbar chips, the panel toggle and the footer reading would either
   jump off-screen at t=0 and slide back in, or pop at the end. Letting the card's width follow the
   edge keeps those two short rows attached to it. Once the heavy layer was pinned, the per-frame
   layout was only those rows, which is where the unchanged layout time comes from.
4. **Rail: the strip clips, the column inside has a fixed width** (`ProjectRail`). The strip's
   width still animates. The column inside is laid out once at the width of the state it is going
   to (70 or 264) and anchored left, so no row re-truncates, re-centres or slides during the move.
5. **Panel: `SidePanelSlot` (new, `components/session/SidePanelSlot.tsx`).** The slot is the flex
   item whose width animates, and it owns the row's 8px gap (`marginLeft: -gap`), so an empty slot
   costs the row nothing. The surface inside keeps the panel's width and is anchored to the slot's
   inner edge one gap in, so it slides in behind the card's edge with the gap intact and its tabs
   first. I tried anchoring it to the window edge first; the edge then uncovered it from the right,
   so line endings showed before the tabs and the gap only opened at the end. The panel stays
   mounted through its close animation, and the Preview stays in it while it slides out (keyed on
   the tab, not on `previewInPanel`, which turns false at the moment the close starts).
6. **Settling is two steps.** Releasing the pin and lifting the fit hold in one render made
   the pane fit twice: once from its ResizeObserver, once from its own settle effect. The two fits
   landed one column apart because xterm measures its scrollbar per fit. The harness can't show
   this; Electron did, on every rail expand (986→790px, then 790→798px 16ms later). Now the pin
   is released first, while the hold is still on, and the hold lifts two frames later, after the
   ResizeObserver has delivered. Electron now shows one fit per toggle.
7. **The panel's animation clock starts after the mount has painted.** Mounting the panel is one
   long task (~150ms in the harness). A Web Animation created inside it had used most of its 260ms
   before the first frame, so the panel still opened with a single 370px jump. Playing it on the
   first `requestAnimationFrame` didn't fix that, because that callback runs inside the late frame,
   whose timeline time predates the long task. It is now held at its first keyframe and played two
   frames later. The slot then reports `onMoveStart`, and the settle timer restarts from that point,
   so the terminals are never released to refit while the edge is still moving.
8. **Only a user's toggle animates.** ⌘B, the toolbar button and the three palette commands
   (`Side panel: Plan / Diff / Preview`, now routed through one `setPanelOpen`) animate. A lane
   switch that changes the panel state stays instant, because the incoming pane fits on activation
   and a slot still moving under it would make that fit land at a mid-move width.
9. **The Preview's native inspect view is hidden during a move.** It is placed by the stage's rect,
   and a stage that slides without resizing does not re-place it. It already had a hide/show path
   that re-places it at the current rect when it shows (R1), and the move now uses that path.
10. **`ShellSheet` takes `suspendFit`**, so the scratch shell stops resizing its pty on every frame of ⌘B.

Tokens: nothing new is hardcoded. The surfaces keep `--bg-terminal` / `--radius-lg`, and the only
new number, `ROW_GAP = 8`, names the root row's existing gap, which the row itself now reads.

## Why not an overlay

The brief suggested animating an overlay rather than width. For the moving part, that is what
happens now: the panel surface and the rail column are fixed-width layers that the edge clips.
Both panels still push the content when they settle, and that is deliberate. An overlay that stays
open would hide the terminal's right-hand (or left-hand) columns for as long as the panel is open,
and Claude Code wraps its prose at the pty width, so those columns would hold text you cannot read.
The terminal has to change width once, and the redesign makes it happen exactly once, after the
motion.

## Checks

- `npx tsc --noEmit -p .`: clean. `npx vitest run`: 102 files, 1500 tests pass (includes the new
  `layout-motion.test.ts`).
- Light and dark, 1440 and 1000, reduced motion: the matrix above; mid-transition screenshots
  checked by eye in both themes.
- `dev/drive-rail-invariant.mjs` reports 5 failures, and the identical 5 fail on the HEAD export
  without this change (accent-collision fixture, 41.75 vs 43 axis, foot glyph spread, rhythm). That
  drift predates this work and nothing here adds to it.
- Project Home during ⌘B: 0 of its 13 text blocks changed size in the mock, so the non-session
  modes were left as they are.

## Electron, real pty (this branch vs 65ffdd2, same instance)

A second Electron dev instance ran this branch (`electron/ npm run dev`, isolated `OPERATOR_DIR`
in the scratchpad, renderer on 1431, CDP on 9345; QA's 9340 instance was not touched). The window
was 1100×720 at dpr 2, dark theme. One scratch project held one Research (Sonnet) lane, left at
Claude Code's folder-trust prompt: a live TUI that rewraps on SIGWINCH and makes no model calls. For
the baseline, the four changed renderer files were checked out at 65ffdd2 in the same instance and
the same lane re-measured, then restored. Probe: `dev/drive-panel-collapse-shift.mjs` with
`CDP=http://127.0.0.1:9345`. Here the bridge is a Proxy over a frozen native object, so fits are
read from xterm: `.xterm-screen` changes width exactly when a fit changes the column count.

| Toggle | Before: terminal width Δ / fits | After: terminal width Δ / fits | Rail leaves moved (before → after) |
|---|---|---|---|
| Rail collapse | 15 frames / 1 fit @ 340ms | 0–1 / 1 fit @ 343–353ms | 1 → 0 |
| Rail expand | 15 frames / 1 fit @ 330ms | 1 (at settle) / 1 fit @ 343–344ms | 8 → 0–1 |
| Panel open | card cut @ 12ms, 1 fit @ 182ms | card animates 43→280ms, 1 fit @ 381ms | 0 → 0 |
| Panel close | card cut @ 10ms, 1 fit @ 27ms | card animates 27→279ms, 1 fit @ 344–346ms | 0 → 0 |
| Reduced motion | rail still animated 15 frames, fits @ 337–343ms | 1 step, 1 fit @ 17–32ms | — |

After the settle fix (item 6 above), frame pacing during the panel close was a steady ~17ms over two
runs. An earlier run, taken just after a Vite reload, painted only 8 frames and did not reproduce.
Layout totals are the same order before and after (5–10ms per toggle). The one rail leaf that
moved in one of two after-runs (0 in the other) is most likely a live label changing its text; it
was not identified.
Redraw activity before the fit in the TUI numbers is xterm's cursor blink.

## Not verified, and follow-ups

- **Electron coverage is dark theme at one window size.** Light and 1000px were covered in the
  harness only. Nothing in this change touches colour, so theme cannot change the counts. A real
  Claude Code session mid-stream was not measured: the lane sat at the trust prompt.
- **Narrow windows (existing, unchanged):** at 1000px with the rail expanded, the 460px panel leaves
  the card 244px and the terminal 29 columns. Nothing clamps the panel against a minimum terminal
  width. Worth a rule: the panel yields before the terminal drops below some column count.
- **Entering a session from the gallery** expands the rail (the gallery forces it collapsed)
  without going through a layout move, so there is no fit hold during that one animation. It could
  be driven off a change in the rail's effective width instead of the ⌘B handler.
- Grid terminal panes and the scratch shell are not in the mock fixture, so their single resize is
  argued from the code (both sit behind the pin or `suspendFit`), not measured.

