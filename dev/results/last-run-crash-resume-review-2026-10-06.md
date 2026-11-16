# Review: last-run.json and crash auto-resume (operator/f67f80 @ 97bf1bc, code ca3e07b)

Reviewed 2026-10-06 by the Review lane. Diff: `git diff main...operator/f67f80` (merge base
e9b49b9 = main). Read only, no GUI run.

**Merge and tests:**
- `git merge-tree --write-tree main operator/f67f80`: exit 0. The branch sits directly on main,
  which already contains d13c40 and ae1e80-fix.
- I extracted the branch tree to my scratchpad and ran the tests the branch adds or changes:
  `last-run.test.ts` 20/20, `workspace.test.ts` + `restore-guard.test.ts` 48/48.
- Code reports the full suites green (1740 + 859).

Verdict: the recorder, the verdicts, the lock and the R2-1 fix are sound in the cases the brief
lists. Two defects are worth fixing before release:
- M1: the boot claim overwrites the previous record before anything has consumed it, so a crash
  early in the next run loses the lanes. I reproduced this with the branch's own pure functions.
- M2: on an update install, the `clean: true` write can lose a race with the 4 s deadline.

The rest are Low.

## Findings, most severe first

### M1. A crash early in the next run loses the previous run's lanes, which the old snapshot would have kept (Medium, confirmed)

`LastRunRecorder.open()` judges the previous record, then immediately claims the file with this
run's record: `writeNow()` under the lock, with `lanes: []`. The previous run's lanes now exist
only in main's memory (`this.previous`) and in the renderer's localStorage snapshot.

On the next relaunch, `withLastRun()` *replaces* the snapshot's `liveKeys` with the record's lanes.
That holds even when the record is from a run that never got far enough to act on them.

Failure scenario:
1. Run 1 ends (crash or quit) with lanes A and B. Its renderer's snapshot has `liveKeys [A, B]`,
   and last-run.json has `lanes [A, B]`.
2. Run 2 boots and claims the file (`lanes []`). Main then crashes, or the machine loses power,
   before run 2's renderer has settled its restore and written a snapshot. That takes a few
   seconds (`restoreSettled` waits for the folder checks). A crash at launch is exactly the case
   this feature is for.
3. Run 3 reads run 2's record: `unclean`, `lanes []`. `withLastRun` sets `liveKeys` to `[]`.
   `carriedLaneKeys(..., { relaunch: true })` sees an empty run, so it does not age the offer, and
   uses the snapshot's `carriedKeys` and `olderKeys` (runs 0 and -1). **A and B are gone.** They
   are not auto-resumed and not on the card.

I checked this against the branch's own pure functions (scratch test, not committed):
- `carriedLaneKeys(withLastRun(snapshot{liveKeys:[A,B]}, record{lanes:[]}), …)` gives
  `{lastRun: [], older: []}`;
- without the record (pre-branch behavior) the same call gives `{lastRun: [A, B]}`.

So this is a regression against the localStorage-only path in the exact case the branch targets.

Recommendation (Code): main should carry the previous run's not-yet-resumed lanes in the new
record until they are resumed or dismissed, the way `carriedKeys` works in the renderer, rather
than starting from `[]`. A smaller alternative: `withLastRun` falls back to (or unions with) the
snapshot's `liveKeys` when the record shows a run whose renderer never settled.

### M2. On an update install, a slow teardown leaves `clean: false`, so the updated app auto-resumes every lane (Medium-Low, confirmed by reading; timing-dependent)

- `prepareQuit` races the whole `teardown()` against `TEARDOWN_DEADLINE_MS` (4 s), then sets
  `tornDown` and calls `quitAndInstall`.
- Inside `teardown`, `killAll` is itself raced against the same 4 s, and `lastRun.finish()` comes
  after it.
- So whenever `killAll` uses most of its deadline, the outer race expires before `finish()` has
  written `clean: true`. `will-quit` then lets the app exit at once (`tornDown`), and the queued
  write is lost.

