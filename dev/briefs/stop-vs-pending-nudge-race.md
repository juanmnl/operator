# Stop is undone by the submit queue's pending nudge CR

**Follow-on from `dev/qa-chat-stop.md`.** QA proved `INTERRUPT_SEQ = '\x1b'` is correct: a single
ESC reliably interrupts Claude Code under our exact pty setup, mid-reasoning and mid-tool-call, and
the session survives. So the byte is right and the TUI is innocent. This is the bug on our side.

## The race

Two queues write to the same pty and do not know about each other:

- **`submitQueue`** (`lib/submit-queue.ts`) — on every send, writes the bracketed paste + CR, then
  **awaits `nudgeDelayFor(text)` and writes a bare `\r`**. That window is `SUBMIT_NUDGE_MS` (800ms)
  scaled by length up to `SUBMIT_NUDGE_MAX_MS` (**6000ms**). The nudge is unconditional.
- **`interruptSession`** (`lib/interrupt.ts`) — writes `\x1b` through the bridge's per-terminal
  write queue. It has no knowledge of, and no way to cancel, a scheduled nudge.

Sequence, all within the nudge window:

1. User sends. Paste + CR go out; a `\r` is scheduled for up to 6s later.
2. User clicks stop. ESC lands. Claude Code interrupts and — per QA's transcript evidence —
   **restores the draft text verbatim into the composer**.
3. The pending `\r` fires and submits that restored draft.
4. The agent starts the same work again.

To the user this is indistinguishable from "stop did nothing": the thinking signal comes back and
the turn is running. Reported verbatim as *"when i clicked stop, nothing happened."*

**This got materially worse today.** The nudge used to be a fixed 800ms; length scaling
(`nudgeDelayFor`, landed this morning) widened it to as much as 6s, so the window in which stop is
silently undone is now up to 7.5× larger. A long prompt — the common case for a dispatched task —
is the worst case.

## Fix

1. **Interrupting must cancel any pending nudge for that terminal.** `submitQueue` needs a
   per-terminal cancel, and `interruptSession` must call it before writing ESC. This is the minimum
   and it is not optional — any stop that races an armed `\r` is a coin flip.
2. **Reconsider the unconditional nudge.** It already caused the long-message split
   (`dev/briefs/submit-queue-long-message-split.md`) and now silently reverses interrupts. Both are
   the same root problem: an open-loop timer firing a CR at a TUI whose state it cannot observe.
   The closed-loop version — confirm from the transcript whether the turn actually started, and
   nudge only if it did not — fixes both at once and has been deferred twice now.
3. While fixing, check the symmetric case: a nudge armed on lane A must not be cancelled by an
   interrupt on lane B. Queues are per terminal; keep the cancel per terminal too.

## Verify

- Unit: submit a message, call interrupt inside the nudge window, assert **no** `\r` is written
  afterwards. Assert the burst-of-3 merge test and the long-message split test both stay green —
  those two pull in opposite directions and this adds a third constraint.
- Test at both ends of the window: an 80-char message (800ms) and a 4000-char one (6000ms).
- Live confirmation needs a human: send a long prompt, click stop inside the window, confirm the
  agent stays stopped and the restored draft is **not** resubmitted.

## Credit where it is due

QA's harness is what made this findable — the detail that unlocked it was their observation that an
interrupt *restores the draft text into the composer*. Without that, a stray `\r` looks harmless.
