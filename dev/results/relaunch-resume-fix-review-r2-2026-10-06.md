# Re-review: relaunch resume fix, round 2 (operator/d13c40 @ 959f371)

Reviewed 2026-10-06 by the Review lane. Diff: `git diff 5e20b1e 959f371` (12 files). First-round
findings are in `relaunch-resume-fix-review-2026-10-06.md`. Read only. No GUI run, and I did not
run the suite (Code reports 1725 + 811 passing).

**Merge:**
- `git merge-tree --write-tree main operator/d13c40` (main @ db7165a): exit 0.
- `git merge-tree --write-tree operator/ae1e80 operator/d13c40`: exit 0.
- The two branches both touch `electron/src/main/index.ts` (d13c40 only adds `selfExit` to the
  `onTerminalExit` broadcast) and `DashboardView.tsx`'s reattach block. The hunks do not overlap,
  and nothing in one depends on the other.

Verdict: H1, M2, L1 and L2 are closed. M1 is closed for lanes that ended on their own, and only
partly for lanes that released their worktree (R2-1). I found no in-flight leak and no empty
snapshot on quit. The restore paths (sidebar, Project Home, ⌘K) still work.

## Status of the first-round findings

| Finding | Status | How it was checked |
|---|---|---|
| H1 double spawn | **Closed** | All four user paths go through the guard (details below). |
| M1 lanes that ended on their own | **Closed** | `selfExit` comes from main's `killing` flag (details below). |
| M1 rebuilding a released worktree | **Partly closed** | Only the card checks it, and only after a launch. See R2-1. |
| M2 accumulation | **Closed** | `carriedLaneKeys` keeps at most two runs; a run with no lanes does not age the offer; a reload moves nothing. The AB → CAB → DC trace in the test matches the code. Title changed. |
| L1 forgotten or shelved project | **Closed** | `blockerOf` returns `project-forgotten` or `project-shelved` before any spawn, so the card never reaches `upsertProject(intent: 'user')` for those lanes. See R2-3 for the wording. |
| L2 failed spawn not reported | **Closed** | `'failed'` or a throw goes into `resumeFailed`, the card names it "did not start", and the card does not retry it in this run. Dismiss clears it. |

**H1 details.** These paths call `handleRestoreSession`, which now runs through `restoreOnce`
with one shared `restoringKeysRef`:
- the card (`:5106`);
- `handleResumeProject` (`:3501`), which covers Project Home, ⌘K "Resume project" and auto-resume;
- ⌘K restore (`:5234`, `:5242`);
- the gallery and sidebar `onRestore` (`:6099`).

Liveness is checked when the claim is made and again right before `terminalSpawn`. That second
check asks main's pty list for a live pty on the same conversation, so it also catches a pty the
renderer has no tab for. `terminalsRef` is updated immediately after a spawn. The card is hidden
while auto-resume runs.

**M1 details.**
- `selfExit = !managed.killing`. `kill()` sets `killing` synchronously, before any signal is sent.
- `killAll` awaits `freshReapSnapshot()` before calling `kill()`, but nothing is signalled during
  that await. A lane killed by the quit therefore reports `selfExit: false`, and the snapshot
  keeps it.
- A restart returns early through `restartedFromRef`.
- The exit event, the 5 s reconcile and the reattach list all carry the flag.
- `snapshotLaneKeys` also removes self-exited keys from `carriedKeys`.

## New findings, most severe first

### R2-1. Resume can still rebuild a released worktree after any reload, and from Project Home or ⌘K (Medium, confirmed by reading)

The `released` blocker in `previousRunOffer` applies only when
`missingPaths.has(s.cwd) && s.releasedAt`. `missingPaths` comes from `pendingMissing`, and that is
filled only on the launch path (`DashboardView.tsx:5043`). The reload branch of the restore effect
(ptys survived) sets `pendingLanes` but never runs the folder check.

Failure scenario:
1. The app is relaunched. The card correctly lists lane X under "finished, worktree released".
2. The renderer then reloads. On main @ db7165a this happens automatically on a crash, or the
   user presses Cmd+R.
3. `pendingMissing` is now empty, so X is counted as resumable.
4. Resume calls `handleRestoreSession`, which sees the cwd is gone and the row has
   `worktreeBranch` and `sourceCwd`, and calls `worktreeCreate(sourceCwd, branch)`.
5. If the branch was merged and deleted, `reattachWorktree` returns null and `createWorktree`
   makes a fresh `operator/<new>` branch. The lane resumes its conversation in a tree with none
   of its work. This is the case first-round M1 was about.

The same rebuild is reachable without a reload, from:
- Project Home "Resume N agents" / ⌘K "Resume project": `handleResumeProject` restores every
  saved row of the project that is not live, released ones included;
- ⌘K or sidebar restore of that row.

The exclusion lives only in the card's offer, not in `handleRestoreSession`.

