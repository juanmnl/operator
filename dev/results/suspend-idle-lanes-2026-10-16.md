# Suspend idle lanes — result (2026-10-16)

Branch `operator/b0b440` (worktree `~/.operator/worktrees/operator-b0b440`), not merged.
Brief: `dev/results/_scratch/suspend-idle-lanes-brief-2026-10-16.md`, plus the coordinator's addendum
(never suspend a lane with background tasks or subagents running).

## What it does

- Every 60 s, a lane whose phase is `idle` or `waiting` and that has been quiet past the Tuning setting
  (default 30 min, Off available) has its CLI ended. Quiet is measured from the later of its last
  transcript record and its last keystroke. At most 2 lanes per tick, quietest first.
- The tab stays in the roster, marked suspended: dimmed orb (the existing `ended` wave status), the
  phase word "suspended" in the expanded rail row, and in the pane the last frame under a dim scrim
  with one line, "Suspended — click to resume" ("Resuming…" while it starts).
- It resumes in place with `--resume <claudeSessionId>` and the same launch args (model, effort,
  permission mode, orchestration note, bus name, remote control) on: focus (rail, roster, ⌘1-9,
  anything that sets the active lane), a click or typed key on the pane, a dispatch (sentinel or bus,
  including an approved held one), an OPERATOR-REPLY or `mcp__operator__reply`, the resume card,
  "Continue", or project resume.
- Main records suspended lanes in last-run.json under `suspended` (separate from `lanes`), and
  sessions.json rows carry `idleSuspendedAt`. A relaunch or crash auto-resume restores them as
  suspended tabs and never starts their CLIs.

## Never suspended

Each rule is in `suspendDecision` (`src/renderer/lib/idle-suspend.ts`) and has a unit test:

- phase `running`, `compacting` or `asking`, or no tracked session yet. A permission prompt reads as
  `running` (an unanswered tool_use), so it is covered;
- the lane the user is looking at (`activeTerminalId`);
- unsent text in its composer (new tracking in `lib/lane-keystrokes`: a printable key or paste starts
  a draft, Enter or Ctrl+C ends it);
- a submission in the submit queue not yet seen as a turn;
- a held or owed dispatch/reply addressed to its role in the last 24 h: `pending-approval`,
  `undelivered`, `hop-limit`, `pair-brake`, `paused`, `finishing`, `retiring`;
- a live dev server on its ports (`sessionPorts`, any attribution except `claimed` by another lane);
- a coordinator (`operator`, `orchestrator`);
- background tasks still running in its CLI (addendum): Bash `run_in_background`, async Agent,
  Workflow, and a command moved to the background at its timeout; and `activeSubagents > 0`;
- a lane with no Claude session id, one that released its worktree, and one with a restart, retire,
  launch or resume in flight.

## Files changed

| File | Change |
|---|---|
| `src/renderer/lib/idle-suspend.ts` (new) | Eligibility (`suspendDecision`, `planSuspends`, `needsPortCheck`, `servesDevServer`, `heldDeliveriesFor`), placeholder ids, readiness (`laneReady`), and `LaneWaker`, which orders messages behind a resume. |
| `src/renderer/lib/tuning.ts` | `IDLE_SUSPEND_KEY`, `DEFAULT_IDLE_SUSPEND_MINUTES` (30), `IDLE_SUSPEND_OPTIONS` (Off, 15, 30, 60, 120), get/set. |
| `src/renderer/components/tuning/TuningView.tsx` | "Idle lanes" section with the radio group, always shown. |
| `src/renderer/lib/lane-keystrokes.ts` | `lastKeystrokeAt`, unsent-input tracking (`draftEffect`, `noteDraftKey`, `notePaste`, `hasUnsentInput`). |
| `src/renderer/components/terminal/TerminalPane.tsx`, `GridTerminalPane.tsx` | Feed key and paste events to the draft tracking. |
| `src/renderer/lib/dispatch.ts` | `RoutableTab.suspended`, `pickSuspendedTab`; the `queue` route names the suspended lane. |
| `src/renderer/lib/dispatch-bus.ts` | A bus reply to a suspended lane passes the brakes, then returns `launching` with an internal `wake`; a bus dispatch to one says it is resuming. |
| `src/renderer/lib/cli-update.ts` | `restartLaunchOptions` takes an `initialPrompt`. |
| `src/renderer/lib/workspace.ts` | `snapshotLaneKeys` leaves suspended tabs out of `liveKeys`, so the resume card never offers them. |
| `src/renderer/views/DashboardView.tsx` | Tab fields `idleSuspendedAt`, `resumeSessionId`; the restart split into `spawnInPlace` (shared by restart and resume); `suspendLane`, `resumeSuspended`, the waker, the suspend tick, focus-resume, launch restore of suspended tabs, reporting the set to main, the persist effect, the dedupe prune, dispatch/reply/restore wiring, `SuspendedOverlay`. |
| `src/renderer/components/sidebar/SessionItem.tsx` | The "suspended" phase word, with no opacity stacked on `--fg-muted`. |
| `src/shared/types.ts` | `AgentSession.backgroundTasks`, `AgentSession.suspended`, `SavedSession.idleSuspendedAt`, `PreviousRunInfo.suspended`. |
| `src/renderer/env.d.ts`, `electron/src/shared/operator-api.ts`, `electron/src/main/ipc.ts` | New IPC `setSuspendedLanes(list)`. |
| `electron/src/main/last-run.ts` | `suspended` list in the record; `setSuspended`; carried across a crash like `lanes`; a key with a live pty is live; ignored once frozen. |
| `electron/src/main/transcript.ts` | Open background tasks per track (`backgroundTasks()` in the session), counting only those started after this pty spawned. |
| `electron/src/main/worktree-reap.ts` | A row with `idleSuspendedAt` is a live claim (`liveClaims`, so also `liveClaimNow`), and `queueEndedSessions` skips it. |
| Tests | `idle-suspend.test.ts` (new, 27), `transcript-background.test.ts` (new, 6), additions to `last-run.test.ts` (6), `worktree-cleanup-gaps.test.ts` (1), `dispatch.test.ts` (2), `dispatch-bus.test.ts` (3), `cli-update.test.ts` (1), `workspace.test.ts` (1), `lane-keystrokes.test.ts` (3). |

