# RESULT — the composer-clear primitive

The follow-up named in `2026-08-06-undelivered-retry-and-open-lane-RESULT.md`: Retry re-delivered a
whole message, and if the stale paste was still in the composer the lane read the task twice.

`npm test` **647** (+5) · build clean.

## What it is

`clearComposerSequence(lines)` in `lib/submit-queue.ts` — a pure function, so the bytes are
assertable — plus `submitQueue.clearComposer(id, lines)`, which queues it on the **same
per-terminal chain** as `submit`. Chained rather than written directly: a clear that overtook a
queued submission would clear the wrong text.

    \x05  Ctrl+E  to end of line    — so the kill is not cursor-dependent
    \x15  Ctrl+U  delete to start   — the line is now empty
    \x7f  DEL     backspace         — at column 0, joins to the line above

repeated per line, walking a multi-line paste upward.

## The two properties that let it ship

**Safe when unbound.** These go into a live agent's pty. All three are no-ops on an empty
composer, none submits, and none can interrupt a turn or end a session — which rules out what a
person reaches for first: `Esc` interrupts a running turn, `Ctrl+C` twice exits the lane, `Ctrl+D`
exits on an empty line. A test asserts the sequence contains none of those and *only* the three
intended bytes. A clear that fails to clear is recoverable; one that kills a lane is not.

**Bounded by what we pasted.** The caller passes the line count of the message it sent, capped at
`MAX_CLEAR_LINES` (200). Anything a human typed beyond that survives — deliberately: eating input
nobody asked us to touch is worse than an incomplete clear. A test proves a wrong line count
cannot flood a pty.

## ⚠ What is NOT verified, and how to settle it

**The TUI's actual response is unverified.** I tried to establish Claude Code's real binding and
could not: its composer is Ink-based with its own key handling, and the keybinding table embedded
in the shipped binary is **Node's REPL**, not the composer — `Ctrl+D — Exit if line empty` gives it
away. I nearly reported that table as authoritative; it would have been wrong.

So these are the readline conventions, and the safe-when-unbound property is what makes shipping
them acceptable before the check rather than after. Verified on the wire: a Retry now writes
`\x05\x15` and *then* the bracketed paste, to the same terminal, in that order.

**To settle it in one action:** open a lane, paste a couple of lines into its composer without
submitting, and click Retry on a stranded card for that lane. Either the composer is empty before
the new text arrives (bound, works), or the lane receives the task twice (unbound — and then the
answer is to find the real binding, not to change these bytes). Multi-line is the case most likely
to be partial.

## Not done

- **No feedback when the clear doesn't clear.** Nothing observes the composer, so a failed clear is
  silent and shows up as the duplication it was meant to prevent.
- **Only Retry uses it.** Normal dispatch delivery is untouched — it targets composers that are
  empty by construction, and adding keystrokes to the healthy path to fix a recovery path would be
  the wrong trade.