Normal `killAll` takes about 2 s (two `ps -E` passes plus a 1.5 s grace period). Slow-dying
dev servers or a busy machine push it toward 4 s.

Result: the relaunched, updated app reads `unclean` and auto-resumes every lane, with the "did not
quit cleanly" toast, after an ordinary update. The same applies to a macOS logout or restart that
kills Operator before teardown finishes.

Recommendation (Code): call `finish()` at `freeze()` time. Write `clean: true` together with the
frozen lane list before anything is killed. `clean` means "this run entered teardown"; nothing
after the freeze changes the list, and if main dies mid-kill the lanes die with it, as they would
at quit.

### L1. The crash-loop guard counts from when the auto-resume is handed out, not from when it finishes

`crashResumed` is cleared `CRASH_LOOP_MS` (2 min) after `previousRun()` hands out the auto-resume.
The queue restores lanes one at a time, and each restore takes seconds (path check, worktree
rebuild, project resolve, a version read of up to `SPAWN_VERSION_WAIT_MS`, then the spawn). With
20 to 30 lanes the queue can outlast 2 minutes.

If a late lane is what crashes the app (memory, a pathological transcript), the crash comes after
the flag cleared. The next boot auto-resumes again, and the loop repeats every few minutes. Suggest
clearing the flag 2 minutes after the queue *finishes*, which needs a renderer→main "done", or
counting consecutive crash-resumes.

### L2. A renderer that dies between `launchKind()` and its own crash-resume loses the auto-resume

Main hands `autoResume: true` to the first `previousRun()` caller only. The first renderer claims
`launch` as soon as DashboardView mounts. If it then dies before running the queue, the reload
calls `previousRun()` again and gets `autoResume: false` (already claimed), and
`crashResumeLanes` returns `[]` for `kind === 'reload'`. Main also sets `crashResumed` for nothing.

The lanes stay on the card, so nothing is lost. But the crash case, which is when the renderer is
most likely to be unstable, gets no auto-resume.

### L3. A `ps` start time that cannot be parsed makes this run stop recording for its whole life

`processIsRunning` treats a `Date.parse` NaN on `ps -o lstart=` as "running". That gives
`other-instance`, and this run never writes last-run.json. It only matters when the recorded pid
has been reused by a live process.

`ps` output follows the locale. I checked here:
- `Date.parse` handles C, es, fr and ja output;
- it returns NaN for `de_DE` ("Di.  6 Okt. …") and `pt_BR` ("ter  6 out …").

A Finder-launched app probably runs in the C locale, so this is unlikely. Running `execFile` with
`env: { LC_ALL: 'C' }` removes the question.

### L4. A dev instance on the default OPERATOR_DIR can own the file

`electron/scripts/dev.mjs` does not set `OPERATOR_DIR`.

- **Dev instance starts first.** If it starts while the installed app is not running, it owns
  `~/.operator/last-run.json`. An installed app started afterwards gets `other-instance` and does
  not record its own lanes for its whole run.
- **Dev instance killed hard.** If the dev instance is killed with `kill -9`, or crashes, the
  installed app's next launch auto-resumes the dev instance's lanes.

The standing rule is to isolate `OPERATOR_DIR` for dev, so this is low. One line in `dev.mjs`
(default `OPERATOR_DIR` to a dev directory unless set) would close it.

### L5. R2-1 residual: the dispatch launch path still reattaches a released lane's branch

`restoreCwdPlan` covers every `handleRestoreSession` caller: the card, Project Home, ⌘K, the
sidebar, the setting-driven auto-resume and the crash auto-resume, on a launch and on a reload
(`releasedKeysRef` and `pendingMissing` are now set on the reload path too).

It does not cover `handleLaunchRole` → `suspendedToResume` → `handleLaunchSession` with `resume`,
which reattaches a suspended lane's worktree branch by design (task-scoped lanes). Two cases:
- **Retired lanes are covered.** A lane retired by dispatch is excluded through `replacing`.
- **Lifecycle-closed lanes are not.** A lane that called `worktree_done` and was suspended by the
  lifecycle is not excluded, so a later dispatch to that role resumes it on its old branch.

