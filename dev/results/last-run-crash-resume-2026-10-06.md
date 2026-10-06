# last-run.json and crash auto-resume (2026-10-06)

Branch `operator/f67f80` @ ca3e07b, cut from main @ e9b49b9 (which already contains
`operator/d13c40` @ 959f371 and `operator/ae1e80-fix`). Implements ranks 4 and 6 of
`dev/results/relaunch-lost-sessions-2026-10-06.md`, plus review finding R2-1 from
`dev/results/relaunch-resume-fix-review-r2-2026-10-06.md`. Not GUI-verified.

## Rank 4: main writes `~/.operator/last-run.json`

New module `electron/src/main/last-run.ts`. Path is `join(operatorDir(), 'last-run.json')`, so
OPERATOR_DIR isolates it.

Record:

```json
{ "v": 1, "appPid": 1250, "appStartedAt": "…", "clean": false,
  "lanes": [{ "key": "<SavedSession.key>", "terminalId": "t76", "claudeSessionId": "…",
              "projectId": "…", "roleId": "operator", "cwd": "…", "startedAt": "…" }],
  "released": [{ "key": "…", "at": "…" }],
  "crashResumed": true,
  "updatedAt": "…" }
```

Where the set comes from:
- `TerminalManager.liveLanes()`: every pty in main's table with a lane key that has not exited.
  It does not use the `appPid` stamps in sessions.json.
- The durable key reaches main through a new `laneKey` launch option. All three renderer spawn
  sites pass it: launch (the key is now chosen before the spawn), restore (`saved.key`) and restart
  (`tab.key`). Scratch shells have no key and are not recorded.
- `appStartedAt` is the process start time (`now - process.uptime()`).

When it is written:
- `TerminalManager` has a new optional third constructor argument, `onLanesChanged`. It fires on
  spawn, on a pty exit, and when a kill removes a lane. The recorder recomputes and writes only if
  the content changed. Writes are serialized and atomic (tmp file + rename).
- A 15 s timer also re-syncs. worktree_done is recorded by the MCP server in the artifacts store,
  not through main, so nothing else reports it.

Who leaves the list:
- A lane that ended on its own: its pty exited.
- A lane that was closed or retired: the renderer's kill removed it from the table.
- A lane that called worktree_done: it has an open `worktree_release` row for this run. It moves to
  `released`, and stays there after its pty is gone. If new work cancels the release while the lane
  is live, it moves back to `lanes`.

Quit and update install:
- `teardown()` calls `lastRun.freeze()` before anything is killed. The set is taken one last time
  and then stops changing, so the exits from `killAll` do not remove lanes.
- After `killAll` and `releaseLeasesOf`, `lastRun.finish()` writes `clean: true`. It is awaited and
  bounded by the teardown deadline.
- The update install goes through the same `teardown()` (`prepareQuit`), so it counts as clean.

Renderer crash: nothing in `render-process-gone` touches the file. Main and the lanes are still
running.

Same rule as 959f371, not a second one:
- In both, a lane that ended on its own is out and a lane ended by the quit is in. Main applies it
  to its own table (exited = out, frozen at teardown). It is the same `killing`/`selfExit`
  distinction, read where the ptys live.
- The renderer does not get a second definition of "previous run". `withLastRun(stored, previous)`
  puts the file's keys in the snapshot's `liveKeys`, and the existing `carriedLaneKeys` /
  `previousRunOffer` / `planRestore` run unchanged.
- The localStorage `liveKeys` are used only when there is no record: first run with this build,
  another instance owns the file, or the Tauri bridge.
- A reload is the same run, so the snapshot stands there.
- `carriedKeys` and `olderKeys` (the two-run window) still come from localStorage.

Exposed as `window.operator.previousRun()`, which returns `PreviousRunInfo | null`
(`src/shared/types.ts`). The renderer asks once per document (`lib/previous-run.ts`, memoised like
`lib/launch-kind`).

## Rank 6: auto-resume after an unclean end

