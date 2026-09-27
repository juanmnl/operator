# Retire a released lane on dispatch — 2026-09-27

Branch `operator/917d80`, from `main` @ fe6029e. Separate from the lanes-as-profiles steps.
First commit 8cc53fd. Review's findings
(`dev/results/retire-released-lane-review-2026-09-27.md` in the main checkout) are fixed in the
commit after it; see "Review fixes" at the end, which supersedes the busy-case and not-covered
sections below where they differ.
Brief: retire an idle lane whose worktree was already released (`worktree_done`) and launch a
fresh one on dispatch, instead of coordinators asking the user to close it.

## What changed

**Main exposes its existing release record.** No second store.
- `ArtifactStore.pendingReleases(appPid)` (`electron/src/main/chat-store.ts`) reads open
  `worktree_release` rows (`handled_at IS NULL`) for one app run.
- IPC `pendingReleases()` (`electron/src/main/ipc.ts`, contract in
  `electron/src/shared/operator-api.ts`, type in `src/renderer/env.d.ts`) answers it for
  `process.pid`. Terminal ids restart every run, so rows from an earlier run are excluded. The
  Tauri bridge returns `[]`.

**The renderer marks released lanes and routes on it** (`src/renderer/lib/dispatch.ts`).
- `RoutableTab` gains `phase` and `released`.
- `markReleased(tabs, rows)` sets `released` only on a worktree lane (own branch, `cwd` differs
  from `sourceCwd`) whose terminal id AND directory match an open row, and whose project matches
  when the row names one. Nothing else sets it: no inference from merged branches or missing
  directories.
- `routeDispatch` has two new outcomes for a live lane with `released`:
  - `retire`: the phase is between turns (`waiting` or `idle`, via `isBetweenTurns` from
    `lib/comms`).
  - `finishing`: any other phase (`running`, `compacting`, `asking`), or no phase at all. A lane
    Operator cannot see is never ended.
- A lane without `released` routes as before.
- `DashboardView`'s `withActivity` now adds `phase` (from the tracked session) and `released`
  (from a cache of `pendingReleases`) to the tabs. Dispatch, approval naming and the bus resolver
  already go through it. The cache is refreshed every 4 s. The bus tick also re-reads it before
  routing any open request, so a lane that called `worktree_done` a moment ago is seen.

**Both dispatch transports share the router.**
- Bus (`resolveDispatch`, `src/renderer/lib/dispatch-bus.ts`):
  - `retire` answers `launching`, the same answer as a lane that is not running, with a reason
    that says the old session is being ended. The brakes are not charged (a launch is not a
    message).
  - `finishing` answers `refused`. The reason tells the coordinator to retry once the lane is
    idle and not to ask the user to close it. It is not charged either.
  - The authority gate still runs first, so a non-coordinator's dispatch to a released lane is
    held for approval as before.