Usually harmless: if the branch was merged and deleted, the fresh branch from base contains the
work. I list it only because the brief asked for "every path".

## Checked and clean (by focus area)

- **(a) False "crashed" verdicts.**
  - Update install: clean when teardown finishes in time (see M2).
  - Teardown timing out on an ordinary quit: `will-quit` waits for the whole teardown, so
    `finish()` runs.
  - A dev instance with its own OPERATOR_DIR uses its own file.
  - First launch: `none`, so the renderer falls back to the snapshot.
  - Stale lock: removed if its pid is gone or it is older than 10 s.
  - A reused pid: caught by the `lstart` comparison (10 s slack); EPERM falls through to `ps`.
  - Force Quit, a macOS restart that kills Operator, and power loss are unclean by design and
    auto-resume. Note that this restarts lanes the user may have force-quit on purpose; that is
    a design choice for the coordinator, not a defect.
  - There is no age limit on an unclean record. A crash followed by a launch a week later
    auto-resumes week-old lanes; consider offering instead of resuming past a few hours.
- **(b) False "clean" verdicts or an empty list.**
  - The renderer crash path does not touch the file.
  - Exits that arrive after the freeze do not change the list.
  - The only empty-list path I found is M1. The open question about macOS logout ordering is
    unchanged.
- **(c) Freeze on every quit path.**
  - QuitGuard's `before-quit` calls `onTeardown()` on both its non-asking and confirmed branches.
  - Tray quit, `window-all-closed` and the updater watchdog call `app.quit()`, which goes through
    `before-quit`.
  - `prepareQuit` and `will-quit` call `teardown()` directly.
  - Every path enters `teardown()`, whose first statement is `lastRun?.freeze()`, before
    `killAll`.
  - The `--mcp-serve` process never runs `boot()`.
- **(d) laneKey plumbing.**
  - All three renderer `terminalSpawn` sites pass it: launch (each fan-out lane gets its own key,
    chosen before the spawn), restore (`saved.key`) and restart (`tab.key`).
  - Scratch shells have no key and are not recorded.
  - Restart is kill then spawn, and a crash between the two drops that lane, as Code notes.
- **(e) The 15 s resync.**
  - Each tick runs one `liveLanes()` pass and one indexed `pendingReleases(pid)` query, and
    writes only when the content changed (`updatedAt` excluded).
  - A `worktree_done` inside the 15 s window before a crash is caught at the next boot by
    `withLateReleases` (`releasesOfRun`). It matches on terminal id and `at >= startedAt`, and
    ignores `cancelled:` outcomes.
- **(f) The crash-loop guard** works as written: the flag is written, survives a crash within
  2 minutes, and is cleared by a timer that is `unref`'d. Its timing is L1.
- **(g) Atomic writes and the lock.**
  - Writes go through tmp + rename, serialized on one chain, and only the owner writes.
  - Before the claim, writes wait on `openedPromise`.
  - Two boots racing: exactly one wins (tested), and the lock is removed in `finally`.
  - A boot that finds the owner running never writes.
- **(h) R2-1.** Closed for every restore path, on a launch and on a reload. See L5 for the
  dispatch-launch path.

## Recommended follow-ups (for the coordinator to assign)

- Code, before release: M1 (main carries unconsumed previous lanes in the new record) and M2
  (write `clean: true` at freeze).
- Code, optional: L1 to L5, plus an age limit on unclean auto-resume.
- QA, GUI check: Code's recipe, plus two cases:
  1. `kill -9` main within a few seconds of a crash-resume launch, then relaunch. Expected after
     the M1 fix: the original lanes are still offered or resumed.
  2. An update install with a slow-dying dev server in a lane. Expected: no "did not quit cleanly"
     toast after the update.
