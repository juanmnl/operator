# Fix: prompt box not visible after switching to a lane (+ scrollback note)

Research result: `dev/results/scrollback-and-missing-input-RESULT.md` (read it first).

## Confirmed causes
1. `src/renderer/components/terminal/TerminalPane.tsx` activation effect (~645–685) never calls
   `term.scrollToBottom()`. A reactivated pane whose viewport drifted stays scrolled above the
   fold, and the prompt row is the last line, so it is what disappears.
2. Ordering: the background buffer (`bgBufferRef`) is flushed BEFORE `fit()`, so stale-width
   content is written and then reflowed, and Claude Code's `resize` redraw arrives afterwards.

## Task
- Do fix 1: after the bg flush and after `fit()`, call `term.scrollToBottom()` right before
  `term.refresh(...)`. Also scroll to bottom after a flush that happens while the pane is active
  if such a path exists.
- Do fix 2: reorder to `fit()` (and the pty resize it triggers) BEFORE the bg-buffer flush. Keep
  the trim (`scrollbackFor`) where it is. Read the comments there; they call the current order
  deliberate — find out why (git blame) and state in the result whether the reason still holds.
  If it does not, reorder; if it does, say so and ship fix 1 alone.
- Tests: renderer unit test for the activation sequence (order of scrollback set → fit → flush →
  scrollToBottom → refresh → focus) using the existing terminal mocks; `npm test` green, tsc clean.
- Scrollback (#1): NO code change. The root cause is Claude Code's windowed repaint. Add one line
  to the `INACTIVE_SCROLLBACK` comment in `terminal-options.ts` pointing at the research result.
- Merge to main and push (authorised). No tag/release. Trailer:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Output
`dev/results/pane-activation-scroll-RESULT.md` (what changed, blame finding on the order, test
tail, merge hash), then `mcp__operator__report`.
