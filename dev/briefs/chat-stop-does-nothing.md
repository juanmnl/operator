# Chat: stop button does nothing

**Reported:** 2026-07-28, live app. *"after sending a command, i can see the thinking signal, but
when i clicked stop, nothing happened."* The thinking signal itself works — this is only the
interrupt.

**Deliverable: `dev/qa-chat-stop.md`.** Report findings there; do not fix.

## What is already ruled out (do not re-derive)

- **The terminal id is valid.** `ChatComposer`'s `send` (`:142-153`) and the stop action
  (`:277`) both use `session?.terminalId`. Sending works — the user saw the thinking signal — so
  the id resolves to a live pty and writes land on it.
- **The byte is correct.** `lib/interrupt.ts` writes `INTERRUPT_SEQ = '\x1b'`; the bridge chains it
  through the per-terminal write queue into `terminal_write`, which does `data.into_bytes()` →
  a single `0x1B`. No base64 on the write path (base64 is the read/output transport only).
- **Nothing intercepts Escape.** `lib/key-routing.ts` has no Escape handling, and `TerminalPane` does
  not special-case it.
- **The button state is right** — `busy = !!signal?.interruptible && live`, and `chatSignal` returns
  `interruptible: true` for `running`/`compacting`. The user saw the stop glyph, so this evaluated
  true.
- **There is no prior art.** `git log -S` finds no earlier ESC-to-pty write anywhere in
  `src/renderer`. This interrupt shipped today and has never been exercised against a live agent.

## The experiment that isolates it — do this first

**Type ESC directly into Operator's own terminal surface for a running agent.** Claude Code's own
footer advertises `esc to interrupt`, and xterm's ESC key emits the identical `'\x1b'` through the
identical `terminalWrite` path.

- **If typed ESC interrupts but the button does not** → the difference is in the write path or its
  timing, not the byte. Instrument `terminal_write` and confirm the `0x1B` actually reaches the pty
  when the button is clicked.
- **If typed ESC also does not interrupt** → the problem is how Claude Code reads input under this
  pty, and the button is innocent. Note we launch with `--settings {"tui":"default"}`.

That single test splits the search space in half for almost no effort. Do it before anything else.

## Hypotheses, in order — test, do not assume

1. **A lone ESC is ambiguous.** Node/Ink input parsers treat `0x1B` as a possible escape-sequence
   prefix and may wait on a disambiguation timer, or absorb it if other bytes follow closely. Try:
   ESC twice; ESC with a deliberate gap before/after any other write; ESC when the write queue is
   otherwise idle.
2. **Input state during a tool call.** The agent may not be reading keys the same way mid-tool as it
   is while reasoning. Test interrupting during a long `Bash` call vs during plain reasoning — the
   `chatSignal` label tells you which state you are in.
3. **The write lands but is swallowed on redraw.** The 1Hz terminal heal loop and heavy output
   redraw are both in play. Test with a quiet agent vs one streaming output.

## Constraints

- **Interrupt is never a kill.** ESC hands the turn back and the session survives.
  **NEVER pattern-kill processes** — that rule is absolute here.
- Whatever sequence proves correct must stay in `lib/interrupt.ts`'s `INTERRUPT_SEQ`, which exists
  precisely so the composer and the transcript status line cannot diverge.
- Report the winning sequence with the evidence that it worked, not a plausible-looking guess. This
  bug exists because a reasonable-looking sequence was shipped untested.
