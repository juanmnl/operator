# Scrollback freezes on long sessions — most likely cause (2026-09-25)

Read-only, from source. `@xterm/xterm` 6.0.0 (`node_modules/@xterm/xterm/src`), Operator at `65ffdd2`.
Not reproduced live. Companion to `scrollback-long-sessions-2026-09-25.md`.

## Answer

**The inactive-pane scrollback trim desynchronises xterm 6's scroll viewport from the buffer. After
that, wheel-up moves an invisible scroll position through thousands of lines of empty track before the
content moves.** It happens only once a pane holds more than about 2,000 lines, which is why it shows up
only on long sessions. It clears itself only when the lane prints a new line, and an idle lane you went
back to read does not print anything.

## Mechanism, step by step

1. **A pane stops being active and its history is trimmed.** This happens on a lane switch, on opening
   Preview on the same lane, or when the lane ends. `applyPaneActivation` sets
   `term.options.scrollback = 2_000` (`src/renderer/lib/terminal-options.ts:198`, value `:158`).
2. **xterm trims the buffer without telling the viewport.** The `scrollback` option change calls
   `BufferSet.resize` (`xterm/src/common/buffer/BufferSet.ts:34`). `Buffer.resize` trims lines and lowers
   `ybase` and `ydisp` by the same amount (`Buffer.ts:225-232`).
   - It does not fire `BufferService.onResize` or `onScroll`. Those are the only events that re-sync the
     scroll viewport (`browser/Viewport.ts:96-103`, and `CoreBrowserTerminal.ts:535-541`).
   - Nothing else listens to `'scrollback'` (a search of xterm's `src` finds only `BufferSet.ts:34` and
     `OptionsService.ts:184`).
   - So the `SmoothScrollableElement` keeps the old `scrollHeight` (≈ 10,000 + rows lines) and the old
     `scrollTop` (the old bottom, ≈ row 10,000), while the buffer is now ≈ 2,000 + rows lines with
     `ydisp = ybase ≈ 2,000`.
3. **On re-activation, the scroll-to-bottom does not move the viewport.** `settle()` calls
   `term.scrollToBottom()` with no argument (`terminal-options.ts:211`). In xterm 6 that becomes
   `scrollLines(ybase - ydisp)` = `scrollLines(0)` (`CoreBrowserTerminal.ts:895-900`), which is
   `viewport.scrollLines(0)` = "stay at the current scrollTop" (`Viewport.ts:108-114`). The stale scrollTop
   at about row 10,000 survives. Setting scrollback back to 10,000 only raises `maxLength` and fires nothing.
   The `fit()` after the flush re-syncs only if the grid size changed. DashboardView's own comment says it
   usually does not (`DashboardView.tsx:5386-5388`).
4. **Wheel-up then does nothing.** This applies to Operator's wheel handler (`TerminalPane.tsx:554-563`,
   `t.scrollLines`) and to xterm's native wheel path alike. Both move the scrollable position:
   - The position goes from row ≈ 9,997 to ≈ 9,994.
   - `_handleScroll` computes `diff = newRow − ydisp ≈ +7,994` (`Viewport.ts:185-189`).
   - `BufferService.scrollLines(+7,994)` clamps to `ybase` and returns with no change (`BufferService.ts:131-148`).

   To reach content, the user has to wheel through about 8,000 lines of dead track. With Operator's
   24 px per line (`TerminalPane.tsx:558`), that is about 190,000 px. To the user, it will not scroll.
5. **What clears it.** The next linefeed at the bottom row fires `onScroll` → `_sync`, which resets
   `scrollHeight` and the position (`BufferService.ts:121`, `Viewport.ts:150-173`). A grid resize also
   works. An idle lane, in a finished turn or waiting at the prompt, emits no new lines, so the freeze lasts.

**Ended lanes are the worst case.** `active` requires `!t.ended` (`DashboardView.tsx:5380,5389`), so an
ended lane is trimmed and never goes through `settle()` again. Its pane is still shown
(`pane-visibility.ts:21-24` does not check `ended`), and it never prints another line. If its history
passed about 2,000 lines, its scrollback stays frozen for good.

