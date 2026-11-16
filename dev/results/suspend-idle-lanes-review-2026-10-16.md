# Review: suspend idle lanes (branch `operator/b0b440` @ 376b23b vs main 68fb94d)

Reviewer: Review lane, 2026-10-16. Scope: `git diff main...operator/b0b440` (28 files, +1534/−101), read
in Code's worktree `~/.operator/worktrees/operator-b0b440` (clean, at 376b23b), plus the surrounding
code each change touches (dispatch routing, lane-lifecycle, closeProject, launch restore, terminals.kill,
transcript tracker, worktree reaper). Brief: `dev/results/_scratch/suspend-idle-lanes-brief-2026-10-16.md`.
Code's notes: `dev/results/suspend-idle-lanes-2026-10-16.md`.

I re-ran the new and touched unit tests in the worktree: root `idle-suspend`, `dispatch-bus` and `dispatch`
tests passed (134), and electron `last-run`, `transcript-background` and `worktree-cleanup-gaps` tests
passed (83). I did not run the full suites, and I ran nothing in the app.

Line numbers are on the branch.

## Summary

Two High findings. (1) A lane resumed without a message (by focus, the resume card, project resume)
becomes eligible to be suspended again on the next tick, because "quiet" is measured from the
transcript's last record and the resume writes none. (2) Suspension stops the existing task-scoped
"went quiet" close from ever running for that lane, and nothing clears `idleSuspendedAt` except a
resume or a manual close. Lanes, rows and worktree claims build up without limit.
Four Medium findings cover project close, resume-on-launch, replies lost when a resume fails, and a
suspend/resume race. The LaneWaker ordering, the bus reply wake, the last-run round trip and the
`--resume <id> -- <text>` command line are sound; see "Checked and clean".

---

## High

### H1. A lane resumed without a message is suspended again within about a minute of losing focus

`src/renderer/lib/idle-suspend.ts:72` (`quietFor`) and the tick at `src/renderer/views/DashboardView.tsx:4027-4073`.

`quietFor` is the minimum of the transcript age (`session.lastActivityAt`, which is the timestamp of the
last JSONL record, `electron/src/main/transcript.ts:409-412`) and the age of the last keystroke. A
`--resume <id>` with no prompt writes no record. I checked 600 recent transcripts on this machine: the
first record after a gap of more than 30 minutes was always a prompt, queue-operation, compaction, or
occasionally `pr-link`/`bridge_status`, and never a resume marker. Neither the spawn time
(`spawnedAtRef`, which the branch already records) nor the resume time feeds the decision.

Failure scenario:
1. Code lane X has been suspended for 2 hours. The user clicks it in the rail. The focus effect
   (`:4080`) resumes it. The new pty's track reads the transcript, so its phase is `idle` and
   `lastActivityAt` is 2 hours old.
2. The user reads the output, makes no keystroke, and clicks lane Y.
3. On the next 60-second tick X is not focused, has phase `idle` and is quiet for "2 h". Port check
   finds no server. X is suspended again.
   The same applies to `handleRestoreSession` on a suspended tab (resume card, "Continue") and to
   `handleResumeProject` (`:3610`). With `background: true`, every lane resumed this way is killed
   again at two per minute. Each one costs a full CLI and MCP start for nothing.

Escalation to a lost message: a message to a lane resumed this way waits in `whenLaneReady`
(4 s after spawn) or in the waker's chained `ready` (`idle-suspend.ts:224`) before
`submitQueue.submit`. During that wait `pendingSubmission` is false. If the tick lands in that
window while the lane is unfocused, `suspendLane` passes its re-checks (`canRestartLane`: phase idle,
nothing pending) and kills the pty. The message is then typed into a dead terminal id. The submit
queue's undelivered report probably catches it, which I did not verify, but the dispatch was
recorded `sent`.

No test covers "resumed lane, then tick". `idle-suspend.test.ts` checks `quietFor` against transcript
and keystroke only.

### H2. Suspension cancels the task-scoped "went quiet" close, and the suspended state is never cleared on its own

`src/renderer/lib/lane-lifecycle.ts:85` (`if (lane.ended) return { close: false … }`), defaults
`DEFAULT_KEEP_WARM_MINUTES = 10` and `DEFAULT_QUIET_MINUTES = 120` (`lane-lifecycle.ts:169,175`),
against `DEFAULT_IDLE_SUSPEND_MINUTES = 30` (`src/renderer/lib/tuning.ts`). The reaper claim is at
`electron/src/main/worktree-reap.ts:813`.

