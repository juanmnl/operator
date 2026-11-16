# Review round 2: suspend idle lanes (operator/b0b440, 376b23b..7aebaa9)

Reviewer: Review lane, 2026-10-16. Scope: `git diff 376b23b..7aebaa9` (12 files, +711/−109). I also read
the code each fix depends on: `submit-queue.ts` (when `pending` is set), `terminals.ts` `kill`/`reapAndForget`
(how long a kill takes), the lifecycle tick's close branches, and the sentinel and bus reply records.
Round 1: `dev/results/suspend-idle-lanes-review-2026-10-16.md`. Code's round-2 notes:
`dev/results/suspend-idle-lanes-2026-10-16.md` § Round 2. QA D1: `dev/results/suspend-idle-lanes-qa-2026-10-16.md`.

Code's worktree has been removed, so I extracted 7aebaa9 with `git archive` into my scratchpad and ran the root
suite there: 119 files, 1842 tests passed, the same count Code reports. I did not run the electron suite,
because no electron file changed in this round. Nothing was run in the app.

Line numbers are on 7aebaa9.

## Verdict

All the round-1 findings in scope are fixed or reduced to what Code documented, with one exception: L4 is only
partly fixed. The fixes add two new defects worth fixing before merge. Both are races, and both are cheap to close:
- **N1 (Medium):** a message that arrives while the kill is running is typed into the dying CLI and lost.
- **N2 (Medium):** the new close of a suspended lane has no guard against a resume starting during the close.

The rest are Low.

---

## Round-1 findings: status

