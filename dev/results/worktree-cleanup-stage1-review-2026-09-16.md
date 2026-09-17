# Review: worktree cleanup stage 1 (2026-09-16)

Branch `operator/worktree-cleanup-stage1`, commits `33534dd` + `822c305`, diffed against `main`
(`c463d90`). Adversarial review of every deletion path. No code changed. Nothing under
`~/.operator/worktrees` was touched. The git behaviour checks below ran in a temp sandbox under the
session scratchpad with `GIT_CONFIG_GLOBAL=/dev/null`, git 2.54.0. The test suites were not re-run.

Line numbers refer to the files on the branch.

## Verdict

Nothing deletes on its own today. `AUTO_REAP_ON_TRIGGERS` is still `false`, boot/quit call
`drainPending` and `reap` with `dryRun: true`, and `checkAutoRemoval` contains no removal. The boot
sweep only deletes entries that `moveToTrash` put in the trash.

One regression should block the merge (H1). `removeWorktree` no longer asks git whether the path
is a worktree of `sourceRoot`, so the lane-close path can now delete a broken or unregistered
lane directory with its uncommitted work. The old code refused those. Two medium findings (M1,
M2) are about the user's rules and need a decision before merging.

## High

### H1. `removeWorktree` deletes directories git does not recognise as worktrees of `sourceRoot`, and lane close reaches it without a WIP commit

`electron/src/main/worktree.ts:349-362`, reached from `src/renderer/views/DashboardView.tsx:3084-3104`
(`handleCloseSession`), `worktree-reap.ts:869` (`drainPending`), `worktree.ts:410` (`mergeBranch`),
`worktree.ts:415` (`discardBranch`).

On main, the last step was `git -C sourceRoot worktree remove [--force] path`. Git validates the
path first, even with `--force`. Checked in the sandbox:

| Case | Old code (`worktree remove --force`) | Branch |
|---|---|---|
| Registered worktree whose `.git` file is corrupt | exit 128, "validation failed … is not a .git file", files kept | renamed into trash, swept |
| Directory that is not a worktree of `sourceRoot` | exit 128, "is not a working tree" | renamed, swept |
| Locked worktree (`git worktree lock`) | exit 128, "cannot remove a locked working tree" | renamed, swept |

The branch keeps `dangerousRemovalReason`, `nestedRegisteredWorktree` and `nestedCheckout`, but
none of them checks that the path is a worktree of `sourceRoot`. `nestedCheckout` skips a `.git`
directory at the root (`worktree.ts:323`), so a directory that is its own repo passes.

The lane-close path does not protect against this. It commits WIP only when
`worktreeStatus(tab.cwd)` says `valid && changes > 0` (`DashboardView.tsx:3092`). A broken
worktree reads `valid: false`, so it skips the commit and goes straight to `worktreeRemove`.

Concrete failure scenarios:
1. An agent in a lane breaks its checkout: it deletes or overwrites the `.git` file, or runs
   `git init` at the worktree root after git "stopped working". The user closes the lane. With
   `.git` broken, status is invalid, so there is no commit and the directory is trashed and swept
   with every uncommitted file. After `git init`, status is valid and the WIP commit lands in
   the new standalone repo, not the lane branch. The rename and sweep then delete that repo too,
   and the source branch never gets the work. The old code refused both cases.
2. A lane's worktree is locked (by the user or another tool). Close removes it anyway.
3. A saved session carries a wrong `sourceCwd` for a directory that is a worktree of another repo.
   Git used to refuse. Now it is removed, and `prune` runs in the wrong repo.

This goes against "never remove unsaved work without confirmation", and the result doc says the
guard is "unchanged". The only case still refused is a `sourceRoot` that no longer exists,
because `nestedRegisteredWorktree` cannot list worktrees there and returns `unknown`.

Suggested direction (not applied): before `moveToTrash`, refuse unless git vouches for the pair:
`realOf(path)` is in `git -C sourceRoot worktree list --porcelain`, `provePairing(path, <common>/worktrees)` holds, and the admin entry has no `locked` file. Anything else goes to the
Settings plain path with the unknown-unsaved confirmation.