Before this branch, a lane that went idle without calling `task_status('done')` was closed at
120 minutes on the "went quiet" path. That path marks its tasks `abandoned`, snapshots WIP, removes
the worktree directory and marks the row `suspendedAt`, so the next dispatch resumes it cold. With
this branch, the same lane is idle-suspended at 30 minutes. After that its tab is `ended`, and
`laneCloseDecision` returns "the pty already exited" on every later tick, so the backstop never fires.
The same happens to any reported-done lane when the user's keep-warm setting is 30 minutes or more.

Nothing else clears `idleSuspendedAt`. A resume clears it (`spawnInPlace` sets it undefined and
persist rewrites the row), and so does a manual close of that tab (`forgetSavedSession`). Every other
route leaves it set:
- `pruneSavedSessions` now treats every `idleSuspendedAt` row as live (`DashboardView.tsx` launch
  prune, the `liveClaudeIds` change).
- The reaper treats the row as a claim (`liveClaims`), so `liveClaimNow` refuses removal even from
  Settings → Worktrees, with the error "a lane is open in it (suspended)". `queueEndedSessions` skips it.
- Each relaunch restores the row as a placeholder tab.

Failure scenario: over a week, 10 dispatched lanes finish their work without calling `task_status`.
On main they would have closed at 2 hours and their worktrees would have been reaped once merged.
On this branch all 10 stay in the rail as "suspended" forever. Their worktrees, often on merged
branches, cannot be removed by the reaper or from Settings. Their tasks stay `running` on the board
instead of becoming `abandoned`. The only way out is to close each tab by hand.

The brief asked that suspension never look like `worktree_done` to the reaper. It did not ask that
suspension replace the lifecycle close. The branch has no rule for how the two interact.

---

## Medium

### M1. Closing a project skips its suspended lanes; they return at the next launch and keep their worktree claims

`src/renderer/lib/project-shelf.ts:69` (`closePlan` keeps only `status !== 'ended'`), used by
`closeProject` at `DashboardView.tsx:1334`.

A suspended tab's sidebar session has `status: 'ended'` (`tabSessionStatus`), so `closeProject` never
calls `handleCloseSession` for it. The tab stays in `terminals`. Its row keeps `idleSuspendedAt`, the
reaper keeps the claim, and the next launch restores it as a placeholder. Closing a project used to
mean "every lane of this project ends, worktrees removed, rows forgotten". With this branch it leaves
every suspended lane behind.

Related: `isOnRail` counts only live sessions (`project-shelf.ts:39-41`). A project whose remaining
lanes are all suspended drops off the rail while those lanes still sit in `terminals`. Coordinators
are never suspended, so this only happens in projects without a running coordinator.

### M2. Resume-on-launch starts suspended lanes at launch and can create a duplicate tab for one key

`DashboardView.tsx:3610-3620` (`handleResumeProject`), called from the launch restore before
`setRestoreSettled(true)` (`:5479-5497`). The placeholder restore at `:5297` runs only after
`restoreSettled`.

`handleResumeProject` resumes every saved row of the project that has no tab, and that includes
`idleSuspendedAt` rows. With "resume on launch" on (off by default), the lanes it reaches before the
placeholders exist get a full `--resume` through the normal restore. This breaks brief §5: "a
relaunch … must restore them as suspended, not start their CLIs".

Race: `handleResumeProject` awaits each lane in turn. The placeholder effect computes `here` from
`terminalsRef` once. A key that is mid-spawn at that moment (inside `restoreOnce`, not yet in
`terminalsRef`) gets a placeholder too. The `setTerminals` filter only drops a placeholder whose key
is already in state. The `terminalsRef.current = [...terminalsRef.current, ...tabs]` line drops none.
The result can be two tabs with the same key, one live and one placeholder. The persist effect keys
rows by `key` and keeps whichever comes last, and routing could pick either.

### M3. A reply is lost when the resume fails, after the sender was told not to resend

`src/renderer/lib/idle-suspend.ts:224` (joiners skip delivery when the tab is null) and `:234`; bus
path `DashboardView.tsx:2027-2030`; sentinel path `:1863`; resume failure branches in
`resumeSuspended` (`:3950-3986`).

- Bus reply: `wakeWith` answers the sender "Operator is resuming it and will hand it your message.
  Do not send it again". If `resumeSuspended` returns null (folder gone and not rebuildable, or the
  spawn returns nothing), the reply text is dropped. The toast says "Could not resume X" and does not
  mention the reply.
- Sentinel `OPERATOR-REPLY`: `record('sent')` runs before the wake result is known, and failure leaves
  it `sent`.
- Any message that joined an in-flight resume through the waker is dropped the same way.
- When the spawn succeeds but `--resume` itself fails, the opening prompt is lost with no undelivered
  report, because it rode on argv and not through the submit queue. For example, Claude Code's
  `cleanupPeriodDays` (default 30) can delete the transcript of a lane suspended that long, and the
  CLI then prints "No conversation found" and exits. The new pty's exit is not in `restartedFromRef`,
  so `exitCompleteRef` also completes that lane's running tasks as `done`.

