# Two live terminal defects after long sessions (research, read-only)

Reported 2026-09-11 by the user, in the installed Electron 0.21.0 app:
1. "A lot of times, after long sessions, I can't scroll back, not even a little bit."
2. "When I navigate to an agent session, sometimes there's no input visible" (Claude Code's
   prompt box is not on screen after switching to that lane).

## What the coordinator already established (verify, don't trust)
- Terminal = xterm.js DOM renderer, `src/renderer/components/terminal/TerminalPane.tsx`.
  Scrollback policy in `src/renderer/lib/terminal-options.ts`: ACTIVE 10,000 / INACTIVE 2,000
  lines, applied on every switch (`term.options.scrollback = scrollbackFor(active)`, ~line 660).
  Lowering the option trims history immediately and it never comes back.
- Inactive panes do not render; pty bytes accumulate in `bgBufferRef` with a 512KB cap, flushed on
  activation. Inactive panes keep a stale size (resize guard: only the active pane fits/resizes).
- Claude Code 2.1.268's renderer: `clearTerminal` frames have reasons `clear` and `offscreen`.
  Non-alt-screen clear = cursor home + (erase-line + cursor-down) × viewportRows, i.e. an
  in-place repaint, NO `ESC[3J`. `ESC[2J ESC[3J` (erase scrollback) is written ONLY on the alt
  screen. `offscreen` fires when the frame's height exceeds the viewport rows: Claude Code then
  repaints a window of its own frame in place, so lines never scroll off into xterm's scrollback.
  Hypothesis for #1: after a long turn the frame is taller than the viewport, Claude Code manages
  its own scrolling, and xterm's scrollback is empty or only a few lines. Hypothesis for #2: the
  pane was resized/trimmed while inactive and the prompt box is painted below the visible rows, or
  the bgBuffer cap dropped the frame containing it.

## Task
Read-only. Reproduce or refute each hypothesis with evidence:
- For #1: capture a long-session pty stream (backend keeps `terminalHistory`) and count
  `clearTerminal` repaints vs. lines that reached scrollback. Check `buffer.active.length`
  vs `rows` on an affected pane via `terminal-registry.ts`. Determine whether the loss is
  Claude Code's in-place repaint, Operator's INACTIVE trim, the bgBuffer cap, or the alt screen.
- For #2: reproduce by switching away from a lane, letting it run a long turn, switching back.
  Check whether the pty size the lane believes differs from the pane's real size at activation,
  and whether the fit/resize on activation happens BEFORE or AFTER the bgBuffer flush.
- Name the smallest fix for each with the file and function, and what it would cost.

Constraints: no code changes, no installs, no killing processes, never per-pid lsof (TCC).
Output: `dev/results/scrollback-and-missing-input-RESULT.md`, then `mcp__operator__report`.