## How to confirm

In the app (the menu has `toggleDevTools`, `electron/src/main/app-menu.ts:30`):

1. **The cheap check, no tools needed.** Take a long lane, switch away and back while it is idle, and try
   to scroll up. If it is frozen, resize the window by a few pixels (anything that changes cols/rows) or
   make the lane print a line. If scrolling comes back at once, this is the cause.
2. **The exact check.** In DevTools, on the frozen pane's xterm (reach it through React devtools, or
   temporarily expose `getTerminal` from `lib/terminal-registry.ts`):
   ```js
   const c = term._core, v = c._viewport._scrollableElement, h = c._renderService.dimensions.css.cell.height
   ;[v.getScrollDimensions().scrollHeight / h, term.buffer.active.length,   // stale ≈10k+rows vs ≈2k+rows
     v.getScrollPosition().scrollTop / h,  term.buffer.active.viewportY]    // ≈10k vs ≈2k
   ```
   A frozen pane shows the two pairs thousands of lines apart. A healthy pane shows them equal.
3. **Headless repro.** Extend `dev/drive-scrollback-trim.mjs`, which already fills 6,000 lines and trims:
   - after the trim, set `scrollback = 10000`
   - call `term.scrollToBottom()`
   - then `term.scrollLines(-3)` and assert that `buffer.active.viewportY` decreased

   Predicted: it does not change.

## Other candidates checked, and why they rank lower

- **Alternate screen has no scrollback** (`BufferSet.ts`, alt buffer). This is real, but it is a mode, not
  a freeze that appears "past some point". In fullscreen lanes Claude takes the wheel through mouse
  reports, and Operator's handler steps aside when `buffer.active.type !== 'normal'` (`TerminalPane.tsx:557`).
  It would present from the start of the session, not after it grows long.
- **Stuck mouse tracking eating the wheel.** Classic-mode captures contain no `?1000h`
  (`scripts/width-audit/claude-turn.bin`), so mouse tracking is normally off and xterm scrolls natively.
  When it is on in the normal buffer, Operator's handler scrolls through the same viewport path, so it has
  the same trim problem and adds no separate one.
- **Scrollback full at 10,000 lines with the viewport pinned.** xterm keeps `ybase` fixed and decrements
  `ydisp` while the user is scrolled up (`BufferService.ts:93-106`), then fires `onScroll` and re-syncs. It
  stays consistent, and I found no freeze path.
- **Main-thread starvation.** The 180 ms repaint and 1 s `rebuildLayer` (`TerminalPane.tsx:434-470,480-484`)
  run only while output is recent, and they refresh the rows without moving the viewport. That would make
  scrolling slow, not stopped, and it would not depend on session length.
- **Operator's own handler.** `Math.round(lines) || ±1` always yields a non-zero step
  (`TerminalPane.tsx:558-559`). It does not create the dead zone; it only makes it longer to cross.

## Fix directions (not implemented)

- **Re-sync the viewport after every `scrollback` change.** The public API cannot do it:
  - `Terminal.scrollToBottom()` takes no argument in 6.0 (`typings/xterm.d.ts:1227`, `browser/public/Terminal.ts:217`)
    and always takes the relative path.
  - `scrollLines` is relative to the stale position.
  - A real `resize` would send a SIGWINCH to Claude.

  The narrow option is the private call `(term as any)._core._viewport.queueSync(term.buffer.active.viewportY)`
  straight after `term.options.scrollback = …` in `applyPaneActivation`. `TerminalPane.tsx` already reaches
  into `_core._renderService` the same way (`:576`). The next frame's `_sync` then resets `scrollHeight`
  and clamps `scrollTop`.
- **Stop trimming where it is not needed**: Preview on the same lane, and ended lanes (see the companion report).
  This removes the most common case and the permanent one, whatever else is done.
- **Upstream**: xterm.js `Viewport` should re-sync when the `scrollback` option shrinks the buffer
  (`BufferSet.ts:34` resizes without any event the viewport listens to). Worth an issue.
