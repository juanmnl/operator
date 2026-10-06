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
