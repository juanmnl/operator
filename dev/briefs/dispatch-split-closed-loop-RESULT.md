# Dispatch delivery: closing the loop — RESULT

**Status: built, typechecked, unit-tested, driven end-to-end. `tsc` clean, 466 tests pass.**

> ⚠ **`dev/briefs/dispatch-split-closed-loop.md` does not exist** — the fourth missing brief in a
> row. I stopped and asked rather than guessing a fourth time; you chose **full delivery
> confirmation**, which is option 2c of the real brief `submit-queue-long-message-split.md` ("watch
> the transcript for the turn actually starting and only re-nudge if it did not… the only
> closed-loop option"). Its two cheaper alternatives were already shipped, and
> `SUBMIT_NUDGE_MAX_MS`'s own comment already named this as what it was standing in for.

## The change in one line

The watchdog CR is no longer fired on a timer's opinion — it is fired only when the transcript
shows the message **did not** become a turn, and a message that never becomes one is reported
instead of vanishing.

| File | |
|---|---|
| `src/renderer/lib/delivery-confirm.ts` | **new** — what counts as delivery, pure |
| `src/renderer/lib/delivery-confirm.test.ts` | **new** — 16 tests |
| `src/renderer/lib/submit-queue.ts` | `confirm()`, `pending()`, `idle()`, `onUndelivered` |
| `src/renderer/lib/submit-queue.test.ts` | +12 tests (15 → 27) |
| `src/renderer/views/DashboardView.tsx` | the watcher, and the `undelivered` report |
| `src/shared/types.ts` | `DispatchRecord.outcome` gains `'undelivered'` |
| `src/renderer/lib/project-channel.ts` | its chip: **`sent · never started`** |
| `dev/mock-bridge.ts` | `__mockUserTurn` — the harness could not produce a user turn |
| `dev/drive-dispatch-loop.mjs` | **new** — drives the loop |

## How delivery is decided

The signal is the transcript's own **user turns** (`transcript.rs` `apply_user` pushes every real
human prompt as `NarrationEntry { kind: 'user' }`). Every indirect proxy I considered is wrong in
the same way — a dispatch routinely goes to a lane that is **already running**, so anything based
on the lane being busy confirms a message still sitting in the composer:

| candidate | why not |
|---|---|
| phase became `running` | true on arrival for a busy lane |
| `lastActivityAt` advanced | continuously true while a lane works |
| composer emptied | not observable — Operator reads a transcript, not a TUI |
| **a user turn matching what we sent** | ✅ what actually happened |

Matching the **content** also gets the split for free: a turn holding a strict *prefix* of what we
sent is not delivery, it is precisely the reported artifact, and it is reported as `split` — which
deliberately does **not** confirm. Letting it through would have reported the broken half as a
success and left the tail stranded exactly as before.

Three rules that took care to get right, all tested:

- **The tailer truncates** a recorded prompt at 4000 chars and appends `…`. Demanding equality
  would call every long dispatch a failure — so a truncated turn matches, but only when what we
  sent was actually past the cap (otherwise a genuinely split message ending in an ellipsis would
  pass as delivered).
- **The window.** `userTurnsSince` only considers turns at or after the write time, because
  dispatching the same sentence twice is ordinary — matching the whole tail would confirm the
  second send using the **first** send's turn as proof.
- **A short prefix is not a split.** A one-word turn (`yes`) that happens to open our message is a
  different prompt; calling it a broken delivery would cry wolf.

## What happens now, in order

1. paste goes out → the queue records what it is awaiting;
2. wait `nudgeDelayFor(text)` (unchanged);
3. **confirmed → no CR at all.** This is the fix: the CR is a keystroke, and a keystroke against an
   already-committed paste is what halved the 900-char dispatch;
4. not confirmed → the rescue CR fires, exactly as before;
5. one confirmation window later, still nothing → `DispatchRecord` flips `sent` → **`undelivered`**,
   and a toast says so with a **Show** action onto the lane.

**It never retries.** A dispatch that re-sends itself unattended is how the same work gets done
twice. There is also no second CR — each extra keystroke is another chance to split something.

## A regression I introduced and caught

The first version awaited the confirmation window **inside** the per-terminal chain, so every
submission held its lane for an extra 4s and a burst — the thing the coordinator's charter
explicitly encourages — crawled out four seconds apart. `dev/drive-dispatch.mjs`'s existing length
sweep caught it (writes landing outside their observation window). The window now runs **detached**;
the chain still ends at the CR. Pinned by *"does NOT hold the terminal for the confirmation
window"*, and `idle()` exists so tests can await a verdict that no longer blocks anything.

## Verification

- `npx tsc --noEmit` clean · `npm test` **466 passed / 43 files** (438 → 466, +28).
- The pre-existing `FakeTui` model — which reproduces the original split — now also runs with the
  loop closed: **one whole turn, nothing stranded, nothing reported lost.**
- `node dev/drive-dispatch-loop.mjs`, all five groups:
  1. confirmed 900-char dispatch → `["paste"]`, **rescue CR skipped**
  2. unconfirmed → `["paste","CR"]`, rescue intact
  3. exactly **1** CR, outcome flips to `undelivered`, toast *"Code never started the task it was sent"*
  4. channel chips: `["delivered", "sent · never started"]` — the log stops lying
  5. a **prefix-only** turn does not confirm; the rescue still fires
- `node dev/drive-dispatch.mjs` — length sweep green again at 200/500/1000/2000/4000, one paste +
  one nudge each, whole message intact, delay scaling 1101 → 6001ms.
- Screenshots: `/tmp/operator-shots/dispatch-undelivered.png`, `dispatch-loop-channel.png`.

## Worth knowing

- **`sent` is no longer final.** `types.ts` said "nothing reclassifies them, because a `sent`
  record means it already went" — which is exactly how a dispatch that never arrived kept reading
  as a success. That comment is corrected; `sent → undelivered` is the one reclassification.
- **The harness could not previously produce a user turn** (`__mockAppend` only made assistant
  text), so no driver could ever watch a message *arrive*. That gap is why this half went
  unverified for so long.
- **The confirmation window is 4s** and the report is one-shot per submission. If real lanes turn
  out to commit slower than that under load, raising `CONFIRM_WINDOW_MS` is the only knob — it
  affects when we *report*, never when we send.

## Deliberately left out

- **No re-delivery.** Explicitly your call above; the report is manual-recovery only.
- **No queued/pending-approval coverage.** Only submissions that actually reach a pty are watched;
  a `queued` or `pending-approval` dispatch was never typed anywhere and already says so.
- **Not theme-passed** — the new chip reuses the existing `warn` tone and the toast is the existing
  component.

## Still parked (from the previous task)

`dev/briefs/plan-usage-stale.md` — code complete and green in the tree (staleness thresholds,
revalidate on focus/popover-open, visible-only tick, stale ⇒ the meter stops asserting a
percentage), but still owed its unit tests, driver, and `plan-usage-stale-RESULT.md`.