The opposite worry, that the exclusion hides lanes it should offer, does not hold. It blocks a
lane only when its folder is gone *and* the lane released it. A released lane whose worktree main
kept (unsaved changes) still has its folder and is offered, as Code's notes say. The stamp is
removed again when typed work cancels the release (the poll recomputes it for running tabs) and
when the lane is restored (the new tab has no stamp, so the persist effect drops `releasedAt`).

Recommendation (Code): make `handleRestoreSession` refuse to rebuild a worktree for a row with
`releasedAt`. Return `'failed'` or a new `'released'` outcome, with a toast. Then every path is
covered and the card no longer depends on `pendingMissing`. Running the folder check on the reload
path too would also fix the card's "folder gone" line after a reload.

### R2-2. A restore the user asked for that is skipped gives no feedback (Low)

Sidebar, ⌘K and Project Home now get `'skipped'` back when:
- the lane is being restored by another path; or
- a live pty is already running its conversation. That pty may have no tab, for example an
  unlabelled pty the reconcile has not stamped yet.

Nothing is shown in either case, so a click on Restore just does nothing. Before this branch that
click started a duplicate, so the new behavior is the right one, but it should say why. Suggest a
toast naming the reason, and, when a pty is running the conversation, a way to switch to it.

### R2-3. A lane with no project id is labelled "project forgotten" (Low)

`blockerOf` returns `project-forgotten` whenever `s.projectId` is missing. A forgotten project's
rows do lose their `projectId`, but so does any saved row of a lane that was never scoped to a
project:
- a legacy row;
- a lane whose folder the cwd-resolution effect could not resolve.

Those lanes are left out of Resume under a false reason. Leaving them out is still the safe
choice. Only the label is wrong; "no project" would be accurate.

### R2-4. A reload carries this run's own lost tabs into "from before this launch" (Low)

On the reload path, `carriedLaneKeys(..., { relaunch: false, live })` puts the snapshot's own
`liveKeys` that did not reattach into `lastRun`. A tab in this run whose pty main no longer holds
ends up there, for example a Close-project kill that timed out (its tab is marked ended but its
row is kept) or a restart whose spawn failed. The card then lists it as being from before this
launch, which is wrong, though resuming it is harmless.

### R2-5. The claim is keyed by saved-row key, not by conversation (Low, residual)

`restoreOnce` claims `saved.key`. Two saved rows that share a `claudeSessionId`, restored
concurrently by two paths, can both pass the pre-spawn check: the transcript identity is
registered only when `terminalSpawn` returns, after a version read of up to
`SPAWN_VERSION_WAIT_MS`. The launch path's resume of a suspended row (`handleLaunchSession` with
`resume`) neither claims nor checks.

Rows in the card's pending set are never suspended: the persist effect rewrites a live tab's row
without `suspendedAt`. Dispatch routing also finds the new tab through `terminalsRef`. Both
windows are therefore narrow. Claiming the conversation id as well as the key would close this.

## Regression checks requested

- **Can a key stay stuck in-flight?**
  - `restoreOnce` releases the key in `finally`, so a throw releases it (tested).
  - The only way to hold it is an IPC that never settles: `pathExists`, `worktreeCreate`
    (including dependency cloning), `resolveProject` or `terminalSpawn`. The app is wedged in that
    case anyway.
  - The set is renderer memory, so a reload or crash recovery clears it.
  - Quit has no effect on it.
- **Can the `selfExit` logic write an empty or wrong snapshot on a normal quit or a crash?**
  - Normal quit: no. See the M1 details above.
  - Renderer crash: the reattached tabs get `selfExited` from `list()`, and ptys that exited
    earlier stay in main's map, so they keep their flag.
  - Main crash or force quit: the renderer dies with main and the last snapshot stands.
  - Not verified: a macOS logout or restart where the system signals the agents before
    Operator's teardown has set `killing`. Those lanes would be recorded as self-exited and not
    offered. I could not settle the ordering by reading.
- **Does the `worktree_done` exclusion hide lanes that should be offered?** No; see the last
  paragraph of R2-1.
- **Sidebar, Project Home and ⌘K restore paths after the DashboardView rewrite.**
  - The body of `handleRestoreSession` is unchanged inside the guard. The return type changed to
    `Promise<RestoreOutcome>`, the `onRestore` prop still typechecks, and the callers ignore the
    value.
  - `handleResumeProject` reads `terminalsRef.current` and no longer has `terminals` in its deps.
  - The key check in `laneIsLive` includes ended tabs. That matches what every path already
    excluded (`restorableSessions`, the `handleResumeProject` filter, the offer's `liveKeys`), so
    no path that used to restore is now blocked.
  - `autoResuming` is cleared in `.finally`, so a throw cannot leave the card hidden.

## Recommended follow-ups (for the coordinator to assign)

- Code: R2-1 before merge. Refuse the rebuild for `releasedAt` rows inside `handleRestoreSession`.
- Code: R2-2 to R2-4 can follow. R2-5 is optional.
- QA, GUI check: on top of Code's recipe, a lane that called `worktree_done` and was quit, then
  relaunch, Cmd+R, and press Resume. Expected: the released lane is not rebuilt.
