# Relaunch keeps every project's lanes, and offers them on the overview (2026-10-06)

Branch `operator/d13c40`, from main @ be66384. Implements ranks 1 and 2 of
`dev/results/relaunch-lost-sessions-2026-10-06.md`. Not GUI-verified.

## 1. The snapshot no longer shrinks to one project

Cause (from the research): the restore effect set the carried set from `plan.lanes`, which
`planRestore` filters to the focused project, and the persist effect wrote that subset over
`operator.workspace.liveKeys`. 33 keys across 7 projects became 5 four seconds after launch.

Change:
- `lib/workspace.ts` `carriedLaneKeys(workspace, savedSessions)`: the previous `liveKeys`, unscoped,
  deduplicated, dropping only keys with no saved row. The restore effect carries this, not
  `plan.lanes`. `planRestore` is unchanged and still scoped: it decides where you land.
- `lib/workspace.ts` `snapshotLiveKeys(terminalKeys, pending)`: the persist effect writes this run's
  lanes plus the previous run's lanes not yet resumed or dismissed. Before, it wrote
  "terminals, else pending", so resuming one lane after a relaunch erased the other lanes from the
  snapshot, and a crash right after would lose them. This goes one step past the brief; say if you
  want the old "terminals, else pending" rule back.
- `DashboardView.tsx`: `pendingLaneKeysRef` became `pendingLaneKeys` state (the card renders from
  it). An effect drops a key from it once that lane is live again, from any path (card, sidebar,
  Project Home, auto-resume).
- The reload path where ptys survived used to skip the snapshot entirely and then write only the
  live terminals. It now carries the previous run's unresumed lanes too, so a renderer reload
  between a relaunch and a resume does not drop them.

## 2. A persistent resume card on the gallery overview

- New `components/dashboard/ResumeCard.tsx`, rendered at the top of the overview tab
  (`WorktreeOverview` gained a `lead` slot; `ProjectGallery` gained `resumeOffer`).
- Heading: "Resume N lanes from your last session". Below it, one chip per project with its count,
  most lanes first. One "Resume" button and a dismiss ×.
- The data is `lib/workspace.ts` `previousRunOffer(...)`: the carried keys minus lanes live now,
  oldest first across all projects. Earlier runs' saved rows of the same project are not included.
- The button runs `handleRestoreSession(saved, true, { background: true })` over exactly those
  lanes, sequentially, oldest first. It does not call `handleResumeProject`, which restarts every
  saved row of a project. While running it reads "Resuming i of N…" and the dismiss is hidden. A
  lane that throws is logged and skipped; it stays pending, so the card still offers it.
- Lanes left out are named on a third line: no `claudeSessionId` ("no saved conversation"), or a
  missing folder that cannot be rebuilt ("folder gone"). A worktree lane whose folder is gone but
  that has `worktreeBranch` and `sourceCwd` is offered, because `handleRestoreSession` rebuilds it.
  `planRestore`'s own blocker rule is unchanged, so the reload toast still calls those "folder gone".
- The card stays until every lane is back or it is dismissed. Dismiss clears the pending set, which
  the next snapshot persists; the lanes themselves stay in the sidebar and on Project Home. A
  relaunch before either offers the same lanes again.
- On a launch with carried lanes, the "Where you left off" toast is no longer shown; the card
  replaces it. A reload still gets the toast.
- Auto-resume is unchanged: default off, and when on it still resumes only the focused project
  (`handleResumeProject`). The card then offers the rest.
- Typography: every heading and note goes through `bindLast` (` ` before the last word); the
  dismiss tooltip binds "They stay" after its full stop.

## Tests

`src/renderer/lib/workspace.test.ts`, 8 new:
- a plan for project A leaves project B's carried keys intact
- two relaunches in a row keep every project's lanes (JSON round trip of the snapshot, twice)
- carry drops only keys with no saved row
- resuming one lane keeps the others in the snapshot
- the offer: exact carried lanes, oldest first across projects, per-project counts, no stale rows
- the offer excludes lanes already live, and is null when nothing is left
- the offer names blocked lanes (no conversation, folder gone)
- a worktree lane with a missing folder is still offered

Results:
- `npx tsc --noEmit` (root): exit 0
- `electron/ npm run typecheck` (both tsconfigs): exit 0
- renderer `npx vitest run`: 114 files, 1713 tests passed
- electron `npx vitest run`: 46 files, 811 tests passed

## Not done, on purpose

- Main-process teardown and `appPid` stamping: untouched, per the brief (ranks 4 and 5).
- Renderer auto-reload after a crash (rank 3), last-run.json in main (rank 4), boot-queued
  worktree removals skipping previous-run lanes (rank 7): not in scope.
- On the reload-with-surviving-ptys path the folder check is not run, so the card cannot name
  "folder gone" lanes there; such a lane would fail to spawn and stay offered.
- `liveKeys` still includes this run's ended tabs, as before. The research saw 14 such keys in the
  33; they will be offered after a relaunch if their saved rows exist. Not traced further.

## For the GUI check

1. Run lanes in two or more projects, focus one project, quit, relaunch.
2. The overview shows the card with every project's count. Relaunch again without resuming: the card
   is still there with the same counts.
3. Press Resume: lanes start in the background, oldest first, the overview stays on screen, the card
   disappears when the last one is up.
4. Relaunch, dismiss: the card is gone and stays gone after another relaunch.

