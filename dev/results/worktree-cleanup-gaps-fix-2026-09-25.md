# Worktree cleanup gaps — fixes, 2026-09-25

Brief: the gaps in Review's `dev/results/worktree-cleanup-audit-2026-09-25.md` (main checkout). The rule throughout: never delete uncommitted or unsaved work. Branch `operator/d91080`, one commit per item:

| # | Gap | Commit |
|---|---|---|
| 1 | G2: non-work dirt counted as unsaved | e85c471 |
| 2 | G6: stale `sessions.json` claims block forever | b5e8a56 |
| 3 | G3: interrupted lane-close removals never retried | d91ec87 |
| 4 | Rescue action in Settings → Worktrees | a0e18a6 |
| 5 | G5: ancestry-only merge label | 2d728a4 |
| 6 | G7: debris, stray files, trash-sweep log | e44d81b |

Not merged, not verified in the running app.

## (1) G2: provably non-work dirt — e85c471

`unsavedWorkOf` now leaves out uncommitted entries only when **every** entry in `git status --porcelain=v1 -z --untracked-files=all` is one of two proved shapes:

- **Untracked and byte-identical** to the same path in the source checkout's working tree, or on the source repo's default branch. The checkout comparison is by bytes. The default-branch comparison is `git hash-object --no-filters` against the blob id from `git ls-tree`.
- **The untracked root `node_modules` symlink.**

Any other entry makes the whole folder count as unsaved, as before:
- a tracked-file edit (the `CLAUDE.md` vault-path edit stays unsaved, as the brief says);
- a deletion or a staged change;
- another symlink, or a copy at a different path;
- a git failure, a missing source repo, or more than 5000 files.

The class and the automatic tier are unchanged: such a folder is still `merged-dirty` and still outside "Remove N safe worktrees". What changes is that manual removal no longer needs the unsaved-work step, and the row reads "N untracked, all copies of files that exist elsewhere".

**Read-only run against the real `~/.operator/worktrees`** (gatherFacts without sizes; git with `GIT_OPTIONAL_LOCKS=0`; nothing written or removed): 12 folders are now excused.
- `operator-63cc58`, `-808fe8`, `-3b4cb8`, `-d16e40`, `-63f860`, `-192a68`, `-fe5a78`, `-3d7d10`, `-1aefa8` and `-db3d00`: copies of main-checkout files.
- `el-encanto-f42a00` and `-a53ef0`: the `node_modules` symlink.

This matches the audit's list. The 20 folders with the `CLAUDE.md` edit still ask.

## (2) G6: claims backed by the pty table — b5e8a56

- `liveClaims` keeps a `sessions.json` claim only when main's pty table (`livePtyCwds`) has a pty in that directory or inside it.
- Where the table is not wired (the `--mcp-serve` process, which also calls `gatherFacts`), claims are trusted as before, never dropped. To make that distinction, `setLivePtyCwds` now accepts `null`.
- `queueEndedSessions` treats a stale-claimed record as ended and queues it.
- In `index.ts`, `setLivePtyCwds` now runs before `reconcileAtBoot()` instead of relying on the backfill's first `await`.

**For you to decide:** at boot, every lane that was open at the last quit has a terminal id with no pty behind it, so all of them now look ended and get queued. That is harmless only because of item (3): nothing drains ended-session records.
- If ended-session records were drained, it would remove the clean worktrees of exactly the lanes the "Where you left off" restore offer presents.
- `planRestore` marks a lane whose folder is missing as `folder-missing`, and auto-resume skips it.
- Anyone who later arms `AUTO_REAP_ON_TRIGGERS` or drains that reason needs to solve this first.

## (3) G3: boot retries removals someone started — d91ec87

- `reconcileAtBoot` now runs `drainPending(false, userStartedRemoval)`: lane close, Settings removal and `worktree_done` records.
- The existing guards still hold a record back: a live pty or claim, unsaved work (by the item 1 rule), or a guard refusal.
- Records with `ENDED_SESSION_REASON` (queued by boot reconciliation itself) are skipped. That goes slightly beyond the brief: a plain `drainPending(false)` would also have removed everything `queueEndedSessions` had just queued, which includes the restore-offer lanes described under (2).
- The drain now gathers facts only for the records it acts on.
- The boot auto-tier reap, the quit path and the triggers stay dry-run, and `AUTO_REAP_ON_TRIGGERS` stays `false`.

## (4) Rescue — a0e18a6