## Medium

### M1. `git worktree prune` on every removal breaks the user's other worktrees whose directories are temporarily missing; the "same as gc" comment is wrong

`worktree.ts:357-360` (comment and call). The result doc's risk 4 makes the same claim.

The comment says prune "is what git would do on its own next `gc`". It is not. `gc` uses
`gc.worktreePruneExpire`, which defaults to 3 months. A bare `git worktree prune` expires
everything right away. Sandbox check: I moved a worktree directory away to simulate an
unmounted external disk. `git gc` kept its admin entry. `git worktree prune` deleted it. After I
moved the directory back, `git status` inside it failed with "fatal: not a git repository".

Failure scenario: the user keeps a worktree of `~/Developer/mantel` on an external SSD, or has
renamed its folder for a moment. Operator closes any mantel lane, or the user removes a mantel
folder in Settings. The external worktree's admin entry is deleted, along with its index and
per-worktree HEAD/reflog. When the disk comes back, the directory is not a git worktree. If it was
on a detached HEAD, its commits are unreachable (in the sandbox, `fsck --unreachable` shows the
detached commit after rename + prune) and `gc` deletes them later. A folder broken this way
then meets H1 at its next lane close.

`reattachWorktree` (`worktree.ts:113`) already ran a bare prune on main. The branch adds one to
every removal. Suggested direction: delete only this worktree's admin entry (the one its `.git`
file names, after checking that its `gitdir` points at the old path), or run
`prune --expire=3.months.ago`.

### M2. The unsaved-work confirmation is one click for any number of folders, not per folder

`WorktreesSection.tsx:238-252`, `worktree-reap.ts:781-785`.

Step 2 lists each folder, but one button ("Remove all N, including unsaved work") confirms all of
them, and `confirmedUnsaved` is the whole list. With a group's select-all
(`worktree-groups.ts:toggleGroup`), one group checkbox and two presses remove up to 17 folders with
uncommitted work (the el-encanto group). The user's rule says "explicit per-folder confirmation".
Whether a listed bulk confirm is enough is the user's call. As written, it is not per folder.

### M3. The step-2 text says "Commits stay on their branches", which is false for a detached HEAD

`WorktreesSection.tsx:241-243`; count from `worktree-reap.ts:645-647`.

On a detached HEAD (`branch === 'HEAD'`), `unsavedCommits` correctly counts commits that are on no
branch, and the row says "N commits on no other branch or remote". The header sentence right above
it says they stay on their branches. They do not. Removal renames the directory and prunes the
admin entry, which holds that worktree's HEAD and reflog. The commits become unreachable (checked
in the sandbox) and `gc` deletes them later. Agents leave detached HEADs mid-rebase or after
checking out a SHA. The user confirms under a false statement about unrecoverable loss.

### M4. The live-lane check reads `sessions.json` only, while main holds the real pty table

`worktree-reap.ts:580-594` (`liveClaims`), used by `removeSelected` (`:780`) and `reap` (`:901`).

`TerminalManager` in main knows the `cwd` of every open pty (`terminals.ts:313`), but the removal
paths do not ask it. `sessions.json` is written from a renderer effect gated on `savedHydrated`
(`DashboardView.tsx:3640-3670`).

Failure scenarios:
- The user resumes a suspended lane whose worktree still exists. Restore launches into the
  existing `saved.cwd` (`DashboardView.tsx:2950-2956`). If they then press Remove in Settings
  before the effect writes `sessions.json`, or while a renderer respawn has not re-hydrated,
  `gatherFacts` sees no claim and the directory is renamed out from under the running agent.
- A plain shell (`spawnShell`) or a dev server in that worktree is never a claim.

`removeSelected` gathers facts once and then removes folders one by one (each runs a nested scan
of up to 4000 entries and a prune). A lane opened during that loop is not seen. The window is
small, but "live lanes never touched" currently rests on a file the renderer writes, not on the
process table main already has. Suggested direction: also refuse any path equal to or containing
the `cwd` of a non-exited pty from `TerminalManager`.

## Low

### L1. Failed Settings removals leave `worktree-pending.json` records, which `drainPending` will act on once armed without a live or unsaved check

