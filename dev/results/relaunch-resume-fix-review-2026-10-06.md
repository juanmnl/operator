# Review: relaunch keeps every project's lanes + ResumeCard (operator/d13c40 @ 5e20b1e)

Reviewed 2026-10-06 by the Review lane. Diff: `git diff main...operator/d13c40` (merge base be66384).
Line numbers below are from the branch's files. Read only. No GUI run, and I did not run the
suite on the branch.

**Merge:** `git merge-tree --write-tree main operator/d13c40` against main @ db7165a (renderer
crash recovery) exits 0, so it merges cleanly. The two branches touch different files.

Verdict: the snapshot fix (`carriedLaneKeys`, which stops the 33→5 shrink) is correct. The card's
Resume button needs two fixes before merge. As written it can start a second process on a
conversation that is already running (H1), and it restarts lanes that had already ended in the
previous run (M1).

## Findings, most severe first

### H1. Resume can start a second process on the same conversation (High, confirmed by reading)

- `DashboardView.tsx:5036-5050` `resumePreviousRun` takes `resumeOffer.resumable` once, when the
  button is clicked. It then awaits `handleRestoreSession` for each lane without checking whether
  that lane has become live in the meantime.
- `handleRestoreSession` (`:3347`) does not check liveness either.
- `handleResumeProject` (`:3449`) reads `terminals` from its closure as it was when it was created,
  so it has the same blind spot in the other direction.
- Each restore takes seconds: `pathExists`, possibly `worktreeCreate`, `resolveProject`, then
  `terminalSpawn`, which itself waits on a Claude Code version read. A 20-lane run is therefore
  open for a minute or more.

Failure scenarios:
1. **User restores from elsewhere during the run.** The user clicks Resume on the card (20 lanes).
   While it runs they open project B's Project Home and press "Resume N agents", or restore one of
   B's lanes from the sidebar or ⌘K (`restorableSessions` lists every saved row that is not live,
   `:4591`). When the card's loop reaches those lanes, it spawns them again. The result is two
   `claude --resume <same id>` processes writing to one conversation, and two tabs with the same
   `key`.
2. **Auto-resume is on.** At launch `handleResumeProject(settled.projectId, { background: true })`
   (`:5012`) starts the focused project's lanes one at a time, and the card is on screen at the
   same moment. Clicking Resume before auto-resume finishes includes the focused project's
   not-yet-started lanes, so both loops spawn them.

Worktree effect, for a lane whose folder is gone:
- If the second restore reads `pathExists` after the first restore rebuilt the folder, it spawns
  into the same worktree: two agents in one checkout.
- If it reads it before, its `worktreeCreate` → `reattachWorktree` finds the path already there
  (`electron/src/main/worktree.ts:265`) and returns null. `createWorktree` then makes a fresh
  `operator/<new>` branch from base, and the duplicate resumes the conversation in a tree without
  its own commits. That is the outcome the `reattachWorktree` comment calls "worse than a cold
  start because it looks correct".

A lane in the main checkout has no worktree. Its duplicate shares the same `cwd`, and with it the
dev port (`portsByCwd`).

Recommendation (Code): just before each spawn, re-check against `terminalsRef.current` (by key,
and by `claudeSessionId` against the live list), skip a lane that is already live, and share one
in-flight set between the card, `handleResumeProject` and `handleRestoreSession`. Hide or disable
the card while auto-resume is running, or have the card wait for it.

### M1. The card offers, and Resume restarts, lanes that had already ended in the previous run (Medium, confirmed by reading)

How ended tabs get into `liveKeys` (this answers the open question in Code's notes and in the research):
1. `onTerminalExit` (`DashboardView.tsx:621-637`) marks the tab `ended: true` and leaves it in
   `terminals` on purpose, so the last frame stays on screen. It leaves only when the user
   dismisses it (Cmd+W / sidebar close / the "ended" overlay), which goes through
   `handleCloseSession` and forgets the saved row.
2. The workspace snapshot writes `terminals.map((t) => t.key)` with no `ended` filter (`:4906`),
   which was already true before this branch.
3. The saved row keeps its `claudeSessionId`: the persist effect (`:4137-4175`) writes `hook?.id`,
   and main's `transcript.sessions()` returns ended tracks too (tracks are never deleted,
   `transcript.ts:724`).
4. At the next launch, `carriedLaneKeys` keeps the key because the saved row exists, and
   `previousRunOffer` classes it as resumable because it has a conversation.

Which lanes are and are not affected:
- **Closed by the user** (■, Close project): not offered, because the saved row is forgotten.
- **Retired, or auto-closed after `worktree_done`**: not offered, because `handleCloseSession` with
  `suspend` removes the tab.
- **Ended on its own and not dismissed** (the user typed `/exit`, Claude Code crashed or exited, a
  Close-project kill that timed out): offered, and Resume restarts it with `--resume`. Code's
  notes cite 14 of the research's 33 keys as this kind.
- **Ended on its own after `worktree_done`**: main removed its worktree at exit
  (`releaseWorktreeOnExit`). `previousRunOffer` still counts it as resumable because it has
  `worktreeBranch` and `sourceCwd` (`workspace.ts:280`). Resume then rebuilds the worktree of a
  finished task. If that branch has since been merged and deleted, `reattachWorktree` returns
  null and `createWorktree` creates a fresh branch (`worktree.ts:259-299`). The lane then resumes
  on a new branch with none of its work.

The old focused-project toast had the same input, but it only offered, and it was scoped to one
project. The card adds a single button that restarts all of these across every project.

