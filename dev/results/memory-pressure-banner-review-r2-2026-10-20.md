# Memory-pressure banner — review, round 2

Date: 2026-10-20. Reviewer: Review lane. Target: branch `operator/897500`, diff `3a17a2f..c8d50f5` (one commit, 7 files), Design's "Round 2" notes in `dev/results/memory-pressure-banner-2026-10-16.md`. Round 1: `dev/results/memory-pressure-banner-review-2026-10-20.md`. Line numbers are at `c8d50f5`. I did not run the tests; Design reports 1942 root and 992 electron tests passing.

Every round-1 finding in scope is fixed. One new Low defect, in the 60 s debounce.

## New finding

### R2-1 (Low). Debouncing a drop from critical keeps the automatic pass running for up to a minute after memory has recovered

`electron/src/main/memory-pressure.ts:115-121`, `src/renderer/views/DashboardView.tsx:4490`.

`take()` holds the reported level for `NORMAL_CONFIRM_MS` whenever a read of 1 follows a reported level above 1. That includes a reported 4. If a read jumps from 4 to 1, which 5 s sampling can see, main goes on reporting 4 for 60 s. The renderer's critical effect keeps its 30 s interval, so one or two more uncapped `'now'` passes run while the kernel already says normal. Any lane that finished a turn in that minute is suspended at once. The notes give the cost of the debounce as "the banner stays up for about a minute". These extra passes are not mentioned there. A read of 2 during the hold is handled correctly: it is reported at once and stops the passes. Only the 4→1 jump is affected.

Fix direction: while a drop from 4 is being confirmed, report 2. The banner stays up and does not resize, and the automatic pass stops. Then confirm 2→1 as now.

## Round-1 findings, re-checked

- **M1: fixed.** `suspendPlanned` (`src/renderer/lib/idle-suspend.ts:205`) re-reads ports for each planned lane and runs the full `suspendDecision` on `fresh()` before the suspend starts. The same `eligible` closure is passed into `suspendLane` and folded into `stillIdle` (`DashboardView.tsx:4141-4143`). `runSuspend` calls `stillIdle` before and after the report IPC. From the second call to `markSuspended` the code is synchronous, so the full decision runs immediately before the kill. `fresh()` → `suspendCandidate(tab, Date.now(), false)` (`:4332`) is rebuilt from refs on every call. It includes `heldDeliveriesFor(project?.dispatches, …)` from the current `projectsRef` (`:4349`) and `laneGateRef.current.busy(tab.key)` (`:4357`). It also includes retiring, restarting, both launch maps, release, background tasks, subagents, phase, focus, unsent input, pending submission and awaiting delivery. The gate is safe to include in the re-check: `suspendLane` takes its own hold only in `markSuspended`, which comes after the last `stillIdle`, so the lane never refuses itself. `suspending=false` in the re-check excludes only the lane's own `suspendingRef` entry. A second suspend of the same lane is still refused at the top of `suspendLane`. `devServer` comes from the port read at the start of the step and is not read again between report and kill. That window is one IPC round trip.
- **Step timing out while `st.suspend` is already running** (the coordinator's question). `gaveUp` is checked only after `readDevServer`, so a step capped during `st.suspend` keeps going after the pass moves on. I followed it through and found no defect. The orphaned suspend still runs `stillIdle`, with the full fresh decision, before and after its report. A suspend already in its kill has passed its last check, and no later state change could undo that. While it runs, `suspendingRef` holds the lane, so later passes plan it as in flight (`suspending=true` in planning) and `suspendLane` refuses a second suspend. The lock is released when the pass ends, and the orphan does not need it: what the lock prevented was two passes judging from the same snapshot. One side effect: an orphan that does succeed is not counted in `n`, so the banner's "Suspended N" can undercount by one per timed-out step. Cosmetic.
- **L1: fixed.** Main reports a drop to 1 only after 60 s of normal reads at the 5 s cadence (the held level keeps `next` at `ELEVATED_POLL_MS`). The reducer keeps a dismissal across a drop and a rise to 2 within 5 min. A rise to 4 always shows the banner. A failed read during the hold neither resets nor completes it.
- **Renderer reload during the debounce** (the coordinator's question): it gets the correct level. `this.last` is updated only when a reading is reported, so `current()` returns the level still held, the same one the previous renderer was showing. The confirming read then pushes 1 through `onMemoryPressure` to the new renderer. A dismissal does not survive a reload, because the reducer state lives in renderer memory. That was already true in round 1.
- **L2: fixed.** Planning and each step are raced against `SUSPEND_STEP_CAP_MS`, and a skip is logged. A step that throws is logged, and the pass continues. A late port read starts nothing (`if (gaveUp) return false`, `idle-suspend.ts:213`). The lock can no longer be held by one hung call. The worst case is now bounded: 20 s per planned lane.
- **L3: fixed.** `pressurePendingRef` counts passes. Busy clears only when the count reaches 0, and the critical interval skips while a pass is pending.
- **L4: fixed.** The button passes `pressureEligible` as `limit`. The plan is sliced quietest first, and the re-check can only lower the number.
- **L5: fixed.** The first failure is logged with its error, unparseable output counts as a failure, recovery is logged with the count, and the retry comment matches the code.
- **I2: fixed.** `start()` calls `stop()`, and a run counter makes a poll from an earlier run return without scheduling another.
- **L6: unchanged,** declared out of scope in the notes. Automatic passes still run without any notice while the banner is dismissed at 4.

## Recommendation (for the coordinator)

R2-1 is small (Design or Code, a few lines in `take()` plus a test). Nothing else blocks merge. QA's "with lanes running" checks are still owed, including M1 against a real background task.
