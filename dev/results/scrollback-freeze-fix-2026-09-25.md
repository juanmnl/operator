# Scrollback freeze fix — 2026-09-25

This fixes the freeze Review diagnosed in `dev/results/scrollback-freeze-2026-09-25.md` (report #1542), on branch `operator/d91080`, as its own commit after the roster work (f3e3318).

## The fix

`src/renderer/lib/terminal-options.ts`: a new `resyncViewport(term)`, called straight after `term.options.scrollback = scrollbackFor(active)` in `applyPaneActivation`, on both hide and show. The memory trim is unchanged: hidden panes still drop to `INACTIVE_SCROLLBACK` (2,000 lines).

It makes two calls on xterm's private viewport (`term._core._viewport`), in this order:

1. `scrollToLine(buffer.active.viewportY, true)` moves the scroll position onto the row the buffer shows, at once. That row fits inside the stale, larger scroll height. `_handleScroll` then computes a difference of 0, so no lines scroll.
2. `queueSync()` resets the scroll height from the buffer on the next frame. The position from step 1 is already valid under the new height.

It is a no-op on a terminal with no `_core._viewport`, such as the unopened terminal or the recorder in the tests. It swallows errors from a disposed terminal, like the rest of `applyPaneActivation`.

## Why the public API cannot do this

I checked each option against the installed `@xterm/xterm` 6.0.0 source:

- `Terminal.scrollToBottom()` takes no argument in 6.0. It becomes `scrollLines(ybase - ydisp)`, which is `scrollLines(0)` after the trim (`CoreBrowserTerminal.ts:895-900`).
- The public `scrollToLine(n)` is relative as well: `scrollLines(n - ydisp)` (`CoreBrowserTerminal.ts:903`).
- `resize()` to the same size returns early (`CoreBrowserTerminal.ts:1221`). A different size reaches the pty (SIGWINCH).
- The `scrollback` option change calls `BufferSet.resize` (`BufferSet.ts:34`). That fires neither `onResize` nor `onScroll`, the only events `Viewport` syncs on (`Viewport.ts:96-103`).

The private names are present unmangled in both shipped bundles, `lib/xterm.js` and `lib/xterm.mjs`: `this._viewport=`, `queueSync(e){…}` and `scrollToLine(e,t){t&&(this._latestYDisp=e),…}`. `TerminalPane.tsx:576` already reaches into `_core._renderService` the same way. An xterm upgrade that renames them turns the resync into a silent no-op, not a crash. The new tests would then fail, which is the signal.

## Why not Review's suggested `queueSync(viewportY)` alone

`queueSync(y)` stores `y` as `_latestYDisp`, and `_sync(y)` sets the scroll position only when `y !== _latestYDisp` (`Viewport.ts:160-170`). So it fixes the scroll height but never moves the position. It only works when the position happens to be clamped onto the right row.

Measured: with only `queueSync(viewportY)`, the "pane left scrolled up when hidden" test fails with the viewport at row 2000 while the buffer shows row 1500.

## Tests

The new describe block in `src/renderer/lib/terminal-activation.test.ts` runs against a real xterm opened into jsdom. The file-scoped shims are `matchMedia`, a null canvas context, and a 16 px character measurement; they are restored in `afterAll`.

1. Baseline: a 6,000-line active pane has the viewport and buffer in sync.
2. **Hide, then show, then wheel-up.** The scroll height equals the buffer length, the position equals `viewportY`, the pane opens at the bottom, and `scrollLines(-3)` (TerminalPane's wheel call) moves `viewportY` up 3. The trim still happened: the buffer is at most 2,000 + rows.
3. An ended lane that is hidden and never shown again still scrolls up.
4. A pane left scrolled up before hiding keeps its row, and the viewport agrees with it.
5. A short pane under the trim size is unchanged by a hide.

**Fails before the fix.** With the `resyncViewport(term)` call commented out, tests 2, 3 and 4 fail:

- `expected 6000 to be 2006`: stale scroll height against the buffer length.
- `expected 2000 to be 1997`: the ended lane's wheel-up did nothing.

The five existing recorder and real-xterm tests are unchanged and pass. The recorder has no `_core`, so its call sequence is the same as before.

## Verification

- `npx tsc --noEmit -p .`: exit 0. `electron/` `tsc --noEmit -p tsconfig.renderer.json`: exit 0.
- `npx vitest run`: 101 files, 1517 tests passed.
- Not verified in the running app. The next check is Review's "cheap check": in a lane with more than 2,000 lines, switch away and back while it is idle, then wheel up. It should scroll at once, with no window resize needed.

## Left out

- I did not stop trimming for same-lane Preview or for ended lanes. Review listed that as a separate direction, and the brief said to keep the trim.
- No upstream xterm.js issue was filed.