## Review fixes (2026-10-06, same branch)

Fixes the findings in `dev/results/relaunch-resume-fix-review-2026-10-06.md`. Not GUI-verified.

### H1. One process per conversation

- New `lib/restore-guard.ts`:
  - `restoreOnce(inFlight, key, isLive, restore)` claims the key for the whole restore and skips
    a lane that is live or already being restored.
  - `laneIsLive` checks for a tab with that key and, for a `--resume`, any alive pty on the same
    `claudeSessionId` from `terminalList()`. That second check also covers a pty the renderer has
    no tab for.
- `handleRestoreSession` runs through it with one shared `restoringKeysRef`. The card,
  `handleResumeProject`, auto-resume, the sidebar and ⌘K all use this path, so they share the
  in-flight set.
- Liveness is checked twice: when the restore starts, and again right before `terminalSpawn`,
  after the folder check, worktree rebuild and project resolve.
- After a spawn, `terminalsRef.current` is updated immediately, so a restore that starts before
  the next render sees the new tab.
- `handleRestoreSession` now returns `'started' | 'skipped' | 'failed'`.
- `handleResumeProject` reads `terminalsRef.current` instead of the `terminals` closure.
- The card is hidden while auto-resume runs (`autoResuming`).

### M1. Lanes that ended before quit are not offered

- Main already computed `selfExit`. It now forwards it:
  - on `onTerminalExit` (main → bridge → `env.d.ts`);
  - in `terminals.list()` (`Managed.selfExit`), so a renderer that reloads after the exit still
    knows.
- The renderer sets `TerminalTab.selfExited` from the exit event, from the 5 s reconcile and on
  re-attach.
- `snapshotLaneKeys` leaves `selfExited` tabs out of `liveKeys`. Tabs ended by the quit stay,
  because `QuitGuard`'s teardown kills them and that is not a self exit. A plain `!ended` filter
  would have written an empty snapshot.
- Released worktrees:
  - The release poll stamps `TerminalTab.releasedWorktree` while the lane runs. The stamp
    survives the pty's end, because main settles the release row on exit.
  - The persist effect writes it to the saved row as `SavedSession.releasedAt`.
  - `previousRunOffer` does not treat such a lane as rebuildable. When its folder is gone it is
    left out as "finished, worktree released".
  - The field is not named `released` because `markReleased` sets that name for routing, and
    routing must read only the open release.

### M2. The offer covers two runs at most

- The snapshot now has three fields:
  - `liveKeys`: this run's lanes.
  - `carriedKeys`: the last run's lanes, not resumed.
  - `olderKeys`: the run before that, not resumed.
- On a relaunch, `carriedLaneKeys` turns `liveKeys` into "last run" and `carriedKeys` into
  "older", and drops `olderKeys`. A lane is offered on at most two launches after it last ran, and
  the set cannot grow.
- A run that started no lanes does not age the offer, so relaunching several times without
  resuming anything keeps the lanes (tested over four relaunches).
- A reload of the same run moves nothing between the fields.
- `planRestore` gets the carried set as its `liveKeys`.
- `launchKind` `'unknown'` counts as a relaunch, so the set cannot grow in that case either.
- Card title: "Resume N lanes from before this launch". The old title, "from your last
  session", is not accurate when the offer spans two runs.

### L1. Forgotten and shelved projects

- `previousRunOffer` leaves out a lane whose `projectId` is missing or not on record ("project
  forgotten"), and a lane whose project has `archivedAt` ("project shelved").
- The left-out line names the lane and its project, e.g. "qa in Shelf (project shelved)".
- Resume therefore never calls `upsertProject(..., intent: 'user')` for those projects.

### L2. Failed spawns are shown

- A lane whose restore returns `'failed'` or throws goes into `resumeFailed`. The card names it
  as "did not start" and the button does not retry it in this run.
- The lane stays pending, so a relaunch offers it again. Dismiss clears the list.

### Tests (12 new or changed)

- `restore-guard.test.ts`, 5 tests:
  - concurrent restores of one lane spawn it once;
  - a lane already live is skipped, and so is one that becomes live mid-restore;
  - the claim is released when the restore throws;
  - `laneIsLive` sees a running pty on the same conversation and ignores exited ones;
  - an unreadable pty list does not block the restore.
- `workspace.test.ts`:
  - M1: a self-exited tab is left out while tabs ended by the quit are kept, and a self-exited
    resumed lane is not owed again; the released worktree is not rebuilt.
  - M2: across runs {A,B} → {C} → {D} → {}, the offers are AB, CAB, DC.
  - Also: reload does not age; four empty relaunches keep the lanes; L1; L2.

Results:
- `npx tsc --noEmit` (root): exit 0
- `electron/ npm run typecheck`: exit 0
- renderer `npx vitest run`: 115 files, 1725 tests passed
- electron `npx vitest run`: 46 files, 811 tests passed

### Left out

- No electron unit test for `selfExit` in `list()`. The existing TerminalManager harness
  (`pty-batch.test.ts`) drives only `spawnShell`, and the lane spawn path needs more setup. The
  change is two lines in `terminals.ts`.
- A lane killed by Operator outside quit (a Close-project kill that timed out) is not a self exit,
  so it is still carried.
- A released lane whose worktree main kept (unsaved changes) still has its folder and is still
  offered. It resumes in that folder and nothing is rebuilt.
- last-run.json: not started, as instructed.
