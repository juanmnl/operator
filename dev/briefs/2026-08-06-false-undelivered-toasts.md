# False "never started the task it was sent" toasts (since v0.15.0)

**Reported by the user 2026-08-06:** a pile of stacked error toasts —
`Operator never started the task it was sent` ×4 and `Code never started the task it was sent`,
each with `It may still be sitting in its composer.` and a SHOW button. "Getting a ton of these
since the update" (v0.15.0, `e7be167`).

These toasts are actionable/sticky, so they accumulate. Five on screen at once.

## Where it comes from

- `src/renderer/views/DashboardView.tsx:1288` — `reportUndelivered()` builds the toast and marks
  the `DispatchRecord` `undelivered`.
- Fired by `submit-queue.ts` `onUndelivered` (`src/renderer/lib/submit-queue.ts:325`), installed
  via `onUndeliveredSubmission`.
- The only thing that cancels it: `submitQueue.confirm(terminalId)` from the `session:update`
  watcher (`DashboardView.tsx:429-436`), which confirms only when a **`kind:'user'` narration
  entry** matching the submitted text appears in the transcript
  (`delivery-confirm.ts` `matchSubmission`).

Timing budget for a confirmation: `RESCUE_AFTER_MS` (30s) + `CONFIRM_WINDOW_MS` (4s) ≈ **34s**,
plus the tailer's 1s poll.

## Prime hypothesis — a BUSY lane cannot confirm in time

Claude Code queues text typed into a lane that is mid-turn; the prompt only becomes a `user`
transcript entry **at the next turn boundary**. A lane working for more than ~34s therefore
produces zero user turns inside the confirmation window, and the queue declares a perfectly good
submission lost.

This matches the evidence exactly:
- The two lanes named are the two that are *always* mid-turn — the coordinator (**Operator**,
  which receives every "how your dispatch landed" note, `DashboardView.tsx:1471`) and **Code**
  (long implementation turns).
- The toast copy ("may still be sitting in its composer") is literally the correct description of
  a queued-but-not-yet-processed prompt — which is not a failure.
- `delivery-confirm.ts` explicitly rejected "the lane became busy" as a *confirm* signal (correct),
  but nothing ever taught the failure path that **busy is a reason not to declare failure yet**.

Why now: v0.15.0 added the task-scoped lane lifecycle and more automatic lane→Operator and
Operator→lane traffic, so far more messages are now typed into lanes that are already working.

## Second candidate — submission into an auto-closed pty (v0.15.0-specific)

`e3c5e2b` made lanes close themselves after a keep-warm window and resume on demand. If any path
still `submitQueue.submit(...)`s into the terminal id of a lane the reaper already closed, the
write goes to a dead pty and the message is *genuinely* lost — a true positive that needs a
different fix (route to the resume path, don't write to a dead terminal).

Both can be live at once. **Determine which fired for the actual toasts before changing anything.**

## Task

1. **Diagnose with evidence, not inference.** For the undelivered dispatches recorded in
   `~/.operator/projects.json` (`outcome: 'undelivered'`), open the receiving lane's transcript
   JSONL under `~/.claude/projects/<slug>/` and answer: *did the message eventually land as a user
   turn?* If yes → false positive (hypothesis 1). If it never landed → real loss (hypothesis 2).
   Also check whether the target terminal was alive at submit time. Report the counts.
2. **Fix what you found.** For hypothesis 1 the shape is: do not declare a submission undelivered
   while the target session is still busy/running — keep watching (the confirm watcher already
   runs on every `session:update`, so this is a matter of not *giving up*), and only report when
   the lane has gone idle without the turn appearing. Do not add a retry; the no-auto-retry rule
   in `reportUndelivered`'s comment stands. Keep the report honest in the other direction too — a
   lane that goes idle without the turn must still report.
3. **Do not silence the toast** as the fix. The mechanism must stop lying; a suppressed true
   positive is worse than the noise.
4. Unit tests in `submit-queue.test.ts` / `delivery-confirm.test.ts` covering: busy lane confirms
   late → no toast; lane goes idle without the turn → toast; dead terminal → toast.
5. `npm test` + `npx tsc --noEmit` + `npm run build` green before reporting.

## Output

Write findings + what changed to
`/Users/juanmnl/Developer/operator/dev/briefs/2026-08-06-false-undelivered-toasts-RESULT.md`
(write it to that absolute path in the MAIN repo, not only your worktree), and report via
`operator__report`. Include the diagnosis counts from step 1 — that is the part I need even if the
fix turns out to be small.