- Delivery (`deliverDispatchRef`, used by the sentinel path, bus `launching` and approval):
  - `retire`:
    1. Look up the lane's session.
    2. `await handleCloseSession(session)` with no `suspend`, the same call as the user's close.
       It kills the pty (main's on-exit `releaseWorktreeOnExit` then removes the worktree), marks
       the lane's running tasks done, and forgets the saved record.
    3. Launch the role with the task as its opening brief.
    - If no session is found, nothing is closed or launched and the task goes to the queue.
    - The launch goes through the existing per-(project, role) in-flight guard, so a burst of
      dispatches joins one relaunch.
    - Recorded `launched`. The toast says "Relaunching".
  - `finishing`: nothing is typed and nothing is ended. It is recorded with the new outcome
    `finishing` and a `note`; the chip reads "not delivered · lane finishing". The dispatcher gets
    a feedback line saying to dispatch again once the lane is idle.

**The fresh lane never gets the released worktree.** `handleLaunchRole` takes
`opts.replacing = <retired terminal id>`:
- The reuse guard (`pickLaneTab`) skips that tab. `terminalsRef` can still hold it until the
  next render, and reusing it would type the brief into a dead pty.
- No suspended record is resumed (`suspendedToResume` in `lib/lane-workspace.ts`, extracted so it
  can be tested). `worktreeCreate` therefore gets no branch to reuse and creates
  `operator/<new id>` at a new path.
- Checked against the removal paths:
  - `releaseWorktreeOnExit` is keyed on (terminal id, cwd, app pid), so it only ever touches the
    old path.
  - The renderer close's `worktreeRemove` targets the old `tab.cwd`.
  - `checkAutoRemoval('lane-exit')` runs only on a self-exit, and a kill is not one.
  - No reap path keys on role (`laneId` is recorded in provenance but read by nothing).
  - Even a reuse request for the released branch cannot land in the released directory while it
    exists: `reattachWorktree` refuses an existing path, and `createWorktree` falls back to a
    fresh one (tested).

**Coordinator brief** (`src/renderer/lib/roster.ts`):
- New `RETIRE_NOTE`, coordinator only: "A new lane needs only a dispatch: Operator ends a lane
  that called `worktree_done` and launches a fresh one. Never ask the user to close it."
- `DISPATCH_PROTOCOL`'s refused clause now reads "retry only for a bad lane name or if it says
  to", so the `finishing` reason does not contradict it.
- The note-size guards went up, with the measurement in the comment:
  - `roster.test.ts`: 3800 → 4000 (coordinator 3764 → 3938).
  - `bus-name.test.ts`: 4300 → 4400 (coordinator with the bus note: 4389).
  - Lane notes are unchanged.

## Busy case: refuse, not hold

A released lane that is mid-turn gets `refused` on the bus (`finishing` on the sentinel path)
with a reason telling the coordinator to retry once it is idle. Refusing is the simpler option
that is correct. A hold would need:
- a queue that survives a renderer respawn (measured hourly on this machine);
- a trigger on the lane's phase going idle;
- an answer for a lane that never goes idle.

None of those exists today, and a hold kept only in renderer memory would lose dispatches
silently. The retry costs the coordinator one call.

## Tests

- `src/renderer/lib/dispatch.test.ts`:
  - released + idle (`waiting`, `idle`) → `retire`;
  - released + `running`/`compacting`/`asking`/unknown → `finishing`;
  - not released → `send` in every phase;
  - another project's released lane is never picked, in either direction;
  - an ended released lane → `queue`;
  - `markReleased`: needs both terminal id and directory, respects project, never marks a
    main-checkout lane or a tab without a branch, leaves other tabs as they were.
- `src/renderer/lib/dispatch-bus.test.ts`:
  - `retire` → `launching` with no brake charge;
  - busy → `refused` with the retry reason, no charge, no `held`;
  - a non-coordinator is still held;
  - no release → `send`.
- `src/renderer/lib/lane-workspace.test.ts`: `suspendedToResume` resumes nothing when replacing,
  so the launch creates a new worktree.
- `electron/src/main/worktree-done.test.ts`, real git in a temp `OPERATOR_DIR`:
  - `pendingReleases` lists the row for this run only and drops it once the exit settles it;
  - a same-role relaunch while the release is open gets a different path and branch, and the old
    lane's exit removes only its own directory;
  - a reuse request for the released branch still gets a different path.

Results:
- Typecheck: root `tsc --noEmit` clean; `electron npm run typecheck` clean (both configs).
- Root suite: 109 files, 1613 tests passed.
- Electron suite: 45 files, 793 tests passed.

## Not covered / left alone

- **Human Send / Start all does not share the resolver.** `dispatchToRole`, `sendProjectTask`
  and `startProjectTasks` find the live lane with `terminals.find(...)` and type into it. Per the
  brief, left unchanged. A human Send to a released idle lane still types into it. The same
  functions also do not skip ended tabs; that was already the case and is not touched here.
- **`handleLaunchRole`'s own reuse guard** (RosterPanel Launch, hub card) uses `pickLaneTab` but
  still reuses a released lane. Only the dispatch path passes `replacing`.
- **Auto-close interaction** (observed from the code, not exercised): the lane-lifecycle
  auto-close can close a released lane after its grace window with `suspend = 'reported-done'`.
  That keeps a suspended record, and a later dispatch resumes it on its old branch in a
  reattached worktree. That path does not involve a pending release (the exit settles the row),
  so it is outside this change. It conflicts with "new work gets a fresh lane"; whether a
  released lane should be suspended at all is a decision for the coordinator.
- **Approval of a held dispatch** to a busy released lane records `finishing`, and nothing
  retries it, because the sender was not the coordinator. The user sees the toast and the chip.
- **The retired lane loses focus.** If the user was looking at the retired lane, the close
  clears the active terminal, and the fresh lane launches with `focus: false`.
- **Not GUI-verified.** Nothing here was run in the app.

## Review fixes (second commit)

Each finding, what changed, and the test that covers it. Paths are in this branch.

### H1: new work into a released lane cancels its release

A lane is retired only if nothing was delivered to it after its release. There are two layers.

- **Main, from the transcript** (`electron/src/main/transcript.ts`, `index.ts`, `chat-store.ts`):
  - `Track.lastPromptAt` is the transcript timestamp of the newest real prompt: a main-thread
    user turn or a mid-turn enqueue. Injected turns, sidechains and tool results are excluded.
  - The tailer emits `prompt` when that timestamp changes.
  - Main then runs `cancelReleasesBefore(terminal, pid, promptAt)`. It settles open rows older
    than the prompt as `cancelled: new work after release`.
  - A cancelled release is no longer pending, so dispatch does not retire the lane.
    `releaseWorktreeOnExit` finds no row and leaves the directory alone. The lane calls
    `worktree_done` again when that work is done, which opens a new row.
  - This catches every path, including a person typing into the terminal, because all of them end
    up as a prompt in the transcript.
- **Renderer, before the transcript shows it:**
  - `submitQueue` has an `onSubmit` hook that fires at enqueue, before the write.
  - DashboardView uses it on every submission to a tab with an open release. That covers
    dispatch, board Send, Start all, a Launch that reuses the lane, and replies.
  - The hook drops the row locally, remembers the cancel time (so a poll that raced it cannot
    bring the row back), and calls the new `cancelRelease` IPC.
- **Quiet window** (review L2): a released lane is `settling` if any of these is true, and a
  settling lane is not retired:
  - a keystroke into it in the last 10 s (`lib/lane-keystrokes.ts`, recorded from the panes' real
    key events);
  - a submission awaiting its turn;
  - transcript activity in the last 3 s.
- Tests:
  - `transcript.test.ts`: `lastPromptAt` counts user turns and enqueues, ignores injected,
    sidechain and tool-result records, and never moves backwards.
  - `worktree-done.test.ts`, real git:
    - a prompt after the release cancels it; the row reads `cancelled: …`, `releaseWorktreeOnExit`
      returns `none`, and the directory survives;
    - a prompt before the release cancels nothing;
    - a cancel touches only that terminal in that run;
    - a second `worktree_done` opens a new row.
  - `submit-queue.test.ts`: `onSubmit` fires at enqueue, before any write, and a throwing
    listener does not block the submission.
  - `dispatch.test.ts`: a settling released lane routes `finishing`.
  - `lane-keystrokes.test.ts`.

### H2: the relaunch never types into another live lane

- `reusableLane` (`lib/dispatch.ts`) returns nothing when the launch replaces a retired lane.
  `handleLaunchRole` uses it, so a duplicate live tab on the role is never reused and a fresh lane
  is always launched.
- Test: `dispatch.test.ts` `reusableLane`, with a duplicate that is live and one that is released.

### M1: `finishing` cannot loop, and the dispatcher is told when the lane is idle

`lib/retire-watch.ts`:
- **Watch:** the first `finishing` refusal opens a watch on that lane, per (project, role), and
  records who to tell.
- **The one message:** the watch sends one line, to each dispatcher in the watch or, for an
  approval, to the user as a toast. It goes out in the first of these cases:
  - the lane is idle and settled;
  - it took new work (its release was cancelled);
  - it ended;
  - 30 minutes have passed.

  After that the watch is gone.
- **The first refusal** says that message will come and that the dispatcher should not dispatch
  before it. If no message arrives within 30 minutes (a renderer respawn loses the watch), it
  should dispatch again.
- **Repeats while the watch is open:**
  - on the bus, the reason says the message is already promised, with the refusal count;
  - on the sentinel path, the dispatch is recorded but nothing is typed. The typed note was what
    started the dispatcher's next turn, and that turn dispatching again was the loop.
- **Unknown phase:** it is still never retired. It opens a watch that can only end as took-work,
  ended or timeout. On timeout the line says not to dispatch again and to tell the user, so it
  ends.
- **Brakes:** `finishing` is still not charged to them. Rate-limiting per lane with one message
  replaces charging, because charging the hop budget would mute the coordinator for all lanes.
- Tests:
  - `retire-watch.test.ts`: the watch, all four signals, settling and asking give no signal, the
    unseen timeout, the lines, and the three reasons;
  - `finishingDelivery`: the first refusal types, a repeat types nothing, an approval records
    nothing;
  - `dispatch-bus.test.ts`: the first and repeat reasons, and the `finishing` fields.

### M2: a released worktree follows main's release rule

`releasedClosePlan` (`lib/lane-lifecycle.ts`), used by `handleCloseSession`:
- **Any close of a released lane** skips the renderer's WIP snapshot and `worktreeRemove`. Main's
  `releaseWorktreeOnExit` decides on exit: removed if clean, kept if dirty.
- **An automatic close of a released lane** (a retire, or the lifecycle; both idle):
  1. Finish its tasks first (diff capture, verification gate) while the directory exists.
  2. Re-read the release. If it was cancelled meanwhile (the lane took work), abandon the close
     and leave the lane running.
  3. Kill the pty; main then applies its rule.
- **The retire** runs this close beside the fresh launch. Routing treats the retiring lane as
  ended from the moment it is chosen, so the relaunch does not wait for the checks.
- A user's close of a busy released lane still kills first. Main's rule still decides the
  directory, so the WIP override is gone there too.
- Test: `lane-lifecycle.test.ts` `releasedClosePlan`.

### M3: an approval that hits a busy released lane stays actionable

- Approval, Retry and Assign go through `finishingDelivery` with `approving`. It records nothing,
  so the record keeps `pending-approval` / `undelivered` / `unassigned`, and the card stays in
  Waiting with its buttons.
- A watch with nobody to type into toasts the user when the lane can be approved again.
- Test: `retire-watch.test.ts`, "an approval records nothing…".

### M4: the lifecycle ends a released lane instead of suspending it

- The keep-warm close checks for a release:
  - released → `handleCloseSession(session, undefined, { auto: true })`, with no suspended record,
    and a toast saying the next dispatch starts a fresh lane;
  - not released → unchanged.
- `releasedClosePlan` also forces `suspend` off for a released lane, whoever closes it.
- The coordinator note's promise now holds after the keep-warm window.
- Test: `lane-lifecycle.test.ts`, "a released lane is never suspended".

### Lows

- **L1:** the retire/launch IIFE catches errors. The task is queued, a toast says so, and joined
  dispatches resolve to no tab and queue their own. No unit test: this is component code.
- **L2:** the settling window, under H1.
- **L3:**
  - The bus tick reads tabs per request.
  - A lane being retired is in `retiringRef`, and `withActivity` marks it ended. A second request
    in the same tick routes `queue` and joins the relaunch.
  - The lifecycle skips a retiring lane.
  - Test: `dispatch.test.ts`, "a lane being retired … routes to a launch".
- **L4:** the held record's verdict carries `held.retires`. The held toast, on both paths, says
  approving ends the target's released lane, and approving into a retire says so in its toast.
  Test: `dispatch-bus.test.ts`, the held case.
- **L5:**
  - `DISPATCH_PROTOCOL` is back to "retry only for a bad lane name", so it no longer reads as
    permission after a brake refusal.
  - `RETIRE_NOTE` now says a busy lane means a refusal and one message when idle, then dispatch
    again.
  - Guards, measured: coordinator 4008 (`roster.test.ts` 4000 → 4200) and 4459 with the bus note
    (`bus-name.test.ts` 4400 → 4600). Both leave room for longer project names.
  - The stale "the longest is Infra" comment is corrected.

### Results

- Typecheck: root `tsc --noEmit` clean; `electron npm run typecheck` clean.
- Root suite: 111 files, 1643 tests passed.
- Electron suite: 45 files, 800 tests passed.

### Still not covered

- **No GUI verification.** Nothing here was run in the app. A retire, a burst of two dispatches,
  a busy refusal followed by the idle message, and the lifecycle close of a released lane all
  need a run.
- **A retire can leave a duplicate lane.** If a person types into a lane during the seconds or
  minutes its tasks are checked, the close is abandoned and that lane keeps running beside the
  fresh one. A toast says so.
- **The finishing watch lives in renderer memory.** A respawn loses it; the refusal tells the
  dispatcher to dispatch again after 30 minutes without a message.
- **A queued prompt enqueued BEFORE `worktree_done`** and consumed after it does not cancel the
  release, because its timestamp is older.
- **Older suspended records** saved before this change still resume on their branch.
- **Human Send / Start all still find the lane with `terminals.find`.** They are not routed
  through the resolver, but their submissions now cancel the release, which is what H1 needed.
