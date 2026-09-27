# Retire a released lane on dispatch — 2026-09-27

Branch `operator/917d80`, from `main` @ fe6029e. Separate from the lanes-as-profiles steps.
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
