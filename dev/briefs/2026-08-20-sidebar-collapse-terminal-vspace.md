# Brief — collapsing the sidebar leaves the terminal with wrong vertical space

**Verify and report. Change no product code.** A throwaway driver under `dev/` is fine.
Output: **`dev/briefs/2026-08-20-sidebar-collapse-terminal-vspace-RESULT.md`**.

## What the user saw (dev build, `npm run tauri dev`, 2026-08-20)

Collapsed the sidebar (⌘K → "Collapse sidebar", or the rail toggle). Two things:
1. The terminal was **slow** to take the freed width (well past the 260 ms animation).
2. Once it did, **vertical space was wrong**: Claude Code's content sits in the upper ~half of
   the pane with a large empty band below the composer, and the **top row is cut mid-line**
   (a partial row above the first full one). Columns looked right (text reaches the right edge).
   Screenshot: `/tmp/operator-shots/2026-08-20-sidebar-collapse-rows.png` (if still there).

Renderer at the time is **unknown** — could be the xterm DOM pane (`TerminalSurface` →
`TerminalPane`) or the native grid pane (`GridTerminalPane`, opt-in via
`localStorage['operator.terminal.renderer']='grid'`, binds at spawn). Reproduce on BOTH.

## Where to look (read first)

- `src/renderer/views/DashboardView.tsx` ~L377–392: `toggleSidebar` sets `sidebarAnimating` for
  320 ms; ~L4273–4300 the render site — **`suspendFit` is passed to `TerminalSurface` only; the
  grid pane gets nothing** and relies on its own 120 ms-debounced `ResizeObserver`
  (`GridTerminalPane.tsx` ~L358–363), and its `reflow` only calls `gridtermResize` when active.
- `TerminalPane.tsx` ~L110–120 `shouldFitOnResize(active, suspendFit)` and ~L628–632 "fit once
  when suspendFit → false". `src/renderer/lib/terminal-options.ts` L179–183.
- Memory on the original motivation: the 320 ms hold exists because the (now-dead) ghostty grid
  reflowed every frame → overprint. Check whether the hold is still the right shape for xterm.

## Reproduce in the harness (this is the deliverable)

Use the mock bridge (`dev/mock.html`, `dev/mock-bridge.ts`, drivers in `dev/drive-*.mjs`,
`npm run verify:visual` style, Playwright WebKit). For each renderer path:
1. Open a lane's terminal, feed enough mock output to fill the pane (the mock can fake
   `terminal:data`; for the grid path it fakes no `gridterm:update`, so measure *dimensions and
   calls*, not paint).
2. Toggle the sidebar collapsed. Sample at t = 0, 100, 260, 320, 500, 1000, 2000 ms:
   - the terminal host element's `getBoundingClientRect()` (top/height) vs the content column's;
   - xterm path: `term.rows` / `term.cols` and the `.xterm-screen` rect; whether `fit()` /
     `terminalResize` fired, when, and with what rows/cols (spy on `window.operator.terminalResize`);
   - grid path: the `gridtermResize`/`gridtermAttach` calls (args + timing) and `gridDims()`'s
     inputs (`host.clientHeight`, `cellRef.h`).
3. Decide: is the empty band **pty rows < pane rows** (a resize that was never sent, sent with
   stale height, or sent only once at the wrong moment), or is it **layout** (the host is
   positioned/sized wrong after collapse — offset under the header, height from before the
   collapse, a transform left over from the animation)? The partial top row is the tell: which
   mechanism produces it?
4. Also time "slow to take the width": when does the pane's width actually change vs when the
   first fit/resize lands? If the answer is "~320 ms and correct" in the harness, say so — then
   the slowness the user saw is specific to the real app (debug-build Rust, real pty) and the
   brief says which measurements only the user can make.

## Report shape

Verdict per renderer: mechanism + the line(s) that produce it + the smallest fix you'd propose
(do NOT apply it). Numbers from the samples. What you could not reproduce, and why.