| Finding | Status | What I checked |
|---|---|---|
| H1 resumed lane re-suspended at once | **Fixed** | `quietFor` takes `spawnedAt` (`idle-suspend.ts`), and the tick passes `spawnedAtRef` for every pty Operator started in this run: launch, restart, resume. Messages waiting on readiness are now counted. `submitWhenReady` raises `awaitingReadyRef` before `whenLaneReady` and lowers it only when `submitQueue.submit` resolves, and that promise resolves after the confirmation polling ends. The count therefore covers the whole stretch before `pending` is set, which happens only at the write, after the gap sleep. Both the tick and `stillIdle` read the count. One residual: N6. |
| H2 suspended lane never closed | **Fixed, same as a live lane** | `laneCloseDecision` sends suspended lanes to `suspendedCloseDecision`, which checks the quiet clock against `quietMs`. The coordinator, focus, open-work and auto-close-off guards still apply first. The clock is `quietSince`, persisted as the row's `lastActiveAt`, so it survives a relaunch. `closedLaneRow` clears `idleSuspendedAt` in the same write that stamps `suspendedAt`, which ends the reaper claim and stops the restore at the next launch. `openWork` falls back to `resumeSessionId` for the session match. Residual: with auto-close off, suspended lanes still never close. That follows the user's setting and matches live lanes, so it is not a defect. Correction to my round 1: "tasks stay running instead of becoming abandoned" was wrong. `openWork > 0` blocks the backstop for live lanes as well, so a closable lane has no running tasks to mark. |
| M1 project close skipped suspended lanes | **Fixed** | `closePlan` now includes `status === 'ended' && suspended`, and the rail session carries `terminalId` and `suspended`. `closeProject` calls the user close path, which forgets the row and removes the worktree after a WIP snapshot. `wasDead` reads a suspended lane as done, not stuck. `isOnRail` counts `activity.suspended`, and "N running" still reads `live`. |
| M2 resume-on-launch started suspended lanes, duplicate key | **Fixed** | Resume-on-launch passes `skipSuspended` and `skipKeys` (main's list). `suspendedRowsToRestore` skips keys that have a tab, keys being restored, keys live at the end of the last run, and duplicate rows. The `terminalsRef` append now filters by key as well. A manual "Resume project" still resumes suspended lanes, which is intended. |
| M3 failed resume lost the message, tasks completed | **Fixed, with Low gaps** (N4, N5) | Spawn failure on the sentinel or bus reply now gets `reportUndelivered(…, 'resume')`, and the bus path logs a `sent` record (with `replyId`) so there is a record to flip. A resume that spawns and then exits on its own: `resumeWatchRef` is set synchronously after `spawnInPlace`, before any exit event can arrive. It is cleared once a session update shows a record newer than the spawn. On a failed resume, `exitCompleteRef` skips task completion and reports the carried message. Both the event path and the reconcile path pass `selfExit`. |
| M4 second CLI during suspend | **Fixed** (but see N1) | `runSuspend` re-checks, reports, re-checks, sets the exit guard, kills, and only then marks the tab. Routing cannot see a suspended tab before the kill, so no resume can start next to the live CLI. `resumeSuspended` no longer deletes the old id from `restartedFromRef`. `suspendingRef` joins `inFlight`, so the tick cannot start a second suspend of the same lane. |
| L4 keys at the overlay discarded | **Partly fixed** (N3) | Keys are held and resumed after a 150 ms pause. The fix misses keys in the last burst and can scramble the order. |
| L5 fan index on relaunch | **Fixed** | `SavedSession.fanIndex` is persisted, and `placeholderTab`, `handleRestoreSession` and the cold `handleLaunchSession` resume (`count === 1`) all pass it to `laneBusName` and to the tab. |
| QA D1 suspended lane not on the rail | **Fixed** | `ProjectRail.liveOf` keeps `ended && suspended` sessions. The "+" menu no longer offers to start a suspended role. The new render test fails on 376b23b and passes here. |

---

## New defects

### N1 (Medium). A message routed during the kill is typed into the dying CLI and lost

`src/renderer/lib/idle-suspend.ts` `runSuspend`; `DashboardView.tsx` `suspendLane`.

After the second `stillIdle()`, `runSuspend` sets the exit guard and awaits `kill()`, and only after that calls
`markSuspended()`. `terminals.kill` is not instant. `reapAndForget` first takes a fresh `ps` snapshot, then signals
the process tree and waits, with escalation, before it resolves (`electron/src/main/terminals.ts:481-520`). That is
hundreds of milliseconds at the least, and several seconds if anything ignores SIGTERM. For that whole time the tab
is an ordinary live lane, by design ("until then it is a live lane, a message routed to it is typed into it"), and
nothing re-checks after the kill.

Failure scenario:
1. The tick decides to suspend Code. Both re-checks pass and the kill starts.
2. The coordinator dispatches to Code 200 ms later. `routeDispatch` sees a live tab and takes the `send` route.
   `submitWhenReady` passes `whenLaneReady` at once, because the lane is old, so the paste and the CR are
   written to the pty while it is being reaped.
3. The kill resolves and the tab is marked suspended. The exit guard makes the exit handler call only
   `submitQueue.busy(id, false)`. After `CONFIRM_WINDOW_MS` the queue reports the submission undelivered. The
   record turns `undelivered` and the toast says "Code never started the task it was sent. It may still be
   sitting in its composer". That is untrue: the lane is suspended and the composer no longer exists.
4. The task is recovered only if the user clicks Retry on the card.

Round 1's M4 race (a second CLI) was worse, so the reordering was the right call. It does move the loss into the
kill window. Possible fixes:
- Mark the lane "suspending" for routing, so a message in that window waits on the kill and then goes through
  the wake with that message.
- After the kill, take any submission that is pending or waiting for readiness on the old id and re-deliver it
  through `wakeLaneRef`.

No test covers a message arriving between the second re-check and `markSuspended`. The "order of one suspend"
tests only cover messages that arrive before the second re-check.

### N2 (Medium). The suspended-lane close has no guard against a resume that starts during it

`DashboardView.tsx`, the lifecycle tick's non-released branch: `void handleCloseSessionRef.current(session, reason)`.

The released-lane branch just above it adds the lane to `retiringRef` for the length of the close (review
round 2, R2-5): "a dispatch arriving during the close routes as if the lane were gone". The new suspended-lane
close goes through the plain branch, which has no guard.

`handleCloseSession` awaits `pendingReleases()` and then `terminalKill(<placeholder or dead id>)` before it drops
the tab with `setTerminals(filter)`. During those two IPC calls a dispatch, a reply, a focus or a rail click can
call `wakeLaneRef` on the suspended tab, and `resumeSuspended` starts. Two outcomes follow:
- **The spawn finishes after the close has removed the tab.** `spawnInPlace` calls `replaceTab(prev, tab.id,
  next)` on a list that no longer holds `tab.id`. The new `claude` process then has no tab: it is invisible and
  cannot be closed from the UI. That is the memory leak this feature exists to remove. Meanwhile
  `handleCloseSession` goes on to snapshot and remove the worktree directory that this CLI is running in.
- **The spawn finishes first.** The close still removes the worktree under the resumed lane (the removal is
  chained on `finishTasks`), and it stamps the row `suspendedAt` while the lane runs.

The window is short: two IPC round trips, on a tick that runs every 30 s. The consequence is bad, though, and the
fix has a precedent two lines above it: add the id to `retiringRef` (or a dedicated set that `wakeLaneRef` and
`withActivity` respect) until the close settles. Alternatively, re-check in `wakeLaneRef` that no close is in
flight for the key.

### N3 (Low). L4 fix: keys typed in the last burst are lost, and the held text can land out of order

`SuspendedOverlay` and `typeHeldKeys` in `DashboardView.tsx`.

- **Lost keys.** `onResume(held)` fires only after a 150 ms pause in typing. When the resume completes, which is
  usually started by focus before the first key, `spawnInPlace` clears `idleSuspendedAt`, the overlay unmounts,
  and its cleanup clears the timer. Keys typed after the last pause are never handed over. A user who opens a
  suspended lane and types steadily loses everything since their last pause, or the whole line if they never
  paused.
- **Out of order.** `typeHeldKeys` writes the held text only after `whenLaneReady`, which is at least 4 s after the
  spawn. The new pane is live and focused before then, so anything typed directly into it lands first and the
  held text is appended after it.
- **Merged with a dispatch.** `typeHeldKeys` writes with `terminalWrite`, outside the submit queue's per-terminal
  chain. If a dispatch joined the same resume, both wait on the same ready promise. When the held text goes in
  first, the dispatch's paste and CR submit the user's unsent text together with the task. The notes say "nothing
  is submitted that the person has not seen". A dispatch landing on a live lane with a draft has the same merge
  problem today, but this path creates the draft itself.

Possible fixes: flush the held text from the overlay's unmount cleanup, and write it through the submit queue's
chain (`clearComposer`/`typed` are chained) instead of a raw write.

### N4 (Low). A failed resume of a dispatched lane leaves the dispatch's task `running`

When a dispatch wakes a lane (`handleLaunchRole` → wake), the launch path's `trackOrQueue(tab)` calls `addRunning`
on the resumed tab. If that resume then fails in the `failedResume` sense, `exitCompleteRef` deliberately completes
nothing, so the new task stays `running` against a dead lane. Meanwhile `reportUndelivered` turns the record
`undelivered`, so the board shows a running task and an undelivered card for the same work. Retry then delivers it
again (a cold launch, because the tab is no longer suspended) and leaves the first task behind. The stale-running
reconciler may clean it up later; I did not trace that.

Code's notes already cover the other false positive, a lane that exits on its own within 60 s for a legitimate
reason such as `/exit` typed at once.

### N5 (Low). Reply records after a failed resume

- **Sentinel reply, long text.** `record('sent')` stores `task: r.text`. The text submitted, and the text passed to
  `reportUndelivered`, is `replyPrefix + decision.text`. When `decision.truncated` is set the two differ,
  `text.endsWith(d.task)` fails, and the record stays `sent`. The toast still shows.
- **Bus reply records.** A bus reply record turned `undelivered` carries `replyId`, so the board hides it and it
  cannot be dismissed there. `heldDeliveriesFor` still counts it, because it filters on outcome and role, not on
  `replyId`. That lane can then not be suspended for 24 hours. This errs toward keeping the lane up, so it is not
  harmful, but it explains a lane that never suspends.

### N6 (Low). The H1 fix does not survive a renderer reload

`spawnedAtRef` lives in the renderer. After a watchdog respawn or ⌘R, every reattached lane has no `spawnedAt` and
is judged by its transcript time again. A lane resumed by focus a few minutes before a reload, with no message, is
suspended on the first tick after the reload if it is not focused. Main knows each pty's start time and could
supply it with `terminalList`.

### Also checked in the new code, clean

- **Report and re-check ordering in `runSuspend`.** A message routed during `report(true)` is typed into the live
  lane. `submitWhenReady` raises the count synchronously, so the second `stillIdle()` sees it, and a cancel removes
  the lane from main's record again. A cancel and a failed kill both clear the exit guard.
- **A crash between report and kill.** Main ignores a suspended key whose pty is still alive (`recompute`), so crash
  auto-resume picks that lane up as a live one. That is the safe outcome.
- **Reports overwriting each other.** The terminals-change effect can re-report the list without the lane while the
  kill runs. This only matters if the app crashes in that window, and then the lane is auto-resumed (it was still
  live), which is fine.
- **`failedResume` clock.** `spawnedAt` is stamped after `terminalSpawn` returns, before the CLI can have written
  anything. The old transcript's records, which the new track reads in, all predate it, so `tookTurnSince` does not
  clear the watch on the old history.
- **Restored rows.** `placeholderTab` with `migrateEffort` applied by the view, and `suspendedRowsToRestore`
  deduplicating by key.
- **The `ProjectActivity.suspended` field** is filled at every construction site I found, including the rail's
  fallback object. Code reports that typecheck passes.

## Recommendation for the coordinator

Send N1 and N2 back to Code. Both are small: an in-flight marker that routing and `wakeLaneRef` respect, plus moving
messages waiting on the old id through the wake after the kill. The N3 flush-on-unmount is a few lines and can go
in the same round. N4–N6 can wait. After that, QA's remaining GUI list plus Code's round-2 additions applies, in an
isolated `OPERATOR_DIR`.