`rescueWorktree(path)` (IPC `worktreeRescue`, a "Rescue" link on the row) writes `~/.operator/rescued/<dir>-<YYYY-MM-DD>/`, suffixed `-2`, `-3` if that name is taken. It contains:

- `files/`: every uncommitted and untracked non-ignored file, at its worktree path; symlinks are kept as symlinks.
- `changes.patch`: `git diff HEAD --binary`, which records edits and deletions.
- `commits.bundle`: only when there are commits no other branch or remote holds.
- `manifest.json` and `README.md`, the README explaining how to restore.

**How "preserved" works:**
- A fingerprint is recorded in `~/.operator/rescued/index.json`: a sha256 over HEAD, the status, the diff, the untracked files' blob ids and the unsaved commits.
- While the folder's fingerprint still matches, `unsavedWorkOf` counts it as preserved, so manual removal needs no unsaved-work step.
- Any later change makes the work unsaved again.
- If the tree changes while it is being copied, the copy is kept but not recorded.

Rescue removes nothing. It is offered only for git-readable, non-live rows that have real unsaved work.

## (5) G5: merged by squash or rebase — 2d728a4

When `git branch --merged` says no, `git cherry <default> <branch>` is asked too; no `+` lines sets `mergedByPatch`. The row reads "Merged by squash or rebase" and the reason sentence says so. This is **a label only**: the class stays `unmerged`, so the auto tier and every removal rule are unchanged.

Read-only run: labels `landing-fraunces` and `mantel-3cdcc0`, which the audit named, and also `el-encanto-bb3510` and `el-encanto-f35ab8`, which the audit's table also shows as patch-equal.

## (6) G7 — e44d81b

- **Debris removal.** "Remove N safe worktrees" removes creation debris through `removePlainDirectory`, with the same guard, nested-checkout walk and trash. It used to fail with "no source repo recorded".
- **Stray files.** Non-directory entries in the worktree root are returned as `plan.strayFiles` and listed in Settings under "Other files in the folder", with date and size. They are not removed from the app; the page says to use Finder or a shell.
- **Trash log.** Sweep failures, and a trash root that is not a plain directory, are appended to `~/.operator/worktree-trash.log` with a timestamp. The log is capped at 256 KB by dropping the older half.

## Tests

The new `electron/src/main/worktree-cleanup-gaps.test.ts` (32 tests) runs against real git in a temp `OPERATOR_DIR` (realpath, because macOS `tmpdir` is a symlink and git reports real paths). The renderer's `worktree-groups.test.ts` gained 5 tests.

- **(1)**
  - parser: a rename's source path; the leading-space status column
  - pure rule: every tracked status is refused, a non-root symlink is refused
  - `unsavedWorkOf`
  - real git: a source-checkout copy, a default-branch copy while the checkout differs, the `node_modules` link, a unique file, a same-bytes copy at another path, the `CLAUDE.md` tracked edit, a mix, an unknown or missing source repo
- **(2)** stale claim dropped; a claim with a pty inside it kept; un-wired table keeps the claim; `queueEndedSessions` queues stale and not live.
- **(3)**
  - boot removes an interrupted lane close, keeps the branch and clears the record
  - holds a dirty folder and a pty-open folder
  - leaves an ended-session record
  - quit drains nothing
- **(4)**
  - files, patch (edit and deletion) and a bundle `git bundle list-heads` can read; the folder is then removable without confirmation and the rescue survives
  - a change after rescue requires confirmation again, and `removeSelected` refuses
  - no rescue directory is reused
  - an unreadable folder is refused
- **(5)** rebase-merge and squash-merge are labelled with class `unmerged` and not auto; a partly landed branch is not labelled; a fast-forward merge is plain merged.
- **(6)** debris removed by the safe button; a stray file listed and left alone; a stuck trash entry (read-only subdirectory) logged with a timestamp.
- **Mutation checks:**
  - forcing `claimIsLive` to true fails 2 item (2) tests;
  - making the boot drain dry-run again fails the item (3) removal test;
  - dropping the `userStartedRemoval` filter fails the ended-session test.

## Verification

- `electron`: `npm run typecheck` exit 0; vitest 41 files, **727 passed**.
- Root: `tsc --noEmit` exit 0; vitest 101 files, **1524 passed**.
- Not verified in the running app: the Rescue link, the stray-files list and the labels have not been seen on screen, and no boot of the real app has run the drain.

## Left out

- Removing stray files from Settings. The brief said to list them; the trash sweep only deletes directories named `wt-…`, so files would need a path of their own.
- G1 (arming the automatic tier) and G4 (agent-made worktrees and backfill adoption). Not in this brief.