Boot (main, before the window):
1. Take `last-run.json.lock` with `open(…, 'wx')`. A lock whose pid is gone, or that is older than
   10 s, is stale and removed. A boot that cannot get the lock within 3 s does not record.
2. Read the record and judge it (`judgePreviousRun`):
   - `none`: no file.
   - `clean`: `clean: true`.
   - `unclean`: `clean: false` and the recorded app is not running.
   - `other-instance`: the recorded app is running. That app is the same pid with a `ps -o lstart`
     start time within 10 s of the recorded one; a recycled pid with another start time is not.
     If `ps` fails, the app counts as running, which means no auto-resume.
3. For `unclean`, read that run's `worktree_release` rows (new `ArtifactStore.releasesOfRun`). A
   lane that called worktree_done after the last write is moved to `released`. Cancelled releases
   and rows filed before the lane started (a reused terminal id) are ignored.
4. Write this run's record (claims the file) and release the lock. A racing boot then sees a running
   app and gets `other-instance`.
5. `other-instance`: this run never writes the file and hands the renderer null.

`autoResume` is true only when:
- the verdict is `unclean` and the record has lanes;
- the record does not carry `crashResumed`. That flag is set when this run hands out an
  auto-resume and cleared after 2 minutes, so a crash within 2 minutes of an auto-resume is offered
  on the card instead of resumed again (crash-loop guard, not in the brief);
- this is the first `previousRun()` call of this app run, so a renderer reload cannot resume again.

Renderer (launch restore effect in `DashboardView.tsx`):
- `crashResumeLanes(...)`: empty unless the record is unclean, `autoResume` is true and this is not
  a reload. Otherwise it returns exactly the recorded lanes, oldest first, minus what the card would
  leave out (forgotten or shelved project, folder gone and not rebuildable, released, no
  conversation). Those stay on the card.
- When the list is not empty:
  - toast "Operator did not quit cleanly. Resuming N lanes", with detail "project: lane, lane · …";
  - the lanes go to `runResumeQueue`, the card's own loop, now shared. It runs in the background
    and calls `handleRestoreSession(saved, true, { background: true })` one lane at a time, so it
    goes through the shared restore guard. The card shows "Resuming i of N…", and its button
    cannot start a second pass.
- Otherwise the existing setting path runs unchanged: `operator.resumeOnLaunch`, default off,
  focused project only. After a clean quit, the card only offers the lanes.

## R2-1: no rebuild of a released worktree, on every path

- New `restoreCwdPlan(saved, cwdGone, releasedKeys)` in `lib/restore-guard.ts` returns
  `'as-is' | 'rebuild' | 'released'`. `handleRestoreSession` uses it.
- `'released'` means the folder is gone and the lane released it: `saved.releasedAt` is set, or the
  key is in last-run.json's `released`. The restore then returns the new outcome `'released'` and
  shows a toast: "<lane> finished. It released its worktree with worktree_done, so the worktree is
  not rebuilt."
- Every path is covered because the check is in the restore itself: the card, Project Home, ⌘K, the
  sidebar, setting-driven auto-resume and crash auto-resume.
- `handleResumeProject` restores quietly and shows one summary toast for the finished lanes.
- The card's queue drops a `'released'` lane from the pending set.
- A released lane whose folder main kept (unsaved work) still resumes in that folder.
- `previousRunOffer` takes `releasedKeys` too.
- The reload path now runs the folder check. The card's "folder gone" and "finished" lines are
  therefore also right after a Cmd+R or a crash reload.

## Tests

`electron/src/main/last-run.test.ts`, 20 tests. The lifecycle tests drive the real
`TerminalManager` lane spawn path, with node-pty, the port allocation, the session settings file and
the login shell faked.
- A spawned lane is recorded, with `clean: false`.
- Self-exit: the lane leaves the file.
- Closed (a kill outside quit): the lane leaves.
- killAll at quit: freeze, then killAll, then the exits arrive. The lanes are kept and `finish()`
  sets `clean: true`.