## Decisions

1. **One way back.** The CLI-update restart's spawn half became `spawnInPlace`; restart is "kill +
   spawnInPlace", resume is "spawnInPlace from a suspended tab". The tab keeps its slot and key; only the
   terminal id changes, and the active selection, terminal-stamped tasks and done reports move with it,
   as the restart already did. Crash auto-resume and the resume card go through `handleRestoreSession`,
   which now resumes a suspended tab with the same key instead of spawning a second one.
2. **The first message rides the spawn.** The message that wakes a lane (dispatch or reply) is passed
   as the resumed CLI's opening prompt (`--resume <id> -- <text>`), so it cannot arrive before the CLI
   can take it. Messages that arrive while the resume is in flight wait for it, then for readiness, and
   are typed in arrival order (`LaneWaker`, tested).
3. **Readiness.** `whenLaneReady` waits until the lane's tracked session is seen and 4 s have passed
   since spawn, or 15 s at most, one shared promise per lane. Besides the resume path I applied it to
   the other places a message can hit a lane that is still starting: a dispatch joining a launch in
   flight, a prompt into a just-reused lane, the dispatch `send` route and sentinel replies to a live
   lane. For a lane Operator did not just start it resolves at once. This also addresses the old
   "Dispatch #2 lost at lane launch" case, but that is not verified in the GUI.
4. **Not the existing `suspendedAt`.** `SavedSession.suspendedAt` already means "closed after
   finishing, tab and worktree directory gone". This feature uses `idleSuspendedAt` so neither path
   reads the other's rows.
5. **Placeholder tabs.** A suspended lane restored at launch has no pty in this run; its tab id is
   `suspended:<key>` so it cannot collide with a per-run pty id (`t0`, `t1`, …). No terminal pane is
   mounted for it, only the overlay.
6. **last-run.json.** Suspended lanes are a separate `suspended: [{ key, at }]` list. `lanes` stays
   "the pty table", so crash auto-resume and the card are unchanged and never see them. The renderer
   reports the set before it kills the CLI, so a crash in between still finds the lane. The quit guard
   counts main's live ptys, so a suspended lane was never counted as busy; nothing changed there.
7. **Worktree claim.** Without the reaper change a suspended lane's worktree would have looked
   unclaimed (no pty backs the row) and could have been auto-removed if merged, or queued for removal at
   the next boot. That is now a claim for as long as the row carries `idleSuspendedAt`.
8. **Background tasks.** Measured on this machine's transcripts before writing the parser: 1,088
   `Command running in background with ID:` results, 319 `Async agent launched`, one `Workflow launched
   in background`, and `moved to the background (ID: …)` at timeouts, all closed by a
   `<task-notification>` naming the same `tool-use-id` (statuses seen: completed 5,447, failed 816,
   killed 165, stopped 12). A resumed transcript still holds the previous process's tasks, which died
   with it, so only tasks after this pty's spawn count.
9. **Held deliveries.** `queued` and `not-retired` do not keep a lane up: the task waits on the board and
   suspending loses nothing. `undelivered` does, because that text may sit in the composer. Records older
   than 24 h are ignored, or one old record would pin a lane forever.
10. **Queued tasks on resume.** A resume by dispatch sends only that dispatch, like reusing a live lane.
    It does not fold in the role's queued backlog the way a cold launch does.

## Test results

- Root suite `npx vitest run`: 118 files, 1815 passed (baseline before the change: 117 files, 1778).
- Electron suite `cd electron && npx vitest run`: 52 files, 962 passed (baseline 51 files, 949). The
  first baseline run had 1 failure that did not recur on rerun and was not in a file I touched; I did
  not identify it.
- `cd electron && npm run typecheck`: no errors. Root `npx tsc --noEmit`: no errors.

## Not tested

- Nothing was run in the app. No GUI verification of: the suspend tick firing, the overlay, the dimmed
  orb and "suspended" word, focus/click/typing resume, a dispatch or reply resuming a lane, relaunch and
  crash restore of suspended tabs, or the Tuning control. These need the user (or QA) in a dev build.
- The DashboardView wiring has no unit tests (the view has none). The pure parts it calls are tested.
- The readiness heuristic (session seen + 4 s, or 15 s) is not measured against real CLI start times.
- `sessionPorts` attribution for a lane whose sibling in the same cwd serves the shared reserved port:
  it counts as "serving" (conservative), so such lanes are not suspended. Not checked live.

## Not done, or left as is