Dispatches are safe on the first two paths: `handleLaunchRole` returns undefined and the dispatch
falls back to `queued`.

### M4. A message arriving during `suspendLane` can start a second CLI on the same session, and the resume then deletes the old pty's exit guard

`DashboardView.tsx:3910-3945` (`suspendLane`), `:3978`.

`suspendLane` marks the tab suspended in `terminalsRef` and in state, then awaits
`reportSuspended`, an IPC call that waits for main's last-run file write. Only after that does it add
the old id to `restartedFromRef` and kill the pty. A dispatch or reply routed in that window sees the
tab as suspended and wakes it. `resumeSuspended` then spawns `--resume <same id>` while the old CLI is
still alive, so two processes briefly hold the same conversation. After a successful spawn,
`resumeSuspended` runs `restartedFromRef.current.delete(terminalId)` on the old id. If that runs
before the old pty's exit event arrives, the exit handler runs the normal exit bookkeeping for the
old id (`exitCompleteRef` → `completeTerminalTasks`). Tasks were rekeyed to the new id, so the
damage is limited to role-matched tasks that have no session id. The window is short: one IPC call
plus one file write.

Also in `suspendLane`: if `terminalKill` throws, the error is logged and the tab stays marked
suspended while its CLI may still be running. The next resume then starts a second CLI beside the
orphaned one.

---

## Low

- **L1. Unsent-input tracking misses several inputs.** `src/renderer/lib/lane-keystrokes.ts:31` (a
  module-level `Set`). Its state is lost on a renderer reload (watchdog respawn, crash, ⌘R), and so is
  `lastKeystrokeAt`. A draft typed before a reload is invisible afterwards, and the lane can be
  suspended with that draft in its composer. Some inputs are never tracked at all: IME and dictation
  composition (`TerminalPane.tsx:244` returns before `noteDraftKey`), and a file dropped onto the pane
  (inserts a path, no keydown).
- **L2. Mid-compaction kill.** An idle compaction in progress writes nothing until it finishes, and
  0.28.3 deliberately reads it as `waiting` (`transcript.ts:641-668`). The tick can kill a lane
  mid-compaction. The cost is the wasted compaction, and the lane comes back uncompacted. Most likely
  at the 60-minute setting, which is close to the 1-hour cache TTL that triggers idle compaction.
- **L3. Dispatch before placeholders exist.** At launch, between `reattachDone` and the placeholder
  restore, a dispatch to a role whose lane is idle-suspended finds no suspended tab. The cold launch's
  `suspendedToResume` (`src/renderer/lib/lane-workspace.ts:45`) only reads `suspendedAt`, so it starts
  a fresh lane in a new worktree. The old row is then restored beside it and keeps its claim. The
  window is narrow, because a coordinator needs a model turn before it dispatches.
- **L4. Keys typed at the overlay are discarded.** `SuspendedOverlay` (`DashboardView.tsx:6714`) calls
  `preventDefault` on every printable key and resumes. The brief lists typing as a resume trigger, but
  what the user typed is dropped, and every key pressed during "Resuming…" is dropped as well.
- **L5. Fan index lost on relaunch.** A placeholder tab is built without `fanIndex` (`SavedSession`
  has no such field). After a relaunch, a fanned lane (index > 1) resumes with the bus name of index
  1 and collides with its sibling on the session bus. The existing restore path has the same gap;
  suspension makes it more frequent.
- **L6. Readiness timing is unmeasured.** `LANE_SETTLE_MS = 4000` after "observed". A resumed
  transcript is observed as soon as the track registers, so in practice this is 4 s from spawn. Long
  transcripts with several MCP servers may take longer than that to draw the composer. Code says this
  is unmeasured. The submit queue's undelivered report is the safety net.
- **L7. Queued backlog not picked up.** A resume by dispatch does not include the role's queued
  backlog (decision 10). Combined with H2, lanes that used to be closed and then cold-launched (which
  does include the backlog) are now resumed, so queued tasks for those roles stay on the board until
  something else launches the role.
- **L8. No roster state.** The Team/roster panel does not show the suspended state (Code lists this
  under "Not done"). Brief §6 asked for "the roster and the pane".

---

## Normal dispatch with the new `whenLaneReady` wait (asked explicitly)

I found no regression in ordinary sends.
- The wait is one promise per terminal, so a dispatch and a reply to the same lane are still typed in
  arrival order.
- A lane Operator did not start in this run, which includes every lane after a renderer reload, has no
  `spawnedAt` and is ready at once. For ready lanes the only change is a one-microtask delay before
  `submitQueue.submit`.