Recommendation (Code):
- Exclude tabs from the snapshot that ended before quit started. A plain `!t.ended` filter is
  wrong on its own: `QuitGuard`'s `before-quit` runs teardown before the window closes
  (`electron/src/main/quit.ts:127-129,189`), so every tab is marked ended while the window is
  still alive. A filter would write an empty snapshot on every quit. Options: freeze the snapshot
  when `onQuitRequested`/teardown begins, or record per tab whether it ended by itself (main
  already computes `selfExit` and does not send it).
- Separately, `previousRunOffer` should not treat a lane as rebuildable when its worktree was
  released by `worktree_done`.

### M2. Lanes accumulate across runs until the user dismisses them, under a title that says "your last session" (Medium-low, confirmed by reading)

`snapshotLiveKeys` writes this run's tabs ∪ the pending set (`workspace.ts:233`). The pending set
loses a key only when:
- the lane becomes live again (`:4859-4863`),
- the saved row is forgotten, or
- the card is dismissed.

Scenario:
1. Run 1 ends with A and B live.
2. Run 2: the user ignores the card and works in C. Snapshot = {C, A, B}.
3. Run 3: the card says "Resume 3 lanes from your last session" and includes A and B, which were
   not in the last session.
4. Repeat. The set grows with every lane that was ever live (or ended without being dismissed),
   bounded only by `sessions.json`, which shrinks only on a user close or the duplicate prune.
   Resume then restarts all of it, oldest first.

The other half of the question:
- Dismiss does clear the pending set. `setPendingLaneKeys([])` (`:6030`) re-runs the persist
  effect, which writes `terminals` only.
- It also survives a crash reload: after the merge with db7165a, the reload path recomputes
  pending as `liveKeys − reattached`, and `liveKeys` no longer contains the dismissed keys.

Code's notes call the union a deliberate step past the brief. What I am flagging is the
consequence: the card's wording and count stop matching what was running, and the set only
shrinks when the user acts.

Recommendation (Code): mark pending keys with the run they came from, and expire them after one
relaunch, or keep only `last run ∪ still-pending-from-last-run` without growing further. At
minimum, change the title so it does not say "last session".

### L1. Resume brings back a project the user forgot (Low, confirmed by reading)

Forgetting a project keeps its saved rows with `projectId: undefined` (`:1192-1194`). If the
project's lanes were live or ended-but-not-dismissed, their keys stay in the snapshot, and the
card offers them under the folder name.

`handleRestoreSession` calls `upsertProject(proj, { intent: 'user' })`, and a `user` upsert
cancels a forget (`:976-980`). One click on Resume therefore restores a forgotten project, now
with an empty roster, without the user having chosen anything about that project. The same
applies to a shelved project: its shelf is lifted and the "back on Active" toast appears.

Recommendation: leave lanes of forgotten or shelved projects out of the card, or name them on
the "left out" line.

### L2. A spawn that fails during the run is not reported and is retried silently (Low)

`handleRestoreSession` returns without throwing when `terminalSpawn` returns null (`:3401`), so
the loop's `catch` never sees it, and nothing tells the user. The lane stays pending and the
card offers it again with the same count.

A worktree lane that failed this way has already had its worktree rebuilt. On the next try
`pathExists` is true, so it spawns into it. That is harmless, but the card never says anything
failed.

### Quit during a resume run (checked, no defect)

The loop dies with the renderer. Every persist writes `terminals ∪ pending`, so lanes already
started are in the snapshot as tabs, and the rest are still pending. The next launch offers the
rest. A worktree rebuilt by a restore that had not spawned yet stays on disk. The next restore
finds it (`reattachWorktree` uses a deterministic path, `${project}-${branchSuffix}`) and spawns
into it.

## Checked and clean

- **The 33→5 shrink.**
  - `carriedLaneKeys` is unscoped and deduplicated, and drops only keys with no saved row.
  - `planRestore` stays scoped, so "where you were" is unchanged.
  - The restore effect now carries the unscoped set (`:4964`), and the folder check now covers
    every carried lane.
- **Reload with surviving ptys after the merge (crash recovery path), (d).**
  - The reload branch (`:4929-4938`) runs after reattach. Reattach calls `setTerminals` in
    `.then` and `setReattachDone` in `.finally`, so `terminals` already holds the reattached
    tabs when the effect reads it.
  - Pending = previous `liveKeys` − reattached keys.
  - Main keeps ptys that exited on their own in its list (`terminals.ts:369-375` sets `exited`,
    and only `kill` deletes the entry). Ended tabs therefore reattach too and are not offered.
  - Reattach keys are matched through `transcript.identity` (`ipc.ts:183`). It carries the
    spawn-time session id, which is the `--resume` id for restored lanes (`ipc.ts:137-176`),
    and the saved row stores the same id.
  - The one gap: a lane spawned within about a second of a crash may not have its
    `claudeSessionId` in the saved row yet. Its true key then shows up as pending, but
    `previousRunOffer` classes it as "no saved conversation" and the button skips it. It is not
    offered for resume, only named on the "left out" line.
  - The card does not offer a lane that is already live.
- **The effect that drops pending keys** (`:4859-4863`) drops a key once the lane is live from
  any path. A lane that is resumed and then suspended or closed does not reappear as "last
  session".
- **The toast.** Suppressed only on a launch with carried lanes, which always lands on the
  overview where the card is. A reload still gets it.
- **Typography.** `bindLast` binds the last two words of every heading and line. The tooltip binds
  "They stay" after its full stop.

## Recommended follow-ups (for the coordinator to assign)

- Code: fix H1 (skip lanes that are already live, one shared in-flight set) and M1 (keep tabs that
  ended before quit out of the snapshot; do not rebuild worktrees released by `worktree_done`)
  before merge.
- Code: M2 and L1 can follow.
- QA, in the GUI check: Resume plus Project Home "Resume agents" during the run, and a lane
  `/exit`ed before quit.
