# Worktree cleanup, stage 1 (2026-09-16)

Commit `33534dd` on branch `operator/worktree-cleanup-stage1`, created from `main` at `c463d90`
(worktree `~/.operator/worktrees/operator-230fc0`). It does not include the earlier
`operator/230fc0` commits (hidden-pane terminal fix, Plan tab).

Not GUI-verified. Nothing was removed on this machine. The real-disk numbers below come from a
read-only dry run (no provenance written, no size cache written, `GIT_OPTIONAL_LOCKS=0`).

## What the user decided, and where each decision lives

| Decision | Implementation |
|---|---|
| Operator removes worktrees itself | Manual removal in Settings (`removeSelected`); automation is report-only this stage |
| Never remove unsaved work without asking | `unsavedWorkOf` / `needsUnsavedConfirm`; second confirmation in the UI; `removalDecision` refuses in main without it |
| Unsaved = uncommitted changes, or commits not reachable from another branch or remote | `uncommittedCount` (porcelain lines) and `unsavedCommits` (`git rev-list --count HEAD --not --exclude=<branch> --branches --remotes`) |
| Branch is kept | Every path removes the directory only; no `branch -D` added |
| 24h grace for unclaimed clean worktrees | `AUTO_REMOVE_GRACE_MS`, used by `wouldAutoRemove` |
| Automation report-only | `AUTO_REAP_ON_TRIGGERS` untouched (`false`); `checkAutoRemoval` has no removal in it |

## What changed

### 1. Settings → Worktrees (`WorktreesSection.tsx`, `src/renderer/lib/worktree-groups.ts`)

- Directories are grouped by source repo: the provenance record, or failing that the directory's
  own `.git` pointer. Directories with neither go in "Unknown source repository", which is always
  listed last. Each group header shows a select-all checkbox (indeterminate when partly
  selected), the folder count and the group size.