- `retryDispatch` calls `clearComposer` synchronously before the routed send, so the clear still runs
  first.
- The new cost is that a lane spawned within the last 15 s whose transcript has not appeared, such as
  a lane launched with no prompt, waits up to 15 s before a dispatch is typed. That is the intended fix
  for "Dispatch #2 lost at lane launch".
- The one way the wait causes harm is the H1 escalation: during the wait, `pendingSubmission` reads
  false, so the suspend tick can end the lane.
- `spawnedAtRef` and `readyRef` are never pruned. That is a small leak over a long run, not a defect.

## Checked and clean

- **LaneWaker** (`idle-suspend.ts:207-238`): one resume per key. Joiners are chained on the previous
  promise, so they are typed in arrival order. A wake with no message joins the in-flight resume. When
  no resume is in flight, `wakeLaneRef` re-finds the lane by key, so an id that changed during the
  resume is followed correctly, including when routing ran on stale render state
  (`dispatchRef.current.terminals`).
- **No double spawn within a run:** `handleLaunchRole` (suspended branch before the launch-in-flight
  join and the cold launch), `handleRestoreSession` (suspended check before `restoreOnce`), the Team
  "Launch" button, bus dispatch, sentinel dispatch and approval all go through `wakeLaneRef`. Retire
  (`opts.replacing`) correctly skips the suspended branch.
- **Bus reply wake** (`dispatch-bus.ts`): reachable only for `kind === 'reply'`. It passes
  `evaluateDelivery` with `targetLive: true`, so brakes, hop budget and pause still apply. Dispatches
  take the existing `launching` route and resume with the task as their opening prompt.
- **Opening prompt on argv:** `buildArgs` produces `--resume <id> … -- <text>`. The `--` terminator
  from security H3 still applies, and `--remote-control <name>` binds its name before the prompt.
  `terminalSpawn` registers the track with the same session id.
- **last-run.json:** `parseLastRun` validates `suspended`. `withCarried` merges own and carried
  suspended lists without duplicates. `previousRunInfo` drops suspended keys that have a live pty.
  `setSuspended` is ignored once frozen. `recompute` stops carrying a key the current run holds
  suspended. The renderer reports the set before the kill. Restore reads main's list on a launch only,
  and `liveAtEnd` keeps crash auto-resume and suspended restore from both claiming one key. The IPC
  input is filtered for shape.
- **Quit guard:** it counts main's live ptys, and a suspended lane has none.
- **Reaper:** `queueEndedSessions` skips `idleSuspendedAt` rows, and `liveClaims` claims them.
  Whether that claim is ever released is H2 and M1.
- **Background-task tracking** (`transcript.ts`): opens on the four measured result shapes and closes
  on `<task-notification>` in user, queue-operation and attachment records. Tasks from before this pty
  spawned are ignored (5 s clock slack), and state resets on re-read. A dev server started with
  `run_in_background` never notifies, so that lane is never suspended. That errs toward keeping the
  lane up.
- **Exclusions present in `suspendDecision`:** coordinator, focused, in-flight, released, no phase,
  non-idle phase (a permission prompt reads as `running`), pending submission, unsent input, held
  deliveries (24 h window), background tasks, subagents, dev server (checked last, and an unknown
  result keeps the lane up). Each has a test.
- **Tab id move:** `spawnInPlace` moves the active terminal, `local-` active session, tasks and
  done reports to the new id. A placeholder id cannot collide with `tN`. `terminalKill` on a
  placeholder id is a no-op in main (`terminals.ts:469-471`), so a manual close of a restored
  suspended tab works: tasks finish, the worktree is snapshotted and removed, and the row is
  forgotten.
- **UI rules:** the "suspended" phase word drops the 0.65 opacity, so no opacity is stacked on
  `--fg-muted`. The Tuning copy binds sentence-initial words with ` `. Only one new verb (resume)
  was added, with no shared glyph.

## Recommendation for the coordinator

Do not merge as is. H1 and H2 need changes in Code's lane before QA's GUI pass is worth running.
- H1: count spawn or resume time as activity in `quietFor`, or skip lanes spawned within the idle
  window.
- H2: decide how suspension and the lifecycle close interact. One option is that the went-quiet
  backstop also applies to suspended tabs. Another is that a suspended lane past `quietMs` is closed
  the same way the backstop closes a live one.
- M1: include suspended tabs in `closePlan`.
- M2: skip `idleSuspendedAt` rows in `handleResumeProject` during launch, or restore placeholders
  before auto-resume runs.
- M3 and M4 are smaller and can go in the same round.
After that, QA's GUI checklist in Code's notes applies, run in an isolated `OPERATOR_DIR` with the
setting at 15 min.