`worktree-reap.ts:789` → `removeWorktreeDurably` (`:1027-1035`) writes the record before the attempt
and leaves it when `removeWorktree` throws (nested scan unknown, rename failure, H1 fix refusals).
`drainPending` (`:861-881`) retries with no live claim and no unsaved check. Reattach reuses
deterministic names (`worktree.ts:116`, `${project}-${branchShort}`), so a record can outlive its
directory and later match a reattached live lane at the same path. Disarmed today, because the drain
runs with `dryRun: true`. This must be fixed before stage 2 arms anything. `queueEndedSessions`
followed by a drain has the same gap (no WIP commit, no unsaved check).

### L2. "Remove N safe worktrees" removes a freshly computed tier, not the list the user confirmed

`ipc.ts` `worktreeReap` → `reap()` (`worktree-reap.ts:899-926`) calls `reapPlan` again at press time.
The confirm shows `plan.auto.length` from when the page loaded. The removal acts on whatever is in
the tier now, and the loop does not re-check live claims. The tier is tight (merged-clean with no
unsaved work, re-checked with `git status`, plus debris, which `reap` cannot remove), so the risk is
small. The count can still differ from what was confirmed. Suggested direction: pass the confirmed
paths and intersect them with the fresh tier.

### L3. Gitignored files count as "No unsaved work"

`unsavedWorkOf` (`worktree-reap.ts:258-264`) uses `git status --porcelain`, which omits ignored files.
`.env.local`, `CLAUDE.local.md`, `.claude/settings.local.json` and local databases are deleted by the
button without a second confirm, under a row that says "No unsaved work". `git worktree remove` also
deleted ignored files, so this is not a regression. Only the label now says more than it did.

### L4. Backfill proves a git pairing, not that Operator created the folder

`provePairing`/`backfillRecords` (`worktree-reap.ts:478-511`) is sound against copied `.git` files
and wrong-repo attribution. It still attributes any git worktree under the root, whoever made it,
and the header comment keeps the "Operator can PROVE it made" wording. No rule refuses a folder that
is itself a registered project path (`projects.json`). If such a folder is merged and clean, it enters
the button's tier. None of the 16 project paths in `projects.json` is under the root today.

### L5. `gatherFacts` runs `git status` in live lane worktrees on every lane exit and task done, without `GIT_OPTIONAL_LOCKS=0`

`worktree-reap.ts:636`, triggered from `index.ts` (lane exit) and `DashboardView.tsx:1293` (task done).
`git status` refreshes the index and takes `index.lock` for a moment. An agent's `git commit` running
at the same time in a live lane can fail with "index.lock exists". Nothing is deleted, but live lanes
are touched. The result doc's dry run set `GIT_OPTIONAL_LOCKS=0` by hand. The code does not.

### L6. `nestedCheckout` only detects `.git` directories

`worktree.ts:321-323`. A nested linked worktree or a submodule-style checkout has a `.git` FILE and is
not detected. `removePlainDirectory` (`:367-380`) has no registered-worktree check either. The check
is unchanged from main, but it is now the only nesting guard on the new plain path. The chance of this
happening is low.

### L7. Report-only items that must not ship armed

- `wouldAutoRemove` still returns a reason for orphaned folders git cannot read (`worktree-reap.ts:279-281`).
  The author flagged it, and it matches nothing today.
- `isAuto` accepts merged-clean when `git status` failed, because `dirty` is false and
  `uncommittedCount` is undefined (`:238-245`, `:259-263`). The folder shows "Merged and clean — safe".
  `reap`'s re-check (`:914-916`) refuses it, so nothing is deleted.
- `sweepTrash` does not re-check that the trash root is a plain directory (`worktree-trash.ts:58-80`).
  `moveToTrash` does. A symlinked trash root would make the sweep delete `wt-…` directories in the
  target.

## What I checked and found clean