- Crash (no freeze or finish): `clean: false` with the lanes still running at that moment.
- worktree_done: the lane leaves `lanes` and enters `released`. A cancelled release puts it back.
  A released lane stays released after its exit and through quit.
- A scratch shell is not recorded.
- Boot after a crash: `unclean`, and `autoResume` is true once, then false for a reload. Lanes are
  oldest first, and the file is claimed with `crashResumed`.
- Clean quit: offered, `autoResume` false. No file: null.
- Recorded app still running: `other-instance`, and the file is not touched.
- Two boots racing over one crashed record: exactly one gets `unclean` and the auto-resume. No
  lock file is left behind.
- A release after the last write is caught from the store's rows.
- A stale lock from a dead pid does not block the next boot.
- Pure functions: `judgePreviousRun`, `shouldAutoResume`, the crash-loop flag clearing after
  `CRASH_LOOP_MS`, `withLateReleases` ignoring a reused terminal id, and `processIsRunning` with a
  recycled pid, empty `ps` output and a failing `ps`.

The race test ran 8 times in a row after a test-only fix: the first version sorted the verdicts
array in place before reading it.

`src/renderer/lib/workspace.test.ts`, 10 new:
- `withLastRun`:
  - the record replaces `liveKeys`;
  - with no record the snapshot stands;
  - a record with no snapshot still gives an offer;
  - a record with no lanes does not age the offer.
- The clean/unclean decision (`crashResumeLanes`):
  - unclean → exactly the recorded lanes, oldest first;
  - clean → nothing;
  - nothing when main withholds the auto-resume, on a reload, or with no record;
  - the card's blockers apply.
- The toast text binds "Resuming" and "lanes" with non-breaking spaces.
- `previousRunOffer` honours `releasedKeys`.

`src/renderer/lib/restore-guard.test.ts`, 5 new for `restoreCwdPlan`:
- a missing folder is rebuilt;
- the rebuild is refused when `releasedAt` is set;
- it is refused when the key is in last-run.json's `released`;
- a kept released folder resumes as-is;
- a plain lane is spawned as-is.

Results (all on ca3e07b):
- `npx tsc --noEmit` (root): exit 0
- `electron/ npm run typecheck` (both tsconfigs): exit 0
- renderer `npx vitest run`: 115 files, 1740 tests passed
- electron `npx vitest run`: 49 files, 859 tests passed

## Not done, or worth knowing

- No GUI check. For QA:
  1. Run lanes in two projects, then `kill -9` the main Operator process.
  2. Relaunch. Expected: the toast names the lanes, they come back in the background, oldest
     first, and the card shows progress.
  3. Quit normally and relaunch. Expected: the card only, no auto-resume.
  4. Cmd+R right after a crash resume. Expected: no second resume.
  5. A lane that called worktree_done, then quit, relaunch, Cmd+R, Resume. Expected: "finished",
     not rebuilt.
- macOS logout or restart: if the system kills the agents before Operator's `before-quit` runs,
  their exits arrive before the freeze and they leave the list. The review raised the same open
  question for 959f371. Not settled.
- The first run with this build has no record. That launch still uses the localStorage snapshot,
  and auto-resume starts working from the second launch on.
- Restart (`handleRestartLane`) kills and respawns the lane. A crash between the two drops that lane
  from the file. The window is one IPC round trip long.
- A boot that waits more than 3 s for another boot's lock runs without recording its lanes for the
  whole run, and logs it. This happens only with two Operator instances on one OPERATOR_DIR.
- `processIsRunning` uses `/bin/ps -o lstart= -p <pid>` once per boot, and only when a record
  exists.
- Rank 5 (`stampSessionClaims` keyed by terminal id) is untouched. last-run.json does not read
  those stamps, so it does not depend on that fix.
- R2-2 through R2-5 are not addressed.

## Review fixes (2026-10-06)

Review: `dev/results/last-run-crash-resume-review-2026-10-06.md`. Fixed M1, M2, L1, L3, L4, and
added an age limit. L2 and L5 were left as asked.

### M1: the previous run is carried until the renderer has it

