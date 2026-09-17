# Terminal corruption in hidden panes: BG_CAP trim removed (2026-09-16)

Branch: `operator/230fc0` (worktree `~/.operator/worktrees/operator-230fc0`), uncommitted.

## Finding

`src/renderer/components/terminal/TerminalPane.tsx` held output for hidden panes in `bgBufferRef`
(added in eafc0e6, because several background panes rendering at once overloaded WKWebView). Once
the held total passed `BG_CAP = 512_000`, it dropped the OLDEST whole chunks. Pty chunk boundaries
do not respect escape sequences, so the first surviving chunk could start mid-sequence. That matches
the mantel lane screenshot: `;239mconst dark = ...` printed literally, the head `ESC[38;5` having
been in a dropped chunk. Dropped chunks also removed cursor moves and line clears, so Claude Code's
later relative redraws (cursor-up + rewrite) landed on the wrong rows, which reads as hanging text
and a vanished input line. Any pane that stayed hidden long enough to produce more than ~512KB of
output was affected on activation.

## Change

- New `src/renderer/lib/hidden-output.ts`: `createHiddenOutputBuffer(cap, write)` with `push` and
  `take`. `push` appends; when the held total reaches `cap`, it writes everything held, in order, to
  xterm while the pane is still hidden, then clears. Nothing is ever discarded.
- `TerminalPane.tsx`: `bgBufferRef` now holds that buffer (created once per component, writing to
  `termRef.current`). `BG_CAP` moved to module scope. The hidden branch of `writeLive` calls `push`;
  `flushBg` and the activation hook's `takeHiddenOutput` call `take`. The trim loop and
  `bgBufferLenRef` are gone.

Why this option: it is the smallest change that keeps the original performance reason. A hidden
pane still does no xterm work for the first 512KB of output, and afterwards at most one write per
512KB, instead of one per chunk. The other option (stop buffering past the cap) would switch a busy
hidden pane to per-chunk writes, which is the load eafc0e6 removed.

The logic was moved into a lib module so it can be unit-tested without mounting xterm.

## Test

`src/renderer/lib/hidden-output.test.ts`:
- Builds >3x cap of pty-like output (`ESC[38;5;239m...`, cursor-up, line-clear), cuts it into
  chunks of 1 to 65,536 chars so escapes are split across boundaries (asserted), pushes it through
  the hidden path, then takes the remainder as activation does. Asserts the cap was hit while
  hidden and that the concatenation of everything written equals the produced stream exactly.
- Output below the cap is held without writing and returned intact by `take`.

## Results

- `tsc --noEmit -p .`: exit 0.
- `vitest run src/renderer`: 82 files, 1249 tests passed, 0 failed.
- Run with `node_modules` symlinked from the main checkout (the worktree had none); symlink removed.

## Not done

- Not GUI-verified.
- `stripOrnaments` still runs per chunk, so an ornament split across two chunks would pass through
  unstripped. Separate issue, not touched.
- Not committed.