- Suspended lanes are not shown in the Team/roster panel as a distinct state: the roster reads them as
  not running, and its Launch button resumes them (through `handleLaunchRole`). Only the rail row and the
  pane say "suspended".
- No memory-pressure trigger (research fix #2). Suspension is time-based only.
- No toast per suspension, to keep it quiet; each suspension is logged with `console.info('[lanes] …')`.
- A draft deleted with Backspace still counts as unsent until the next Enter or Ctrl+C, so such a lane
  stays up. Known, and the safe direction.
- The roster's "N running" counts and the quit guard ignore suspended lanes by construction; no change
  was needed.
- Recommendation for the coordinator: QA should drive the GUI checks above in an isolated dev build
  (OPERATOR_DIR isolated), with the setting at 15 min, before this is merged.

---

## Round 2: fixes for Review and QA (2026-10-16)

Review: `dev/results/suspend-idle-lanes-review-2026-10-16.md`. QA: `dev/results/suspend-idle-lanes-qa-2026-10-16.md`
(defect D1, added by the coordinator). One commit on top of 376b23b. Not merged. Nothing was run in the app.

### What changed

| Finding | Fix | Where | Test |
|---|---|---|---|
| H1: a lane resumed with no message was suspended again on the next tick | `quietFor` takes the pty's spawn time as activity (a launch, a restart or a resume), next to the transcript and the last keystroke. Messages waiting on `whenLaneReady` are counted per lane (`submitWhenReady`, `awaitingReadyRef`), and a lane with one is never suspended (`awaitingDelivery`). `suspendLane` re-checks the count as well. | `lib/idle-suspend.ts` `quietFor`, `suspendDecision`; tick and `suspendLane` in `DashboardView.tsx` | `idle-suspend.test.ts` "a lane just resumed (review H1)" |
| H2: a suspended lane was never closed, so its row, tab and worktree claim stayed forever | As decided: a suspended lane quiet past the lifecycle `quietMs` (default 120 min) gets the went-quiet close a live lane gets: tasks abandoned, WIP snapshot, worktree removed, row marked `suspendedAt`. The row's `idleSuspendedAt` is cleared in the same write (`closedLaneRow`), so the reaper's claim ends and the next launch does not restore it. The quiet clock is the latest of transcript, keystroke and spawn at the moment of suspension (`quietSince` on the tab, persisted as the row's `lastActiveAt`), so a lane the user resumed and looked at is not closed on its old transcript time. The usual guards still apply: open work, coordinator, focus, auto-close off. | `lib/lane-lifecycle.ts` `suspended`, `suspendedCloseDecision`, `closedLaneRow`; lifecycle tick and `handleCloseSession` | `lane-lifecycle.test.ts` "a lane suspended while idle (review H2)", "the saved row of a closed lane" |
| M1: closing a project skipped its suspended lanes | `closePlan` includes sessions with `status: 'ended'` and `suspended`. `isOnRail` counts a project with suspended lanes (`ProjectActivity.suspended`, kept out of `live`, so "N running" is unchanged). | `lib/project-shelf.ts`, `lib/project-status.ts` | `project-shelf.test.ts`, `project-status.test.ts` |
| M2: resume-on-launch started suspended lanes, and a key could get two tabs | Resume-on-launch passes `skipSuspended` and main's suspended keys to `handleResumeProject`, which then leaves those rows alone. The placeholder restore goes through `suspendedRowsToRestore`, which skips a key that has a tab, a key whose restore is in flight (`restoringKeysRef`), a key live at the end of the last run, and a duplicate row. The `terminalsRef` append also drops keys already present. | `lib/idle-suspend.ts` `suspendedRowsToRestore`; launch restore in `DashboardView.tsx` | `idle-suspend.test.ts` "restoring suspended tabs at launch (review M2)" |
| M3: a failed resume dropped the message it carried, and could complete tasks as done | Spawn fails: the sentinel reply and the bus reply turn their dispatch record to `undelivered` and toast "X did not get its message". The bus reply now writes a `sent` record (with `replyId`, so the board ignores it) for that purpose. A dispatch already falls back to `queued`. Spawn succeeds but `--resume` exits on its own within 60 s with no new transcript record (`failedResume`): its exit does not complete the lane's tasks, the carried message is reported undelivered, and a toast says the lane exited right after resuming. | `lib/idle-suspend.ts` `failedResume`, `tookTurnSince`; `exitCompleteRef`, `resumeWatchRef`, both reply paths, `reportUndelivered(…, 'resume')` | `idle-suspend.test.ts` "a resume that did not come back (review M3)" |
| M4: a message during `suspendLane` could start a second CLI on the same session | New order (`runSuspend`): re-check, tell main, re-check again (cancel and take the lane back out of main's record if anything arrived), set the exit guard, kill, and only then mark the tab suspended. Until the kill the tab is a live lane, so routing types into it rather than resuming it. A failed kill removes the guard, restores main's record and leaves the lane running. `resumeSuspended` no longer deletes the old id from `restartedFromRef`. | `lib/idle-suspend.ts` `runSuspend`; `suspendLane`, `resumeSuspended` | `idle-suspend.test.ts` "the order of one suspend (review M4)" |
| L4: keys typed at the overlay were discarded | The overlay holds printable keys (Backspace takes one back) through "Resuming…" and resumes after a 150 ms pause in typing. Once the lane is ready, the held text is written into its composer unsent and counted as a draft. Enter only resumes; nothing is submitted. Shortcuts and arrows are not taken. | `lib/idle-suspend.ts` `overlayKey`; `SuspendedOverlay`, `typeHeldKeys` | `idle-suspend.test.ts` "keys typed at the suspended pane (review L4)" |
| L5: fan index lost on relaunch | `SavedSession.fanIndex` is persisted. The placeholder tab (`placeholderTab`), the restore path and a cold resume through `handleLaunchRole` use it for the tab and for `laneBusName`. | `src/shared/types.ts`, persist effect, `handleRestoreSession`, `handleLaunchSession` | `idle-suspend.test.ts` "the tab a restored row comes back as (review L5)" |
| QA D1: a suspended lane vanished from the rail | `ProjectRail` `liveOf` keeps sessions that are `ended` and `suspended`, so the dimmed row and the word "suspended" render and a click resumes the lane. The "+" menu no longer offers "Start X" for a suspended lane. | `components/sidebar/ProjectRail.tsx`; lane menu in `DashboardView.tsx` | `components/sidebar/project-rail-suspended.test.ts` (renders the real rail; 2 of its 3 tests fail on 376b23b) |

### Test results

- Root `npx vitest run`: 119 files, 1842 passed (376b23b: 118 files, 1815).
- Electron `cd electron && npx vitest run`: 52 files, 962 passed (unchanged; no electron files changed).
- `cd electron && npm run typecheck`: no errors. Root `npx tsc --noEmit`: no errors.

### Behaviour to know about

- A suspended lane that reported done closes at `quietMs`, not at the keep-warm window. The keep-warm window
  (10 min) is shorter than the smallest suspend setting (15 min), so using it would close every reported lane on
  the tick after its suspension. Its tasks are marked done; a lane that never reported has them marked abandoned.
- A suspended lane is closed whatever its phase was when it was suspended (usually `waiting`). A live `waiting`
  lane is never closed by the lifecycle; a suspended one is, at `quietMs`. Without that, H2 would stay open for
  most lanes, since the tracker reports a finished turn as `waiting`.
- A lane resumed by focus with no message, whose CLI exits on its own within 60 s before writing anything (for
  example `/exit` typed at once), is treated as a failed resume: its tasks are left open and a toast says so.
- The bus reply's "do not send it again" answer to the sender is not retracted when the resume fails. The record
  and the toast say the reply was lost.

### Not done

- No GUI verification. QA's remaining list applies (#3, #5, #6, #9–#13 in the QA file), plus: a resumed lane
  that loses focus is not suspended again within the idle window (H1), a suspended lane closes at `quietMs`
  (lower the quiet setting to test it), closing a project ends its suspended lanes, keys typed at the overlay
  land in the composer unsent, and the rail row for a suspended lane.
- The DashboardView wiring still has no unit tests; the pure parts it calls are tested.
- L1, L2, L3, L6, L7, L8 from the review are unchanged.

---

## Round 3: fixes for Review round 2 (2026-10-16)

Review: `dev/results/suspend-idle-lanes-review-r2-2026-10-16.md`. One commit on top of 7aebaa9, on branch
`operator/119080` (a fresh lane, reset to 7aebaa9 first). Not merged. Nothing was run in the app.

### What changed

| Finding | Fix | Where | Test |
|---|---|---|---|
| N1: a message routed during the kill was typed into the dying CLI and reported undelivered | The tab reads as suspended from the moment the last re-check passes, before the kill. From then until the kill settles, the lane's gate is held (`LaneGate`, by lane key), and every wake goes through the gate: a dispatch, reply, focus or click in that window waits, then resumes the lane with its message as the opening prompt; later ones join in arrival order. Anything still owed to the old pty is diverted into the same wake: `submitQueue.divert(oldId, …)` hands over every submission not yet written (queued before the commit and waiting out the gap, or sent by a caller that read the tab a moment earlier), checked right before the write. A message waiting on `whenLaneReady` for the old id reaches `submitQueue.submit` after readiness and is diverted the same way. A failed wake reports it undelivered with the `resume` wording. A kill that fails ends the divert, shows the tab live again (`unmarkSuspended`), and what waited is typed into the running lane. | `lib/idle-suspend.ts` `runSuspend`, `LaneGate`; `lib/submit-queue.ts` `divert`; `suspendLane`, `wakeLaneRef` in `DashboardView.tsx` | `idle-suspend.test.ts` "the order of one suspend (review M4, N1)", "a message routed while the old CLI is being killed (review N1)", "the lane gate"; `submit-queue.test.ts` "divert" (3) |
| N2: the close of a suspended lane had no guard against a resume | `handleCloseSession` is now a wrapper around the old body (renamed `closeLane`). For a suspended tab it holds the lane's gate for the whole close, so a wake that arrives during the close waits, then finds no tab and resolves null. Before the gate opens, the close updates `terminalsRef` and `savedSessionsRef` synchronously (the state follows on the next render), so that wake reads the lane as gone and the saved row as closed. A dispatch whose wake ended that way (`handleLaunchRole`) falls through to the cold path, which resumes the thread from the closed row; `handleRestoreSession` does the same. A resume already under way when a close starts is let finish, and the lane it brought back is the one closed. The lifecycle tick skips a lane whose suspend is in flight, whose gate is held, or whose resume is in flight, and the suspend tick counts a held gate as in flight. `closeLane` reads the tab from `terminalsRef` instead of the render's `terminals`. | `handleCloseSession`/`closeLane`, `handleLaunchRole`, `handleRestoreSession`, lifecycle and suspend ticks in `DashboardView.tsx` | `idle-suspend.test.ts` "the lane gate" (a hold taken while a wake waits is waited for; a wake that waited on a close finds no lane and starts nothing) |
| N3: keys typed in the last burst were lost, and the held text went out raw | `SuspendedOverlay` moved to `components/terminal/SuspendedOverlay.tsx`. Its unmount hands over the keys typed since the last pause (it used to clear the timer and drop them), through the latest `onResume`. The view keeps the text in `HeldKeys`, which reads it at the write, not at the ask, so the last hand-over wins and the text is typed once. The write is `submitQueue.draft`, a new chained op: a bracketed paste with no Return, control characters stripped. It is queued one timer tick after readiness, so every message already waiting on the same readiness (a dispatch that joined the resume) is queued first and submitted alone; the person's text then lands in the composer, unsent. | `components/terminal/SuspendedOverlay.tsx`; `lib/idle-suspend.ts` `HeldKeys`; `lib/submit-queue.ts` `draft`; `typeHeldKeys` | `components/terminal/suspended-overlay.test.ts` (3, renders the real overlay; 2 of them fail with 7aebaa9's unmount cleanup); `idle-suspend.test.ts` "keys held at the overlay" (3); `submit-queue.test.ts` "draft" (2) |
| N6: `spawnedAt` was lost on a renderer reload | `terminals.list()` in main reports each pty's `startedAt` (already recorded for last-run.json), and `ManagedTerminal.startedAt` carries it. The reattach stamps `spawnedAtRef` from it (`spawnStampsFromList`: live ptys only, scratch shells and unparseable times skipped). | `electron/src/main/terminals.ts`, `src/shared/types.ts`, reattach effect | `last-run.test.ts` "the pty list carries each lane's start time" (real `TerminalManager`); `idle-suspend.test.ts` "spawn times survive a renderer reload" (2) |

### Test results

- Root `npx vitest run`: 120 files, 1862 passed (7aebaa9: 119 files, 1842).
- Electron `cd electron && npx vitest run`: 52 files, 963 passed (7aebaa9: 962).
- `cd electron && npm run typecheck`: no errors. Root `npx tsc --noEmit`: exit 0.

### Behaviour to know about

- While the kill runs, the pane already shows "Suspended — click to resume". A click or focus in that time
  waits for the kill and then resumes; the pill does not say "Resuming…" until the resume starts.
- If the kill fails, the overlay shows for the length of the kill and then goes, and the lane is live again.
- The submission that is already written to the old pty and not yet confirmed is not re-delivered. The last
  re-check refuses to suspend while one exists (`canRestartLane` with `pending`), and from the commit on
  nothing is written to the old pty, so there is none to carry.
- `divert` stays set for the old terminal id after a successful suspend. Ids are not reused within a run,
  the same reason the id stays in `restartedFromRef`.
- A user close of a suspended lane that forgets the row (not the lifecycle close) leaves a dispatch that
  waited on it to start a fresh lane, which is what a forgotten row means.

### Not done

- N3's ordering residual: anything typed straight into the resumed pane before the lane is ready still lands
  before the held text, because the held text is written only after readiness (4 s at least). Fixing it
  would mean keeping the overlay over the resumed pane until the held text is written.
- N4 and N5 are unchanged, as the review allowed.
- No GUI verification. Added to the QA list: a dispatch sent within a second of a suspend starting resumes
  the lane with that dispatch and no "never started" toast; closing a suspended lane (lower the quiet
  setting) while clicking it leaves no orphan `claude` process (`ps`); typing at a suspended lane without
  pausing lands the whole line in the resumed composer, unsent; ⌘R a few minutes after resuming a lane by
  focus, then unfocus it, and it is not suspended on the next tick.
- The DashboardView wiring still has no unit tests; the parts it calls are tested.

## Round 4: fixes for Review round 3 (2026-10-16)

Review: `dev/results/suspend-idle-lanes-review-r3-2026-10-16.md`. One commit on top of 2420035, on the lane branch
`operator/1a7f80` (a fresh lane, reset to 2420035 first). Not merged. Nothing was run in the app.

### What changed

| Finding | Fix | Where | Test |
|---|---|---|---|
| R3-1: a wake held during a suspended lane's close was let through while the close was still removing the worktree, so a dispatch resumed the thread on a fresh branch and a restore spawned inside the directory being removed | `closeLane` records the WIP snapshot + removal chain it starts, by lane key (`worktreeRemovalsRef`). The close of a suspended lane now runs through `closeUnderGate`: the gate is taken before the close and released only when that chain settles (failed or not), or at the close's return when there is no removal (a lane in the main checkout). The close's outcome is still returned when `closeLane` returns, so `closeProject`'s 4 s timing is unchanged. A dispatch that waited then falls through to the cold path after the directory is gone, and main's reattach puts the lane's own branch back in `<project>-<branch tail>`. | `lib/idle-suspend.ts` `closeUnderGate`; `closeLane`, `handleCloseSession` in `DashboardView.tsx` | `idle-suspend.test.ts` "a dispatch that waits on a close resumes on the lane's own branch" (4): the dispatch waits past the close's return until the removal ends and gets the old branch and path; the same harness released at the return (round 3) gets a fresh branch; a failed removal and a throwing close both release. `worktree.test.ts` "resuming a closed lane while its old directory is still there" pins main's half against real git: before the removal, `createWorktree(repo, branch)` forks a fresh branch without the lane's commit; after it, the same call returns the lane's branch, same path, commit on disk. |
| R3-2: gate waits had no bound | `LaneGate.after(key, go, timedOut)` caps the wait at `GATE_WAIT_CAP_MS` (30 s), counted from the first wait, across holds taken meanwhile. Past the cap it returns `timedOut()` and `go` never runs, even if the hold ends later. Without `timedOut` it waits as before. `wakeLaneRef` always passes one and returns `'timed-out'`. Callers: the reply paths and the kill-time divert report the message undelivered with a new `waited` wording ("It stayed busy for 30 s; not resumed."); `reportUndelivered` takes the tab as the caller saw it as a fallback, so the record turns `undelivered` even if the lane was closed meanwhile. A dispatch through `handleLaunchRole` returns undefined, so the dispatch path queues the task and tells the dispatcher, and never falls through to the cold path. A restore returns `failed`. The pane: the overlay takes `stalled` and reads "A message was not delivered — click to resume" (a message was dropped) or "Not resumed after 30 s — click to try again" (a click or focus), until the next click or a resume that comes back. | `lib/idle-suspend.ts` `LaneGate`, `GATE_WAIT_CAP_MS`; `components/terminal/SuspendedOverlay.tsx`; `wakeLaneRef`, `reportUndelivered`, `stalledKeys`, the four wake callers in `DashboardView.tsx` | `idle-suspend.test.ts` "gate waits are capped" (5); `suspended-overlay.test.ts` "after a wake gave up" (3, renders the real overlay) |
| R3-3: the restore fallthrough after a user close read a stale row | `forgetSavedSession` updates `savedSessionsRef` synchronously, as the lifecycle close already did. The fallthrough reads the row with `rowAfterClose` and returns `'skipped'` when it is gone; it no longer falls back to the row it was called with. | `lib/idle-suspend.ts` `rowAfterClose`; `forgetSavedSession`, `handleRestoreSession` | `idle-suspend.test.ts` "a restore after the user closed the lane" (3): skipped with the ref updated at once; the round-3 order (ref on the next render) restores the forgotten lane |
| R3-4: `notePaste` marked a draft that might never be written | The held-key write moved to `lib/idle-suspend.ts` `typeHeldKeys`, which the view calls. It notes a keystroke at the ask (so the lane does not read as quiet while the text is on its way) and the draft only inside the write. When nothing is held it does not ask for readiness. | `typeHeldKeys` in `lib/idle-suspend.ts`; `typeHeldKeysInto` in the view | `idle-suspend.test.ts` "held keys count as a draft only once written" (3), against the real `lane-keystrokes` |

### Test results

- Root `npx vitest run`: 120 files, 1881 passed (2420035: 1862).
- Electron `cd electron && npx vitest run`: 52 files, 964 passed (2420035: 963).
- `cd electron && npm run typecheck`: no errors. Root `npx tsc --noEmit`: exit 0.

### Behaviour to know about

- A close whose tasks were `reported-done` runs the project's check command before the removal (`runTaskChecks`),
  which can take minutes. A suspended lane closed that way keeps its gate for that long, so a dispatch to it
  times out at 30 s: queued on the board with the "could not be launched" feedback, and the pane says a message
  was not delivered. The `went-quiet` close, the common one for a suspended lane, skips the checks and takes
  seconds.
- If the WIP snapshot fails, the close keeps the worktree folder by design. A dispatch that waited then resumes
  from the closed row while the folder is still there, and main forks a fresh branch, as before this round.
  The folder is not being removed in that case, so a restore that spawns in it is safe; the cold path's fresh
  branch is the existing `reattachWorktree` rule.
- The overlay still says "Suspended — click to resume" while a wake waits on the gate (up to 30 s). It changes
  only when the resume starts or the wait gives up.

### Not done

- The live-lane version of R3-1 (a lifecycle close of a LIVE lane, then a dispatch between the tab drop and the
  removal) is unchanged. It does not go through the gate. The fix would be for the cold path to wait on
  `worktreeRemovalsRef` for that key, with the same cap. Recommended for Code in a later round.
- R3-4's other notes (the close completing a dispatch's task as `done`, a held draft submitted by a later dispatch)
  are unchanged, as the review allowed.
- The DashboardView wiring still has no unit tests. R3-1's test runs the real `LaneGate` and `closeUnderGate`
  against a fake main with `reattachWorktree`'s path rule; that rule is pinned separately against real git.
- No GUI verification. Added to QA's list: lower the quiet setting so a suspended worktree lane closes, dispatch
  to it during the close, and confirm it resumes on its own branch (`git -C <worktree> branch --show-current`)
  with its commits; and, if a hang can be produced, that the pane shows "A message was not delivered" after 30 s.

## Round 5: fixes for QA's final pass (2026-10-16)

QA: `dev/results/suspend-idle-lanes-qa-final-2026-10-16.md`. One commit, 7f103f8, on top of cd5df8b, on the lane branch
`operator/80eb00` (a fresh lane, reset to cd5df8b first). Not merged. Nothing was run in the app.

### What changed

| Finding | Fix | Where | Test |
|---|---|---|---|
| D2: a lane suspended before its first turn could not be resumed (`--resume` prints "No conversation found") and dropped off the rail with no toast | Main answers which Claude session ids have a transcript holding a user turn: `conversationsWithTurn(ids)` (`sessionsWithTurn`, `hasUserTurn`: a `user` record that is not `isMeta` and not a sidechain, read line by line until the first one). Claude Code writes a transcript with no turn for a lane with Remote Control on (`custom-title`, `bridge-session`, `last-prompt`, …), so a missing file and a file with no turn both count as none. **Suspend:** `SuspendCandidate.conversation`; the decision asks for it after the quiet check (`checkConversation`, `needsConversationCheck`) and refuses without it ("it has no turn to resume"); unknown is kept. The tick reads it only for lanes that pass every earlier rule; ids seen with a turn are cached. **Wake:** `resumeSuspended` checks first and spawns nothing for a lane with none: the tab stays suspended, a toast says why, and focus does not retry it. **Failed resume:** the watch now reads a new `AgentSession.lastRecordAt` (the newest record's timestamp, absent until one is read). It read `lastActivityAt`, which main fills with "now" before any record, so a resume that found nothing read as having come back: the exit was taken for the lane finishing, and no toast showed. A suspended lane whose resume exits at once goes back to suspended (`backToSuspended`), keeps its row and rail entry, and gets the toast. **Resume card:** "Resume N agents", "Resume project" in ⌘K and the per-row ⌘K "Resume X" leave out rows whose session is known to have no turn (`offeredForResume`); the splash list keeps them with their "clean" reopen. A restore of such a row with `--resume` toasts and spawns nothing. A restore that does spawn with `--resume` is watched the same way, so its failure is said. | `electron/src/main/transcript.ts` `sessionsWithTurn`, `hasUserTurn`, `toSession`; `ipc.ts`; `lib/idle-suspend.ts`; suspend tick, `resumeSuspended`, `exitCompleteRef`, `handleRestoreSession`, `handleResumeProject`, `resumeOffered` in `DashboardView.tsx` | `electron/src/main/transcript-turn.test.ts` (9, real 2.1.301 record shapes: a Remote Control lane never prompted, a meta caveat only, a `/usage` command, a prompt, a missing file; `lastRecordAt`); `idle-suspend.test.ts` "never suspends a lane whose transcript has no turn…", "reads the transcript only of a lane that passed…", "a resume that found no conversation (QA D2)" (3) |
| O2: lanes resumed by the project-resume card were suspended again about 26 s later | `handleRestoreSession` spawned without stamping `spawnedAtRef`. Every lane pty is now spawned through `spawnLanePty`, which stamps it: the launch, the restore and the resume in place. | `spawnLanePty` in `DashboardView.tsx` | `lib/idle-suspend-wiring.test.ts`: the view calls `terminalSpawn` once, inside `spawnLanePty`, which stamps; all three paths call it; QA's timings (suspended 26 s after the card, 60 s limit) suspend without the stamp and not with it |
| O1/L8: the Team roster showed suspended lanes as LIVE | `RosterPanel` takes `suspendedRoles`. A suspended lane keeps its card (opening it resumes the lane), its pill reads "suspended" in muted ink with a ring instead of the filled dot, and the heading counts it apart: `Live · 1 · Suspended · 1`, or `Suspended · 2` when none runs. | `components/session/RosterPanel.tsx` `liveSectionLabel`; `ProjectView.tsx`; the project view in `DashboardView.tsx` | `components/session/roster-suspended.test.ts` (3, renders the real roster) |
| O4: "Close project · end N agents" left out suspended lanes | The label counts `live + suspended` (`lanesToEnd`, `closeProjectLabel`, shared by the gallery card and the rail menu), and confirms when either is non-zero. **The close itself also skipped them:** `closeProject` passed the observer's sessions to `closePlan`, and a suspended lane has no observed session, so round 2's M1 fix never reached the app. It now plans from the rail's sessions (`sidebarSessionsRef`). This may also be part of QA's inconclusive close-project check. | `lib/project-status.ts`; `ProjectGallery.tsx`; `closeProject` and the rail menu in `DashboardView.tsx` | `project-status.test.ts` "the Close project label" (2); `idle-suspend-wiring.test.ts` "plans the close from the rail sessions" |

### Test results

- Root `npx vitest run`: 122 files, 1895 passed (cd5df8b: 120 files, 1881).
- Electron `cd electron && npx vitest run`: 53 files, 973 passed (cd5df8b: 52 files, 964).
- `cd electron && npm run typecheck`: no errors. Root `npx tsc --noEmit`: exit 0.

### Behaviour to know about

- What counts as a turn is my reading, not checked against `claude --resume`: any `user` record that is not meta. A
  lane where the user only typed a slash command (`/usage`) has one and can be suspended. I did not run the CLI to
  confirm that such a transcript resumes.
- A lane with no turn now stays running however long it is idle. That costs its memory, which is the trade the rest
  of the suspend rules make too.
- A suspended lane with no conversation (suspended by an earlier build) cannot be resumed. Clicking it shows the toast
  again; the user closes it and starts the lane again. Starting it as a fresh session instead was not done.
- Restored lanes are now stamped, so `whenLaneReady` waits for them as it does for launched lanes (up to 4 s after the
  session is seen, 15 s at most) before typing a message into them.
- `closeProject` now also ends untracked live tabs of the project (a tab with no hook session), since the rail lists
  them. Before, the observer's list left them out.

### Not done

- The cold path (`handleLaunchRole` resuming a lifecycle-closed row with `suspendedAt`) does not check for a
  conversation. A live lane with no turn closed by the quiet limit would hit the same "No conversation found" when a
  dispatch brings it back. Recommended for Code in a later round: start such a row without `--resume`.
- The roster's `live` map still includes ended tabs that are not suspended (a lane whose CLI exited), which keep
  their LIVE card until the tab is dismissed. Unchanged; it predates this branch.
- No GUI verification. For QA: start a lane, send nothing, wait past the idle limit, and confirm it stays running;
  resume a project from the card and confirm its lanes are not suspended inside the idle window; the Team tab shows a
  suspended lane as "suspended"; "Close project · end N agents" counts suspended lanes and closing ends them (rows
  gone from the rail, no `claude` left in `ps`).

## Round 6: R5-1, transcripts under the lane's config dir (2026-10-16)

Review: `dev/results/suspend-idle-lanes-review-r5-2026-10-16.md`, finding R5-1 only. One commit on top of 7f103f8, on
the lane branch `operator/87c980` (a fresh lane, reset to 7f103f8 first). Not merged. Nothing was run in the app.

### What changed

| Finding | Fix | Where | Test |
|---|---|---|---|
| R5-1: in a project that sets `CLAUDE_CONFIG_DIR`, the turn lookup looked only in `~/.claude/projects`, so every lane of that project read as "never took a turn". The resume card and ⌘K "Resume project" left its rows out, and a restore with `--resume` refused with a false toast. | **Main looks each id up where its lane writes.** The renderer now sends `{ id, projectId }` pairs. Main resolves each project's config dir the way `terminals.ts` builds the pty env: Operator's own `CLAUDE_CONFIG_DIR`, replaced by the project's value, removed by the project's tombstone, else `~/.claude` (`effectiveConfigDir`, `laneProjectsDir`). The project read moved out of `ipc.ts` into `project-config.ts` (`readProjectConfig`) so the launch and the lookup share it; `projectConfig` in `ipc.ts` is now a wrapper with the same fail-soft behaviour. **Unknown is a third answer.** `sessionsWithTurn` returns `{ turn, none }`, and an id in neither is unknown. An id is unknown when its project id matches no project, when the config dir is not an absolute path (`~/x` or a relative path: where Claude Code resolves it from is not known here), or when the `projects` directory exists but cannot be listed. A missing file counts as "none" only when it was looked for in the lane's own directory. A `projects` directory that does not exist is still "none", since nothing was written there. **Renderer:** `hasConversation` returns undefined for an unknown id, so restore and resume go ahead as on main. The resume card's `noTurnIds` holds only ids in `none`. The suspend tick sets `conversation` to undefined for an unknown lane, which keeps it running. | `electron/src/main/project-config.ts` (new), `transcript.ts` `sessionsWithTurn`, `ipc.ts` `conversationsWithTurn`; `src/renderer/env.d.ts`; `hasConversation`, the `noTurnIds` effect, the suspend tick in `DashboardView.tsx` | `electron/src/main/project-config.test.ts` (9): a temp `projects.json` with a project that sets `CLAUDE_CONFIG_DIR` to a temp dir holding the lane's transcript; the lookup finds its turn there, where `~/.claude/projects` reads none; the precedence of project value, inherited value, tombstone and default; a relative value and an unknown project id are unknown, never "no turn". `transcript-turn.test.ts` moved to the new shape, plus "leaves an id unknown when its projects directory is not known, or cannot be listed". |

### Test results

- Root `npx vitest run`: 122 files, 1895 passed (unchanged).
- Electron `cd electron && npx vitest run`: 54 files, 983 passed (7f103f8: 53 files, 973).
- `cd electron && npm run typecheck`: no errors. Root `npx tsc --noEmit`: exit 0.

### Behaviour to know about

- No project in this machine's `projects.json` sets `CLAUDE_CONFIG_DIR`, and no shell profile here exports it, so on
  this machine the lookup is the same as in round 5.
- Lanes start through the login shell (`$SHELL -ilc`). A `CLAUDE_CONFIG_DIR` exported in `~/.zshrc` reaches the lane,
  but main does not see it when the app is opened from Finder: main then looks in `~/.claude/projects` and reads
  "none". This case is outside the brief's rule (project value, else `~/.claude`) and is not handled. Fixing it would
  need main to read the login shell's env.
- A secret-valued `CLAUDE_CONFIG_DIR` row is skipped, as the launch skips it (`envForSettingsFile` drops secrets and
  nothing resolves them for lanes today), so the lookup uses the inherited value, as the lane does.
- An unknown lane is read again on each suspend tick, since its `conversation` stays undefined. This only happens
  for lanes that pass every other rule, in a project whose config dir cannot be resolved.

### Not done

- The tailer's `findTranscript` has the same blind spot (it looks only in `~/.claude/projects`), so lanes in such a
  project still show no phase and are never suspended. Unchanged here, as the brief asked for R5-1 only. It could
  use `laneProjectsDir` with the track's `projectId`; recommended for Code as a follow-up.
- The Lows from review round 5 (R5-L1 to R5-L5) are not addressed.
- No GUI verification. For QA, if a project with `CLAUDE_CONFIG_DIR` can be set up: give it a lane, prompt it, quit,
  and confirm the resume card offers it and "Resume" brings it back with its conversation.