- The record has a new optional field, `carried: { lanes, released }`. At boot, `open()` fills it
  with the previous record's lanes and releases, after late releases are applied and after that
  record's own `carried` is merged in (`withCarried`). So a chain of early crashes keeps passing
  the lanes forward.
- Carried lanes are written in every record until the renderer calls the new IPC
  `previousRunTaken`. The renderer calls it once, from the persist effect, after its first
  snapshot write on a launch that received a record. At that point the lanes are either in its
  `liveKeys` (resumed) or in `carriedKeys` (offered). Dismissing the card happens after that write,
  so it is covered by the snapshot.
- A carried lane that comes back in this run moves to `lanes` and is pruned from `carried`
  permanently, so it does not reappear as carried after it exits.
- Auto-resume is tracked per lane with `offerOnly`.
  - Carried lanes are offer-only when the previous verdict did not owe an auto-resume (a clean
    quit, a crash loop, or past the age limit), or once this run has handed the auto-resume out.
  - `shouldAutoResume` requires at least one lane that is not offer-only.
  - `crashResumeLanes` in the renderer skips offer-only lanes, which stay on the card.
- Outcomes when run 2 crashes in its first seconds (tested):
  - before the hand-out: run 3 auto-resumes run 1's lanes;
  - after the hand-out: run 3 offers them, because of the crash-loop flag and offer-only;
  - run 1 quit cleanly: run 3 offers them.
- Left out: a renderer *reload* does not call `previousRunTaken`, because the reload path reads the
  snapshot and not main's record. Main then carries the lanes to the end of that run, so the next
  launch can offer them once more. This only happens when the first renderer died before its
  first snapshot write.

### M2: `clean: true` is written at freeze

- `freeze()` now sets `clean = true` and returns the write. `finish()` is removed.
- `teardown()` awaits the freeze (capped at 1 s, `LAST_RUN_FREEZE_WAIT_MS`) before
  `transcript.stop()` and `killAll`.
- An update install, a logout, or a 4 s teardown deadline that ends the app during `killAll` is now
  read as a quit.

### L1: the crash-loop guard counts from the end of the queue

- Handing out the auto-resume sets `crashResumed` with a fallback limit of 30 min
  (`CRASH_LOOP_MAX_MS`).
- The renderer calls the new IPC `crashResumeDone` when the crash resume queue finishes, or
  straight away when it got the auto-resume but had nothing to resume.
- Main then clears the flag `CRASH_LOOP_MS` (2 min) later.
- The 30 min limit is for a renderer that never reports, for example when it died before running
  the queue (L2).

### Age limit

- An unclean record whose `updatedAt` is more than 24 h old (`RESUME_MAX_AGE_MS`) is offered on the
  card and not auto-resumed. An unparseable `updatedAt` is treated the same way.
- Before this change, the 15 s resync wrote only when the content changed, so a run with the same
  lanes for a week would carry a week-old `updatedAt` and its crash would be read as stale. An
  unchanged record is now rewritten every 10 min (`HEARTBEAT_MS`), so `updatedAt` is within
  10 min of when the run ended.

### L3: `ps` runs with LC_ALL=C

- `psStart` passes `env: { ...process.env, LC_ALL: 'C' }`, so `lstart` parses in every locale.

### L4: dev.mjs and OPERATOR_DIR

- When `OPERATOR_DIR` is unset and a packaged Operator is running (a `ps -axo comm=` line ending in
  `.app/Contents/MacOS/Operator`), `electron/scripts/dev.mjs` sets
  `OPERATOR_DIR=$TMPDIR/operator-dev`, creates it, and prints a line saying so.
- An explicit `OPERATOR_DIR` still wins.
- A dev instance started while the installed app is *not* running still uses `~/.operator`, as
  before. That is the case the brief scoped out.

### Tests

`electron/src/main/last-run.test.ts`, 31 tests (was 20):
- M2: after `await freeze()` and before `killAll`, the file already says `clean: true` with every
  lane.
