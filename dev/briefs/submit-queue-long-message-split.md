# Dispatch bug: long messages get split, tail strands in the composer

**Reported:** 2026-07-28, live session. Screenshot: `/tmp/operator-shots/2026-07-28-input-hang.png`
**Severity:** P0 for the product — dispatch delivery is the core loop, and this silently loses
half of every long task.

## The observed failure

A ~900-character single-line dispatch was sent to a live lane. Claude Code's composer was left
holding the **tail** of it as an uncommitted draft:

```
❯ |
  fixed, so do not treat whole-turn-copy as a constraint.
```

That string is the verbatim end of the dispatched line. The prefix (everything up to
`…text selection WILL be`) had been submitted as its own turn. So one dispatch became one
truncated turn plus one stranded draft — and the lane received a brief that stops mid-sentence.

Note the composer's first line is EMPTY with the cursor on it, and the stranded text sits on the
second line. Whatever the mechanism, a newline is landing ahead of the leftover. Explain that
detail — don't hand-wave it. It is the sharpest clue available.

## What is already known (don't re-derive)

* `src/renderer/lib/submit-queue.ts` writes `ESC[200~ <text> ESC[201~ \r`, spaces submissions to
  the same terminal by `SUBMIT_GAP_MS = 350`, then fires an **unconditional bare `\r` at
  `SUBMIT_NUDGE_MS = 800`**.
* That nudge exists to fix the OPPOSITE bug: a swallowed CR stranding a draft. Its own comment
  concedes one caveat (a human typing during the window) but never considers the case where
  **the paste itself has not finished being ingested at 800ms**.
* The queue was measured and tuned with SHORT strings (`"Reply with exactly: ALPHA"`). Long
  messages were never in the test set. This is the gap.
* **Not a chunking bug.** `write-queue.ts` uses `maxChunk = 4096`, so a 900-char message is a
  single chunk, and per-terminal write ordering is already guaranteed and unit-tested.
* Byte ORDER is not in question. The race is inside Claude Code's TUI, between async paste
  ingestion and a CR that arrives on a fixed timer.

## What to do

1. **Reproduce it first, at length.** Extend `dev/drive-dispatch.mjs` with a length sweep —
   200 / 500 / 1000 / 2000 / 4000 chars — and find the threshold where a single dispatch stops
   arriving as exactly one turn. A fix without a failing repro is a guess.
2. **Then fix it.** Some directions, in rough order of preference — but pick on evidence, not on
   this ordering:
   * Make the nudge **conditional** rather than unconditional: only fire the CR if the message
     has not already been committed. Requires knowing whether it committed → see (3).
   * **Scale the nudge delay with message length** (a floor plus a per-KB term). Cheapest fix,
     but still open-loop and still guessing at the TUI's pace.
   * **Delivery confirmation** — watch the transcript for the turn actually starting and only
     re-nudge if it did not. This is the long-deferred "dispatch delivery-confirmation" item and
     is the only closed-loop option. It is also the most work.
3. Whatever you build, add a regression test to `submit-queue.test.ts` covering a long message,
   and keep the existing 3-burst merge test green — the old failure must not come back. The two
   failure modes pull in opposite directions and a fix for one can silently reintroduce the other.

## Constraint

The working tree currently has ~1600 uncommitted lines across three unrelated features
(project-first navigation, settings `PageShell`, toolbar/composer polish). It is green —
`tsc --noEmit` clean, 200 tests pass. Keep this fix surgical and confined to the submit path so
it can be committed on its own.
