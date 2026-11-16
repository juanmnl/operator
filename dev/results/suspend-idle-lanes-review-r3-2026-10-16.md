# Review round 3: suspend idle lanes (operator/119080, 7aebaa9..2420035)

Reviewer: Review lane, 2026-10-16. Scope: `git diff 7aebaa9..2420035` (10 files, +635/−100). 2420035 is a direct
descendant of 7aebaa9. I also read the surrounding code the fixes depend on:
- the submit queue's chain and `pending`;
- `closeLane`'s worktree removal chain;
- `handleLaunchSession`'s resume path;
- `worktree.ts` `createWorktree`/`reattachWorktree`;
- the restore path's directory check;
- the lifecycle and suspend ticks.

Round 2: `dev/results/suspend-idle-lanes-review-r2-2026-10-16.md`. Code's notes:
`dev/results/suspend-idle-lanes-2026-10-16.md` § Round 3.

I extracted 2420035 with `git archive` into my scratchpad and ran the root suite: 120 files, 1862 tests passed, the
same count Code reports. I also ran electron `last-run.test.ts` (38 passed). I did not run the full electron suite.
Nothing was run in the app.

Line numbers are on 2420035.

## Verdict

N1, N2, N3 and N6 are fixed as described. The LaneGate cannot deadlock on the paths in this commit. One new Medium
defect: a message held by the gate during the close of a suspended lane is let through while that lane's worktree
removal is still running. On the cold path it then resumes the conversation on a fresh branch without its own
commits. On the restore path it resumes inside the directory that is being removed. The rest is Low. Fixing the
Medium is a small change: hold the gate until the removal settles.

---

## Round-2 findings: status

| Finding | Status | What I checked |
|---|---|---|
| N1 message during the kill | **Fixed** | `runSuspend` marks the tab suspended right after the second re-check, synchronously after `guardExit`, so no write can come in between. `suspendLane` holds the lane's gate from `markSuspended` until the kill settles (`finally { release?.() }`). Wakes go through `laneGateRef.after`, so a dispatch, reply, focus or click during the kill waits and then resumes with its message. Callers that routed on stale render state (`dispatchRef.current.terminals`, the sentinel reply's `tabs`) still reach `submitQueue.submit(oldId)`. `divert` is checked right before the write, after the gap sleep, so those messages go into the wake. A message counted by `submitWhenReady` blocks the second re-check (`awaitingReadyRef`), and `pending` is set only at the write, so nothing already written can be stranded. On a failed kill: `unmarkSuspended` clears the divert and makes the tab live, the gate is released after `report(false)`, and the waiting wakes find a live tab and type into it. |
| N2 close vs resume | **Fixed for the orphan CLI** (new defect R3-1 is in the same path) | `handleCloseSession` holds the gate for a suspended tab during the whole `closeLane`. `closeLane` updates `terminalsRef` (all closes) and `savedSessionsRef` (lifecycle closes) synchronously before it returns. A wake that waited then finds no tab and resolves null, so no CLI starts without a tab. A resume already in flight is awaited through `waker.wake` directly, not through the gate, so the close cannot wait on itself. The lifecycle tick skips lanes that are suspending, gate-busy or waking. The suspend tick counts a busy gate as in flight. |
| N3 held keys | **Fixed** (ordering residual documented by Code) | The overlay's unmount hands over a pending burst through `onResumeRef`, the latest handler. `HeldKeys` reads the text at the write, so the last hand-over wins and the text is written once. `submitQueue.draft` is chained, sends a bracketed paste with control characters stripped, and adds no CR. It is queued one timer tick after readiness, behind messages already waiting on that readiness. |
| N6 spawn time after reload | **Fixed** | `terminals.list()` reports `startedAt`, and the reattach seeds `spawnedAtRef` through `spawnStampsFromList` (alive only, `sh*` skipped), without overwriting a stamp taken in this renderer. |

---

## New defects

### R3-1 (Medium). A wake held during a suspended lane's close is released while the close is still removing that lane's worktree