- M1, 7 new tests:
  - a crash before the hand-out, then auto-resume;
  - a crash after the hand-out, then an offer;
  - a clean quit followed by an early crash, then an offer;
  - `previousRunTaken` drops `carried`;
  - a resumed carried lane is not carried again after it exits;
  - a clean quit before the renderer acked keeps the lanes;
  - released keys are carried.
- `withCarried` merge and dedupe.
- L1: the flag holds through 3× `CRASH_LOOP_MS` while the queue runs, then clears exactly
  `CRASH_LOOP_MS` after `crashResumeDone`. A second test covers the 30 min fallback.
- Age limit:
  - a 24 h + 1 s old unclean record is offered with its lanes, and no `crashResumed` is written;
  - `shouldAutoResume` at exactly 24 h is true and at 24 h + 1 ms is false;
  - an unparseable `updatedAt` gives false;
  - all lanes offer-only gives false.
- The heartbeat: no rewrite at `HEARTBEAT_MS - 1`, and a rewrite at `HEARTBEAT_MS`.
- The boot tests now pin the clock (`now`), because the age limit makes them time-dependent.

`src/renderer/lib/workspace.test.ts`, 1 new: an offer-only lane is not crash-resumed but is still
in the card's carried keys.

Results:
- `npx tsc --noEmit` (root): exit 0
- `electron/ npm run typecheck` (both tsconfigs): exit 0
- renderer `npx vitest run`: 115 files, 1741 tests passed
- electron `npx vitest run`: 49 files, 870 tests passed

Not GUI-checked. The review's two extra QA cases apply:
1. `kill -9` main within a few seconds of a crash-resume launch, then relaunch. Expected: the
   original lanes are offered (or resumed, if the kill came before the hand-out).
2. An update install with a slow-dying dev server in a lane. Expected: no "did not quit cleanly"
   toast after the update.

## Flaky ENOTEMPTY in the full electron suite (2026-10-06)

Symptom: in `cd electron && npx vitest run`, a test in `the previous run is carried until the
renderer has it` failed with `ENOTEMPTY` from `afterEach`'s `rmSync(dir)` (last-run.test.ts:60).
The file alone passed. On this branch's first full run the failing test was `released lanes are
carried too`, not `a crash before the hand-out`. Both have the same cause.

Cause: a test-only leak, not a production write after teardown. Both tests end on
`run3.previousRun()`, and in both the answer is `autoResume: true`. `previousRun()` then marks the
carried lanes offer-only, sets `crashResumed`, and starts the write with `void this.sync()`, which
nothing awaits. The test returns while that write is in flight. `writeFile(last-run.json.tmp)` runs
on the libuv threadpool, so under full-suite load it can create the tmp file while the synchronous
`rmSync` is walking the directory, and the final `rmdir` then finds it not empty. Run alone, the
write usually finishes first. The other tests that get an auto-resume hand-out await a later
`sync()`, `previousRunTaken()` or `owner.sync()`, which chains after it.

Evidence: with timestamps printed at write start, after the tmp write, and in `afterEach`, the old
test file has exactly these two tests with a write started before `afterEach` and its tmp file
written after it (`a crash before the hand-out`: start 93.62 ms, afterEach 93.74, tmp written
94.37). With the fix, none of the 31 tests has a write in flight at `afterEach`.

Production checked, no change needed: teardown clears the 15 s resync interval
(`lastRunTimer`) before `freeze()`, and awaits `freeze()` (bounded by `LAST_RUN_FREEZE_WAIT_MS`).
`freeze()` clears the crash-loop timer and chains its write after any write in flight. After it,
`sync()` and `previousRunTaken()` do not write, and `previousRun()`'s `void this.sync()` is one of
those `sync()` calls. The heartbeat is not a timer: it is checked inside `writeNow`. The lock file
is removed in `withBootLock`'s `finally`, before `open()` returns.

Fix: both tests now end with `await run3.sync()`, the same pattern the other boot tests use for
"the auto-resume note's write".

Results: `electron/ npm run typecheck` exit 0; electron `npx vitest run` 3 times in a row, 49
files, 870 tests passed each time.