- **Automation is report-only.** `AUTO_REAP_ON_TRIGGERS = false` (`worktree-reap.ts:44`).
  `reconcileAtBoot` and `reapOnQuit` pass `dryRun: !AUTO_REAP_ON_TRIGGERS` to both `drainPending`
  and `reap`. `checkAutoRemoval` only writes `worktree-auto-check.json`. The `lane-exit` and
  `task-done` triggers only call `checkAutoRemoval`. The only `reap({dryRun:false})` is the IPC
  button.
- **Renderer paths are re-validated.** `removeSelected` looks each path up in a fresh `gatherFacts`
  map keyed by `join(root, name)`. Anything not an exact direct child is refused. Live, guard and
  unsaved checks run on the fresh facts. A folder that was clean on the page but is dirty now is
  refused, because it is not in `confirmedUnsaved`. `dangerousRemovalReason` runs in
  `removalDecision` and again inside `removeWorktree`/`removePlainDirectory`, so it cannot be skipped.
- **Unknown unsaved state is never treated as clean in manual removal.** `unsavedWorkOf` returns
  `known: false` for git-invalid folders, and `needsUnsavedConfirm` is `any || !known`. Dead-repo,
  corrupt and debris rows always need step 2. `wouldAutoRemove` requires `known && !any`.
- **"Remove N safe worktrees" tier.** After `822c305` it holds only debris and merged-clean
  folders with no unsaved work. `reap` no longer calls `commitAll`, re-checks `git status` before each
  removal, and refuses debris (no provenance `sourceRepo`). The button cannot delete merged-dirty,
  dead-source-repo, unattributed or corrupt folders, or orphans with unreadable state.
- **Debris without sizes.** `sizeUnknown` stops unmeasured git-invalid folders from reading as
  debris. The uwazi_2026 case is covered by a test.
- **Provenance backfill attribution.** A record needs all of these: the repo's own
  `worktree list` names the folder; the folder is a direct child of the realpath'd root; `.git` is a
  regular file (lstat, so a symlink is refused); its admin entry is a direct child of
  `<common>/worktrees`; the admin `gitdir` is a regular file pointing back. A copied `.git` fails, and
  a folder cannot be attributed to a repo other than the one whose admin entry it names. Submodule
  and separate-git-dir projects are skipped (`basename(common) !== '.git'`). If a project path is
  a linked worktree, the common dir is used, so the record names the real repo. Path-form
  mismatches (`/var` vs `/private/var`, case differences) cause a skip, never a wrong record.
  Symlinked folders in the root are skipped by `readdir` `isDirectory()` in `gatherFacts`, so a
  record for one can never lead to a removal.
- **Symlinks in removal.** A folder swapped for a symlink after gathering: `removePlainDirectory`
  refuses it (the realpath parent is not the root). `removeWorktree` renames the link itself, not its
  target. `fs.rm` in the sweep does not follow symlinks, and the sweep's `isDirectory()` filter
  skips symlinked entries.
- **Trash.** A rename across volumes throws EXDEV/EBUSY and nothing is deleted. The name is
  `wt-<ms>-<8hex>` from time, a counter and a random value. A rename onto an existing non-empty
  directory fails, and one onto an empty directory only replaces that empty directory. The sweep deletes only
  names matching `^wt-\d+-[0-9a-f]{8}$` inside `~/.operator/worktrees/.operator-worktree-trash`,
  the same root and pattern as the Tauri build (`src-tauri/src/worktree.rs:899,997`). Only
  `moveToTrash` writes there, and `gatherFacts` excludes it. The sweep is capped at 200 deletions
  per run and runs one at a time.
- **Every `removeWorktree` caller** (grep over `electron/src` and `src`): `ipc.worktreeRemove` →
  `removeWorktreeDurably` (DashboardView close), `removeSelected`, `drainPending` (dry-run
  today), `reap` (button), `mergeBranch`, `discardBranch`. Apart from H1, none loses more uncommitted
  work than on main: the old `--force` fallback also took dirty registered trees. Unchanged from
  main and not a regression: `TaskDiffCard.runMerge` ignores a failed `worktreeCommit` (for example a
  pre-commit hook rejecting it), then merges and removes, which loses the uncommitted files. The old
  `--force` did the same.
- **`terminals.ts` `selfExit`** and the DashboardView `task-done` call only start the report-only
  check.