`DashboardView.tsx`: `handleCloseSession` (the gate is released when `closeLane` returns), `closeLane`'s worktree
removal (`void finishTasks.then(async () => { worktreeStatus … worktreeCommit … worktreeRemove })`, not awaited),
the `handleLaunchRole` fallthrough (`if (tab || terminalsRef.current.some(…)) return …`, otherwise the cold path),
and the `handleRestoreSession` fallthrough. `electron/src/main/worktree.ts:299-311` (`reattachWorktree`).

`closeLane` returns `'closed'` as soon as it has dropped the tab. The WIP snapshot and the directory removal run
afterwards, chained on `finishTasks`: a `git status`, maybe a commit, then `git worktree remove`. That takes hundreds
of milliseconds to seconds. The gate opens at the moment `closeLane` returns, so any wake that queued during the close
runs while the old directory still exists.

Failure scenario, cold path (the common one):
1. The lifecycle tick closes suspended Code lane X (quiet past 120 min, no open work) and takes X's gate.
2. The coordinator dispatches to Code during the close. Routing sees the suspended tab, `handleLaunchRole` calls
   `wakeLaneRef`, and the call waits on the gate.
3. `closeLane` returns. The gate opens. `wakeNow` finds no tab and returns null. `handleLaunchRole` falls through
   to the cold path, which finds the closed row (`suspendedAt`, via `savedSessionsRef`, updated synchronously) and
   calls `handleLaunchSession` with `resume.worktreeBranch`. That calls `worktreeCreate(src, <X's branch>)`.
4. In main, `reattachWorktree` builds the same path (`<project>-<branch tail>`). The old directory is still there,
   because the removal has not run yet, so `if (existsSync(path)) return null`. `createWorktree` then falls back to a
   new `operator/<id>` branch from the default base.
5. The dispatched task runs as `--resume <X's conversation>` in a tree without X's committed work. The comment on
   `reattachWorktree` describes this case as "worse than a cold start because it looks correct". The old directory
   is then removed as planned.

Failure scenario, restore path: the resume card, "Continue" or a project resume calls `handleRestoreSession` for X
during the close. Its wake waits on the gate, finds no tab, and recurses into `handleRestoreSession` with the closed
row. `pathExists(saved.cwd)` is still true, so `restoreCwdPlan` does not rebuild, and the lane is spawned in the old
directory. The removal chain then deletes that directory under the running lane, after committing the lane's
uncommitted work as WIP.

A live lane's lifecycle close already had a smaller version of this window: a dispatch arriving between the tab drop
and the removal. The gate makes it systematic. Every wake that arrived during the close is let through exactly at
the start of that window.

Fix options:
- Hold the gate until the removal chain settles. `closeLane` could return the removal promise, or
  `handleCloseSession` could await it before `release()`.
- Alternatively, have the fallthrough wait for any removal in flight for that path.

No test covers it. The "lane gate" tests check that a waiting wake finds no lane, not what the fallthrough does
next.

### R3-2 (Low). Gate holds have no timeout, so a hung kill or spawn stops all delivery to the lane without any message

`LaneGate` (`idle-suspend.ts`): `after` waits for every hold with no bound.
- **Suspend:** the hold is released only when `terminalKill` returns. `reapAndForget` takes a `ps` snapshot and walks
  the process tree.
- **Close:** if a resume is in flight, the hold waits for `waker.wake`. That chain includes `worktreeCreate` (when
  the folder is gone) and `terminalSpawn`, and neither has a timeout in the renderer.

If any of those hangs, every dispatch, reply, focus and click for that lane queues behind the gate forever. The pane
keeps saying "Suspended — click to resume" (`wakingKeys` is not set while waiting), clicks appear to do nothing, and
both ticks skip the lane because `busy(key)`. Dispatches recorded `launched`/`sent` never arrive and are never
reported undelivered. `closeProject`'s 4 s timeout reports such a lane as "did not stop" and moves on, but the hold
stays. A cap on the wait that falls back to reporting the message undelivered would turn the hang into a visible
failure.

### R3-3 (Low). The restore fallthrough after a user close reads a stale saved row and can bring a forgotten lane back

`handleRestoreSession` fallthrough: `handleRestoreSession(savedSessionsRef.current.find((sv) => sv.key === saved.key) ?? saved, …)`.

