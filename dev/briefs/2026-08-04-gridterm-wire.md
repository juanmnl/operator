# Wire the orphaned grid terminal back in, behind an opt-in pref, so it can be soak-tested

## Context

Terminal research v2 (`dev/briefs/2026-08-04-terminal-research-v2-RESULT.md` — read it first)
concluded: do NOT flip WebGL or canvas back on (the atlas bug is an xterm.js-wide problem under
Claude-Code-shaped redraw, hits Chromium too, unfixed on the stable channel; canvas was removed in
xterm 6). The recommendation instead is to revive what this repo already built and orphaned:

- `src-tauri/src/gridterm.rs` (406 lines) — pty bytes parsed by `alacritty_terminal = "0.25"` into a
  run-length-encoded themed cell diff, emitted as `gridterm:update`. Grid authority lives OUTSIDE
  the webview, so no escape sequences reach a webview buffer to desync.
- `src/renderer/components/terminal/GridTerminalPane.tsx` (479 lines) — paints that snapshot as
  plain DOM rows, rAF-coalesced. Already has scrollback via alacritty's `display_offset`,
  drag-select + ⌘C, click-to-open-URL, live theme remapping, and a headless xterm used ONLY as a key
  encoder.
- All five commands exist in `lib.rs` (`gridterm_attach/resize/scroll/set_theme/detach`) and eight
  bridge functions in `operator-bridge.ts`.
- `cargo check` passes clean. **Nothing imports `GridTerminalPane`** — the only hit in
  `src/renderer/` is its own export line.

## The exact missing wire

`terminal_spawn` in `lib.rs:633` accepts `grid: Option<bool>` and only calls `gridterm::create(...)`
when it is true. **`operator-bridge.ts:81-93` never passes `grid` at all**, so it is always `None`
→ the grid is never created. The comment at `operator-bridge.ts:59-62` already promises the
behaviour — *"force fullscreen when grid is on; otherwise honour the user's tui pref"* — but the
flag it describes is not in the `invoke` payload. The intent was written; the wire was not.

## Build this

1. **A pref**, alongside `getTuiMode()` in `src/renderer/lib/terminal-options.ts` — e.g.
   `getRendererMode(): 'xterm' | 'grid'`, persisted like the existing tui pref. **Default `xterm`.**
   This is an opt-in escape hatch for a soak test, not a new product surface.
2. **Pass it at spawn**: bridge sends `grid: true` when the pref is `grid`, and — per the comment
   already there — sends `tuiMode: 'fullscreen'` in that case regardless of the tui pref, since the
   whole point of the grid path is that it parses alt-screen correctly.
3. **Mount the pane**: where `SessionView` renders `TerminalSurface`, render `GridTerminalPane`
   instead for sessions spawned in grid mode. Handle the lifecycle properly —
   `gridtermAttach(id, cols, rows)` on mount, `gridtermResize` on pane resize, `gridtermSetTheme` on
   theme change, `gridtermDetach` on unmount.
4. **Per-session, not global.** The grid is created at spawn, so the pref binds at spawn time and an
   already-running session cannot switch. Record the mode on the session so a reload mounts the
   right pane; do not let a pref change mid-flight mount the wrong renderer over a live pty.

## Also find out: why was it shelved?

`git log --follow` on both files. It was built 2026-06-30 and superseded two days later by the WebGL
retry (2026-07-02, reverted 07-05). Research found no doc or memory recording that grid was tried
and failed. If the history shows a real defect, say so plainly — that changes the recommendation and
is worth more than the wiring.

## Constraints

- **Do not remove, bypass or regress `TerminalSurface`.** It stays the default and the fallback.
- Do not "fix" gridterm's rendering while wiring it. If it looks wrong, report it — the point of
  this pass is to make it reachable so it can be judged, not to polish it blind.
- House rules: no browser focus rings, colours via CSS vars only, never a colour-changing border on
  a radiused element (WKWebView freeze), never recede with group `opacity`.
- There is a standing rule "do NOT reintroduce a renderer toggle without a soak test" — this pref
  EXISTS to make the soak test possible, defaults off, and is not to be promoted to a user-facing
  setting in this pass.

## Verify

- Pref off: behaviour byte-identical to today. `npm test` green, `npm run build` clean,
  `cargo check` clean.
- Pref on, new session: `GridTerminalPane` mounts, text appears, typing works, the pane resizes with
  the window, theme switches remap colours, wheel scrolls, drag-select + ⌘C copies.
- Confirm `tui:fullscreen` is actually what reaches the spawn argv in grid mode.
- Report honestly what does NOT work — this is an unproven path and a clean report is the deliverable.

**The real test is a long live session and is the user's to run** — hours, sustained output, many
tool calls. Do not claim the corruption class is fixed; a short clean run is exactly the false
negative that burned this project in July.

## Output

Write `/Users/juanmnl/.operator/worktrees/operator-3b4cb8/dev/briefs/2026-08-04-gridterm-wire-RESULT.md`
(absolute path): what you wired, how to turn it on, what worked, what didn't, and what `git log` says
about why it was abandoned.