- Each row has a checkbox, the directory name, a second line with class and unsaved state
  ("1 uncommitted file · 2 commits on no other branch or remote", "No unsaved work", or "Unsaved
  work unknown — git cannot read it"), branch and size. Rows with a live lane have a disabled
  checkbox, and select-all skips them.
- "Remove selected (N, size)" opens a confirm listing each folder, its size and its unsaved
  state. If any selected row has unsaved or unknown work, "Continue" leads to a second step that
  lists only those rows. That step offers "Remove all N, including unsaved work" or "Remove only
  the M without". Main re-gathers facts before acting (`removeSelected`), so a lane opened or work
  written since the page loaded is still caught: live rows are refused, and unsaved rows are
  refused unless their path was in the confirmed list.
- The existing "Remove N safe worktrees" button (reaper auto tier) is unchanged. See risk 2.
- New top section "Would remove automatically" (see 5).

### 2. Provenance backfill (`backfillProvenanceAtBoot`, `backfillRecords`, `provePairing`)

At boot, for each project path in `projects.json`: `git rev-parse --path-format=absolute
--git-common-dir`, then `git worktree list --porcelain` on the repo. A record
(`createdBy: 'backfill'`, `createdAt` = directory birth time) is written only when all of these
hold:

1. git lists the directory, and it is a direct child of `~/.operator/worktrees`;
2. the directory has no record yet;
3. its `.git` is a regular file whose `gitdir:` resolves to a direct child of
   `<common-dir>/worktrees`;
4. that admin entry's `gitdir` file points back at `<dir>/.git`.

Step 4 is the check a copied `.git` file cannot pass. Anything that fails a step stays
`unattributed` and manual-only. Records use the same path form `createWorktree` writes. A
real-git test caught that git's resolved form (`/private/var/…`) never matched the lookup.

### 3. `dead-source-repo` removal

`removalDecision` returns `plain` when no existing source repo can be named. `removePlainDirectory`
(worktree.ts) refuses anything that is not a direct child of the worktree root, applies
`dangerousRemovalReason` and the nested-checkout walk, then moves the directory to the trash. No
git is involved. Because git cannot read these directories, their unsaved state is "unknown", so
they always need the second confirmation.

### 4. Every removal through trash + background sweep (`worktree-trash.ts`)

The Tauri backend had this; the Electron port never did, so it is ported here in trimmed form.
`removeWorktree` keeps its guard and nesting checks unchanged. It then renames the directory into
`~/.operator/worktrees/.operator-worktree-trash/wt-<ms>-<8hex>`, runs `git worktree prune` on the
source repo, and schedules the sweep. `git worktree remove` and its `--force` fallback are gone.
Every caller goes through this: lane close (`removeWorktreeDurably`), pending-removal drain, the
reap button, merge, discard, and manual removal. The sweep deletes only entries matching the
generated name pattern, one at a time, at most 200 per run, coalescing bursts. Boot starts a sweep
so entries left by a crash are finished. `gatherFacts` skips the trash directory.

### 5. Report-only triggers (`checkAutoRemoval`, `wouldAutoRemove`)

- **Triggers:** boot (end of `reconcileAtBoot`); a lane pty exiting without Operator killing it
  (`ExitSink` gained `selfExit`, from `!managed.killing`; plain shells pass `false`); and a task
  marked done (`setTaskStatus` in DashboardView → `worktreeAutoRemovalCheck('task-done')`). Runs
  are coalesced: at most one in flight and one queued.
- **Rule:** provenance (created or backfilled), no live lane, no guard refusal, and either
  (a) clean with 0 unsaved commits and `lastActivityAt` older than 24h, or (b) git-orphaned: the
  source repo exists, git no longer lists the directory, and the admin entry its `.git` names is
  gone. `lastActivityAt` is the newest of provenance creation, HEAD commit time, and
  `lastActiveAt` of any saved session in that directory. Merge state is not a condition, because
  with no unsaved commits nothing exists only in the directory and the branch is kept.
- **Output:** the result goes to `~/.operator/worktree-auto-check.json` (trigger, time, entries)
  and a `[reap] … REPORT ONLY` log line. The page shows the live list plus the last check. Nothing
  deletes it.

### 6. Size cache

`~/.operator/worktree-sizes.json` stores bytes and directory mtime. A visit runs `du -sk` (one
call, no shell) only for directories whose mtime changed or that have no entry. "Refresh sizes"
re-measures everything. A directory's mtime changes only when a direct child is added, removed or
renamed, so growth deep inside (e.g. `node_modules`) is not noticed until a refresh.

## Real disk, read-only dry run (2026-09-16)

58 directories. `sessions.json` lists 8 of them as live: mantel ×3, operator ×4, uwazi_app ×1.

| Class | Before backfill | After backfill |
|---|---|---|
| unattributed | 34 | 0 |
| merged-dirty | 11 | 39 |
| unmerged | 0 | 6 |
| live-claimed | 8 | 8 |
| debris | 5 | 5 (see risk 1) |

- All 34 unattributed directories pass the pairing proof.
- The reaper auto tier grows from 16 to 44 directories.
- **Would remove automatically: 0.** Only 3 directories are fully clean. 55 of 58 need the
  unsaved-work confirmation; 5 of those are unknown (git cannot read them).
- The unsaved work is mostly trivial: 12 directories have one modified `CLAUDE.md` and nothing
  else, and 2 have only an untracked `node_modules` symlink. Only 4 directories have commits on no
  other branch or remote. For stage 2, whether a lone `CLAUDE.md` change counts as unsaved decides
  whether the automatic rule ever removes anything here.
- Groups: operator 19, el-encanto 17, mantel-landing 8, uwazi_2026 4, web27 4, mantel 3,
  Operator-landing 1, uwazi_app 1, `.tmpIBNq7t` 1.

## Tests and results

New tests:
- `worktree-reap.test.ts`:
  - worktree-list parsing;
  - pairing proof: absolute and relative gitdir, copied `.git`, non-direct admin child, missing
    files;
  - backfill filtering, and classification before/after backfill (unattributed → merged-clean or
    unmerged);
  - unsaved-work check: clean, dirty, unsaved commits, unknown;
  - would-remove rule: grace, no merge requirement, live, guard, no provenance, orphaned with and
    without repo, not in the auto tier;
  - manual removal decision: live refused even when confirmed, confirmation gate, git vs plain
    path, guard;
  - stale size paths;
  - trash entry name pattern.
- `worktree.test.ts` (real git, inside a temp `OPERATOR_DIR` sandbox):
  - removal lands in the trash, prunes git's record and keeps the branch;
  - a dirty worktree is removed;
  - plain removal refuses paths outside or nested under the root;
  - plain removal takes a git-less directory;
  - gathered facts count uncommitted files and unsaved commits, and a commit held by another
    branch reads as saved;
  - backfill writes one record for a real paired worktree, and a second run writes none.
- `worktree-groups.test.ts`: grouping order, counts and sizes; the unknown group last; live rows
  never selected; select-all toggle scoped to its group; selection pruning; unsaved labels.

The `--exclude` form was checked against the installed git (2.54.0) in a scratch repo:
`--exclude=refs/heads/<branch>` excludes nothing under `--branches` and counted every commit as
saved; `--exclude=<branch>` gave 1 / 0 / 0 / 1 for the four cases. The real-git test now covers
this.

Results (with the main checkout's `node_modules` and `electron/node_modules` symlinked in, then
removed):
- Root `tsc --noEmit -p .`: pass.
- `electron` `tsc -p tsconfig.json` and `tsc -p tsconfig.renderer.json`: pass.
- Electron suite: 32 files, 593 passed, 0 failed.
- Renderer suite (`vitest run src/renderer`): 82 files, 1254 passed, 0 failed.

## Risks and open items for stage 2

1. **Existing classifier bug, not fixed: `debris` without sizes.** `classify` treats a git-invalid,
   unattributed, unregistered directory of ≤2 MB as debris. When sizes are not collected, every
   `sizeBytes` is 0, so the 4 `uwazi_2026-*` directories (dead source repo, ~0.46 GB) read as
   debris in the boot and quit plans. Debris is in the auto tier. Harmless while
   `AUTO_REAP_ON_TRIGGERS` is false and the Settings button collects sizes, but it must be fixed
   before any trigger is armed. The new would-remove rule does not use the class, so it is not
   affected.
2. **"Remove N safe worktrees" after backfill.** Its tier grows from 16 to 44, 39 of them
   merged-dirty. It runs `commitAll` and then removes. Nothing is lost (the WIP commit is on the
   kept branch), but by the user's definition that commit is unsaved, and the button's single
   confirm does not list it per folder. Options: route the button through the same two-step
   confirm, or drop merged-dirty from its tier. Left unchanged here.
3. **`removeWorktree` no longer refuses a dirty tree first.** The old non-force attempt refused
   when there were uncommitted changes, but the `--force` fallback then removed the directory
   anyway, so the outcome was already the same. Callers that must keep changes commit first or ask.
4. **`git worktree prune`** — *corrected by the Review follow-up below; the original claim was
   wrong.* A bare prune expires every record whose directory is missing right now; `gc` waits
   `gc.worktreePruneExpire` (3 months). It deleted the record, index, HEAD and reflog of a worktree
   on an unmounted disk. Removal now deletes only its own admin entry (commit `4712abc`).
5. **Trash port is trimmed.** There is no sibling-root fallback and no registry. If the rename
   fails (e.g. across volumes), removal fails and nothing is deleted in place. All Operator
   worktrees live under `~/.operator/worktrees`, on the same volume as the trash.
6. **Boot sweep deletes.** It deletes only trash entries a removal already put there, so it is not
   new automatic removal. Say so if even that should wait.
7. **Orphaned rule requires provenance.** Pre-provenance orphans cannot be backfilled (git no
   longer lists them), so they stay manual. The orphan rule removes a directory git cannot read,
   so its uncommitted files cannot be counted. That goes against "never remove unsaved work" and
   needs a decision before stage 2 arms it.
8. **Live claims** still come from `sessions.json` (a floor, not a process check), unchanged.
9. **Would-remove list is empty on this machine today**, mainly because of the `CLAUDE.md`-only
   changes described above.

---

## Follow-up (2026-09-16): risks 1, 2 and 7

Commit `822c305` on `operator/worktree-cleanup-stage1`.

### Risk 2 fixed: merged-dirty is out of the "Remove N safe worktrees" tier

- `isAuto` now admits `debris`, and `merged-clean` only when `unsavedWorkOf(f).any` is false.
  `merged-dirty` is never automatic. Those folders are removed only through per-row selection and
  the second confirmation.
- `reap()` no longer runs `commitAll`. Right before each removal it runs `git status --porcelain`
  again. A folder that gained changes since the plan (or that git can no longer read) is skipped
  and reported in `failed`, not committed and removed.
- `ReapEntry.needsCommit` is removed: nothing automatic commits any more. The class sentence for
  merged-dirty and the button's confirm and tooltip text now say this.
- Real disk, read-only dry run: the button's tier is **1** (the `.tmpIBNq7t` leftover) before and
  after backfill, instead of 16 → 44.

### Risk 1 fixed: debris no longer depends on sizes being collected

- `WorktreeFacts.sizeUnknown`: `classify` never calls a folder debris when its size is unknown.
- `gatherFacts` measures only the debris candidates (git-invalid, no provenance, unregistered)
  with one `du` call when sizes were not collected, or when the full `du` missed one. A size it
  still cannot read stays unknown, so the folder falls through to `dead-source-repo` or `corrupt`.
- Real disk, no sizes (the boot/quit path): the 4 `uwazi_2026-*` folders now read as
  `dead-source-repo`, not debris, and are not in the auto tier. Debris is 1 (`.tmpIBNq7t`).
- Existing and unchanged: `reap()` refuses to remove a debris entry because debris has no source
  repo (`no source repo recorded`). The button can list debris but not remove it. Manual removal
  (plain directory path) can.

### Risk 7 answered (no code, per the brief)

Decision: the orphan rule stays OFF for folders whose unsaved state cannot be read. Those folders
are shown for manual removal only, with the second confirmation, because their unsaved state is
"unknown".

**The code does not match this yet.** `wouldAutoRemove` still returns a reason for an orphaned
folder even though git cannot read it (`orphaned && sourceRepoExists`). So such a folder would
appear under "Would remove automatically" (report only; nothing removes it). On this machine it
matches nothing today. Making the code match is a one-line change (drop the orphan branch, or
require `unsavedWorkOf(f).known && !any`, which an orphan never meets). I left it out because the
brief said no code for risk 7. It should land before Review signs off on the report list, or
before stage 2.

### Tests and results

- `worktree-reap.test.ts`:
  - "puts merged-clean and debris in auto, and nothing else" (merged-dirty is now an ask);
  - a merged folder with uncommitted changes is not auto and needs the unsaved confirmation;
  - merged-clean with unsaved commits is not auto;
  - the audit snapshot (auto = debris + merged-clean; asks = merged-dirty + dead-source-repo);
  - **the four `uwazi_2026-*` in their real shape with no sizes are `dead-source-repo`, and the
    plan's auto tier and would-remove list are empty.** This test classifies all four as debris
    without the fix.
  - an unmeasured git-invalid folder with a live repo is `corrupt`; a measured 8 KB leftover is
    still debris.
- `worktree.test.ts` (real disk, temp `OPERATOR_DIR` sandbox): `reap({ dryRun: true })`, exactly
  what boot and quit call. A dead-repo folder with a 3 MB file is measured, classified
  `dead-source-repo`, and not in auto. A one-file leftover is debris. Nothing is removed.
- Root `tsc --noEmit -p .`: pass. `electron` `tsc -p tsconfig.json` and
  `tsc -p tsconfig.renderer.json`: pass.
- Electron suite: 32 files, 598 passed, 0 failed.
- Renderer suite (`vitest run src/renderer`): 82 files, 1254 passed, 0 failed.
- Run with the main checkout's `node_modules` and `electron/node_modules` symlinked in, removed
  after.

---

## Review follow-up (2026-09-16): H1, M1, M3, M4, L1, L2, L5, L7

Commit `4712abc` on `operator/worktree-cleanup-stage1`. Review:
`dev/results/worktree-cleanup-stage1-review-2026-09-16.md`. All tests ran in temp `OPERATOR_DIR`
sandboxes. Nothing under `~/.operator/worktrees` was touched; no trash directory exists there.

### H1 (blocker): removal only when git vouches for the pair

`gitVouches(path, sourceRoot)` in `worktree.ts` runs before anything is moved. It refuses unless:
1. the realpath is in `git -C sourceRoot worktree list --porcelain`;
2. `provePairing` holds against `<git-common-dir>/worktrees`: the `.git` is a regular file naming a
   direct-child admin entry whose `gitdir` points back;
3. the admin entry has no `locked` file.

`provePairing`, `gitdirFromGitFile` and `regularFile` moved to `worktree.ts`, because
`worktree.ts` cannot import the reaper. The reaper re-exports them.

- **Lane close:** a refusal is now a toast ("Kept the worktree folder for <branch>", with git's
  reason and a pointer to Settings), not only a console warning.
- **Settings:** `removalDecision` uses git only when the folder is registered, readable and its
  repo exists (`gitRepoFor`). Everything else goes down the plain-directory path. That path always
  needs the second confirmation, even when nothing looked unsaved. `ReapEntry.removedWithoutGit`
  marks these rows, and their label says "git does not recognise it as a worktree".
- **Sandbox tests,** each leaving the folder intact:
  - a registered worktree with a corrupt `.git`;
  - a directory that is not a worktree of the repo;
  - a worktree root that was `git init`ed;
  - a locked worktree.
  With the vouch check temporarily removed, all four failed.

### M1: no bare `git worktree prune`

- `removeWorktree` deletes only the admin entry `gitVouches` proved, through
  `dropStaleAdminEntry`. Before deleting, it checks again that the entry is a direct child of
  `<common>/worktrees`, that its `gitdir` names the old `.git` path, that the path is gone, and that
  the entry is not locked. A failure there leaves the record and logs it; the folder is already in
  the trash.
- `reattachWorktree` no longer prunes. `dropStaleRecordForBranch` drops only the record that holds
  the branch being reattached, and only if its directory is missing.
- The wrong "same as gc" comment is gone. Risk 4 above is corrected in place.
- **Sandbox test:** sibling worktree B is moved away (an unmounted disk), A is removed, and A's
  branch is reattached. B's record survives, and after moving B back, `git rev-parse` inside it
  works. With the bare prune restored, this failed.

### M3: the second confirmation no longer claims commits stay on their branches

- `unsavedConsequence(rows)` in `worktree-groups.ts` builds the sentence from the rows actually
  listed:
  - uncommitted files: will be lost;
  - detached-HEAD commits (`branch === 'HEAD'`): "on no branch. Those commits will be lost.";
  - folders git cannot read, or deleted without git: "deleted outright, and anything not already on
    a branch is lost";
  - "Commits on a named branch stay on that branch" appears only when a listed row has one.
- The row label for a detached HEAD reads "N commits on a detached HEAD, on no branch".

### M4: live claims from main's pty table, re-checked per folder

- `TerminalManager.liveCwds()` returns the cwd of every non-exited pty, lanes and plain shells
  alike. `index.ts` hands it to the reaper (`setLivePtyCwds`).
- `liveClaimNow(path)` refuses when a pty cwd equals the folder or is inside it, or when
  `sessions.json` (re-read) has a claim inside it. It runs inside the loop, right before each
  folder's removal, in `removeSelected`, `reap` and the real `drainPending`.
- **Sandbox test:** a pty cwd in `<lane>/apps` blocks Settings removal even with the folder
  confirmed.

### L1: pending records

- `removeWorktreeDurably` clears its record when `removeWorktree` throws; a refusal is not an
  interrupted removal. **Sandbox test:** refusing a locked worktree leaves no record. With the old
  code, this failed.
- `drainPending(false)` gathers facts and holds, without removing, any record whose folder is live
  (pty or sessions), is not under the root, or has unsaved or unknown work. It returns `held`. Boot
  and quit still call it with `dryRun: true`.
- **Sandbox test:** a dirty folder and a pty-claimed folder are both held and stay on disk.

### L2: the safe button removes the confirmed intersection

- `worktreeReap(dryRun, confirmedPaths)`. The button passes `plan.auto` paths from the plan its
  confirm showed. `reap` removes only entries that are both confirmed and in the fresh tier. The
  IPC defaults a missing list to empty, so a real run with no list removes nothing.
- **Sandbox test:** an empty list removes nothing; `[lane, '/not/in/the/tier']` removes exactly the
  lane.

### L5: `GIT_OPTIONAL_LOCKS=0`

Set on the reaper's single `git` helper, so it covers every git call in `gatherFacts`, the backfill
and `reap`'s re-check. All of them only read.

### L7

- `sweepTrash` lstat-checks that the trash root is a plain directory before listing it, and skips
  the sweep otherwise.
- `isAuto` requires `uncommittedCount !== undefined`: a failed `git status` is unknown, not clean.
  Pure test added. The test fixture now sets `uncommittedCount: 0, unsavedCommits: 0` explicitly.
- `wouldAutoRemove` no longer lists git-orphaned folders, which makes the code match the risk-7
  decision above. The test now asserts they are never listed.

### Open, left as instructed

- **M2:** the unsaved-work confirmation is one press for all listed folders, not per folder. It is
  the user's call whether a listed bulk confirm is enough.
- **L3:** gitignored files (`.env.local`, `CLAUDE.local.md`, local databases) count as "No unsaved
  work".
- **L4:** backfill proves a git pairing, not that Operator created the folder; no rule refuses a
  folder that is itself a registered project path.
- **L6:** `nestedCheckout` detects only `.git` directories, not `.git` files (nested linked
  worktrees, submodule-style checkouts). It is now the only nesting guard on the plain-directory
  path.
- **Unchanged from before:** `reap()` cannot remove debris (no source repo), so the safe button
  lists it and reports it failed.

### Results

- Root `tsc --noEmit -p .`: pass. `electron` `tsc -p tsconfig.json` and
  `tsc -p tsconfig.renderer.json`: pass.
- Electron suite: 32 files, 610 passed, 0 failed.
- Renderer suite (`vitest run src/renderer`): 82 files, 1257 passed, 0 failed.
- **Checked against the old code:** with the vouch check removed and the bare prune restored in
  `worktree.ts`, 6 of the new sandbox tests failed: the 4 H1 cases, M1, and the L1 refusal record.
  The file was then restored.
- Run with the main checkout's `node_modules` and `electron/node_modules` symlinked in, removed
  after.
