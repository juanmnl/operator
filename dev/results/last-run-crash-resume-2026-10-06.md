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