A user close of a suspended lane (no lifecycle reason) calls `forgetSavedSession`, which updates state only.
`savedSessionsRef` follows on the next render. A restore that waited on that close and then falls through can read
the row before it is forgotten, which still carries `idleSuspendedAt`. It then resumes the thread the user just
closed. If the ref has no row by then, the restore uses the argument `saved` instead, with the same result. It needs
a resume-card or project-resume click during a manual close, so it is rare. The fix is the same as the one used for
the lifecycle close: update `savedSessionsRef` synchronously in `forgetSavedSession`, and have the fallthrough return
`'skipped'` when the row is gone.

### R3-4 (Low). Smaller notes

- **The close can kill a lane that a dispatch just resumed.** When a user close (or a project close) starts while a
  resume is in flight, the close awaits it and then closes the live lane it produced. If a dispatch caused that
  resume, the dispatch's task is completed as `done` by `closeLane`'s `finish`, even though the lane never worked
  on it. The lifecycle close cannot reach this case because the tick skips waking lanes. The user asked for the
  close, so this is acceptable, but the dispatch record should arguably turn `queued`.
- **A held draft can still be submitted by a later dispatch.** `typeHeldKeys` orders the draft behind messages that
  were already waiting. A dispatch that arrives after the draft is written is chained after it, and its CR submits
  the person's text with it. Live lanes with a hand-typed draft already behave this way, so it is not new to this
  feature.
- **`notePaste` can mark a draft that is never written.** `typeHeldKeys` calls `notePaste` at the ask, before
  `typeInto` decides whether anything is left to write. If the held text was cleared in between, the lane is marked
  as having a draft that does not exist, and it will not be suspended until an Enter or Ctrl+C. This errs toward
  keeping the lane up.
- **No "Resuming…" feedback during a gate wait.** While a wake waits on the gate, the pill still says "Suspended —
  click to resume" (Code noted this). Combined with R3-2, the user has no sign that the click registered.

## LaneGate, `divert`/`draft`, and the `closeLane` split: checked and clean

- **No deadlock in this commit.** No holder awaits a gated wake for its own key:
  - `suspendLane` awaits only `report`/`kill`; the divert callback calls the gated wake without awaiting it.
  - `handleCloseSession` awaits `waker.wake`, which is not gated, and `closeLane`, whose awaits are IPC calls and
    `finish`, which never wake.
- **`after` ordering.** Waiters on one key wait on the same promises, so their `.then` callbacks run in call order.
  A hold taken while they wait makes them all wait again, so the order is kept. `release` is idempotent, and
  empty sets are cleaned up.
- **`divert`:**
  - It applies only to `submit` and is checked at the write.
  - The `awaitingReadyRef` count for the old id drops when the diverted submit returns.
  - It is not cleared after a successful suspend. That is harmless, because ids are not reused within a run.
  - `submitTyped`, `clearComposer`, `attachImages` and `draft` to the old id after the mark still go to the dying
    pty. That is intended, and nothing of value is lost.
- **`draft`.** Chained like `clearComposer`, a bracketed paste with no CR, control characters stripped.
- **The `closeLane` split.** `closeLane` now reads the tab from `terminalsRef`, and `terminals` left its dependency
  list. Nothing else in its body read `terminals`. A live lane bypasses the gate (`if (!tab?.idleSuspendedAt) return
  closeLane(…)`), so ordinary closes behave as before.
- **The cold-path fallthrough condition.** A wake that returned null while the tab still exists means the resume
  failed. In that case it returns undefined, and the dispatch is queued instead of starting a second lane. Only a
  tab that really went away falls through. R3-1 is about what that fallthrough meets, not about the condition.
- **Suspended-lane focus during the kill.** The focus effect calls the gated wake again on every `terminals`
  change. After the release, the first call starts the resume and the rest join with no message, so there are no
  duplicates.

## Recommendation for the coordinator

Send R3-1 to Code. It is one change: release the gate after the worktree removal, not when `closeLane` returns.
R3-2 (a cap on gate waits that reports undelivered) and R3-3 (synchronous `savedSessionsRef` in
`forgetSavedSession`) are small and can go with it. After that, QA's list plus Code's round-3 additions applies. Add
one case: dispatch to a suspended lane while the quiet setting is lowered so that it closes, and confirm that the
lane resumes on its own branch.
