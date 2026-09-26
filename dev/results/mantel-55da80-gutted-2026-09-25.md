# What gutted `mantel-55da80` (and `mantel-55da80b`) — 2026-09-25

Read-only. Nothing was changed, removed or pruned. Times are UTC, with local (UTC−5) in brackets.

## Cause

**`gh pr merge --squash --delete-branch`, run by the mantel coordinator lane from the main checkout.
The PR's head branch was checked out in lane t2's worktree at the time.** gh 2.100.0 cleans up a
linked worktree that holds the branch it is deleting. The `git worktree remove` it runs then failed
halfway: t2's vite dev server kept writing into `apps/web/.vite`, so git reported "Directory not
empty". By that point git had already deleted most of the checkout. It also deleted git's admin entry
for the worktree. Because the removal failed, gh skipped the local branch delete, and that is why both
branches still exist. **Operator did not do it.** None of Operator's delete paths ran.

The same thing happened twice, to the two directories:

| Directory | PR merged | Branch checked out there | Merge command ran | Directory last written |
|---|---|---|---|---|
| `mantel-55da80` | #374 | `ops/nat-cool-cero` | 23:26:46–23:26:57Z (18:26 local), 09-22 | `apps/` 23:26:54Z (18:26:54 local) |
| `mantel-55da80b` | #382 | `feat/puerta-home` | 19:31:50–19:32:01Z (14:31 local), 09-23 | directory 19:31:58Z (14:31:58 local) |

**No work was lost.** In both cases t2 had committed and pushed everything before the merge. Details
under "What t2 has been writing to".

## Evidence

1. **The merges.** The mantel coordinator's transcript
   (`~/.claude/projects/-Users-juanmnl-Developer-mantel/ca3bb341-….jsonl`) has:
   - 2026-09-22T23:26:46.302Z: `cd ~/Developer/mantel; … gh pr merge 374 --squash --delete-branch 2>&1 | tail -1; …`,
     answered at 23:26:57.766Z with `0 |  | MERGED ab2fee1e`. The `| tail -1` threw away gh's worktree
     message, which is why nobody saw it.
   - 2026-09-23T19:31:50.446Z: `gh pr merge 382 --squash --delete-branch`, answered at 19:32:01Z with `MERGED 24a0c8b1`.
2. **What was checked out.**
   - In t2's transcript (`~/.claude/projects/-Users-juanmnl--operator-worktrees-mantel-55da80/b3cdf0cf-….jsonl`),
     the last checkout in `mantel-55da80` was at 2026-09-22T22:28:53Z:
     `git checkout -q -b ops/nat-cool-cero origin/main`. That branch was pushed as PR #374 at 22:33:07Z.
     The Review lane reviewed PR #374 as `origin/ops/nat-cool-cero` at 23:13Z.
   - The last checkout in `mantel-55da80b` was at 2026-09-23T19:20:42Z: `git checkout -q feat/puerta-home`,
     pushed as `beab39f4` at about 19:22Z for #382.
3. **What gh does.** The installed `gh` 2.100.0 (2026-09-03) contains, as strings in the binary:
   - `%s Removed worktree %s`
   - `%s Could not remove worktree %s; skipping local branch delete: %s`
   - `git worktree remove %s && git branch -D %s`
   - `%s Branch %s is checked out in the current worktree (%s); skipping local delete`
   - `%s Pruned stale worktree metadata for %s`

   So `--delete-branch` removes a *linked* worktree that has the branch checked out, and skips only the
   main or current one.
4. **The removal failed halfway, which fits the leftovers.**
   - Both local branches still exist: `git branch --list` shows `ops/nat-cool-cero` and
     `feat/puerta-home`. That is gh's "Could not remove worktree …; skipping local branch delete" path.
   - A vite dev server was running from the lane's `apps/web`: `npx vite --port 1422`, started from
     `mantel-55da80/apps/web` at 09-22 19:08Z. The same port served `mantel-55da80b` on 09-23 (t2's
     screenshots from `localhost:1422` at 19:21Z). Vite recreating `apps/web/.vite/deps_temp_*` during the
     delete is what makes `rmdir` fail with "Directory not empty". The same coordinator hit exactly this
     error on 09-22 at 20:32Z: `git worktree remove --force ../mantel-pr371` → `error: failed to delete
     '/Users/juanmnl/Developer/mantel-pr371': Directory not empty`.
   - Git continues to delete the admin entry after the work tree deletion fails. That matches: no
     `.git`, and no entry under `~/Developer/mantel/.git/worktrees/`.
   - The directory itself and `CLAUDE.md` keep their original birth time (2026-09-22 13:27:39 local,
     `stat -f %SB`). A rename-based removal, which is what Operator does (`worktree-trash.ts:42-49`), would
     have moved both away.
   - Why `CLAUDE.md` in particular survived is **inferred, not verified**. Git's recursive delete stops at
     the first entry it cannot remove, so whatever came after `apps` in directory order is left.
5. **t2 found out itself.**
   - At 2026-09-23T05:47:14Z: `fatal: not a git repository`, then "The worktree seems to be gone". It
     blamed its own `worktree_done` ("removed after I released it earlier"), which is wrong (see 6).
   - At 2026-09-23T21:04:52Z it saw the same for `mantel-55da80b`, and moved to a new sibling worktree.
6. **Operator's release did not run.** `artifacts.db` → `worktree_release` row 10: t2 released
   `mantel-55da80` at 2026-09-22T18:34:44Z (`worktree_done`, branch `fix/retiros-no-son-gastos`).
   `handled_at` and `outcome` are still NULL, so `releaseWorktreeOnExit` never ran for it (t2's pty has
   not exited).
7. **No other session touched the path.** Across all 839 transcripts written after 2026-09-22 18:00, the
   only commands that name `mantel-55da80` together with a delete, move or worktree verb are t2's own
   work inside it, plus its later `worktree add` for the siblings.

## Timeline

| UTC (local) | Event | Source |
|---|---|---|
| 09-22 18:27:39Z (13:27) | Operator creates `mantel-55da80`, branch `operator/55da80`, lane `code` | provenance record `createdAt 1790101660180`; reflog `operator/55da80@{13:27:39}: Created from main` |
| 18:34:44Z (13:34) | t2 calls `worktree_done`: the release is recorded, to happen at pty exit | `worktree_release` #10; t2 transcript |
| 18:34–22:34Z | t2 keeps working in the same directory and switches branches for each task: `fix/retiros-no-son-gastos`, `feat/reportes-card-retiros`, `feat/estacion-ve-costos`, `fix/stock-attribution`, `fix/facturas-por-periodo`, `ops/nat-cool-cero`. Opens PRs #370–#374 | t2 transcript |
| 19:08Z (14:08) | t2 starts `vite --port 1422` in `mantel-55da80/apps/web` | t2 transcript |
| 22:28:53Z (17:28) | Checks out `ops/nat-cool-cero`; commits at 22:31:38Z, pushes at 22:33Z (PR #374) | t2 transcript |
| 22:34:26Z (17:34) | t2's last action; idle until 05:47Z | t2 transcript |
| **23:26:46Z (18:26)** | **Coordinator: `gh pr merge 374 --squash --delete-branch`** | coordinator transcript |
| 23:26:54Z (18:26:54) | `mantel-55da80/apps` written: vite recreates `.vite/deps_temp_7d7b5282` | `stat` |
| 09-23 05:47:14Z (00:47) | t2: `fatal: not a git repository`. It creates `mantel-55da80b` itself with `git worktree add … -b fix/reservas-cancelar` (no provenance) | t2 transcript; `stat` birth 00:47:29 |
| 19:20:42Z (14:20) | t2 checks out `feat/puerta-home` in `55da80b`; pushes `beab39f4` about 19:22Z | t2 transcript |
| **19:31:50Z (14:31)** | **Coordinator: `gh pr merge 382 --squash --delete-branch`** | coordinator transcript |
| 19:31:58Z (14:31:58) | `mantel-55da80b` written (vite); same shape as `mantel-55da80` | `stat` |
| 21:04:52Z (16:04) | t2 finds `55da80b` gone and creates `mantel-55da80c` | t2 transcript |
| 09-23 → 09-25 | t2 creates about 40 sibling worktrees: `mantel-55da80-{code,money,r15,inv,merge,…,apifu,webfu}`. Most are gone again, apparently removed cleanly by later merges (no dev server running). It also runs a **bare `git worktree prune`** in the mantel repo (09-24 00:49:47Z) | t2 transcript; `ls` |

Other durable sources, checked:
- `worktree-pending.json` holds only `mantel-3cdcc0`.
- `worktree-auto-check.json` (last run 09-23 18:09 local) does not list either directory.
- The trash holds only the two stuck `electron` entries from 09-17.
- `updater.log` is dated 2026-08-25.
- The provenance store has `mantel-55da80` (created by Operator) and nothing for `55da80b`.

None of these records a removal of either directory.

## Operator's delete paths versus a live lane

Each path below deletes by renaming the whole directory into the trash (`removeWorktree`,
`worktree.ts:519-528` → `moveToTrash`). None of them produces this shape. Checked for whether they
could hit a live lane's cwd anyway:

| Path | Checks for a live pty in that directory? | Can it hit a live lane? |
|---|---|---|
| Settings manual removal, `removeSelected` (`worktree-reap.ts:845-860`) | Yes, `liveClaimNow` per folder | No |
| "Remove N safe", `reap` (`:980-1010`) and `drainPending` (`:930-950`) | Yes; boot and quit run them dry | No |
| `releaseWorktreeOnExit` (`:1236-1268`) | Yes, `ptyClaimOn(cwd, livePtyCwds())` for any other pty | No |
| Lane close: IPC `worktreeRemove` (`ipc.ts:224-226`) → `removeWorktreeDurably` | **No.** The renderer kills its own pty first (`DashboardView.tsx:3135`), but main does not check other ptys | Only if two tabs share a cwd. Not this case: t2's pty never exited |
| `worktreeMerge` → `mergeBranch` (`worktree.ts:661-680`) and `worktreeDiscard` → `discardBranch` (`:683-686`) | **No** | **Yes, in principle.** Merging or discarding from the review UI while that lane is still running would rename its cwd away. Not what happened here |
| `cloneDependencies` cleanup (`worktree.ts:194`) | n/a | Only the new worktree's own `node_modules` destination |

So Operator is not the cause. Two of its paths (`worktreeMerge`, `worktreeDiscard`) are unguarded
against a live lane and should get the same `ptyClaimOn` check the other paths have.

## What t2 has been writing to since

- **Nothing was lost from `mantel-55da80`.**
  - At 22:31:38Z t2's `git status` showed only the three staged files, and it committed them in the
    same command. They were pushed as #374, which is now merged as `ab2fee1e`.
  - After that, t2 only read (a production DB check, greps).
  - `scripts/sql/stock-merge-repair.sql`, written there at 21:28Z, is in history as `7ec427fe` and `02b760bf`.
  - `operator/55da80` (`8e52de15`) and every task branch survive.
  - What went: symlinked `node_modules`, and the test database connection string. The database itself
    lives in Postgres.
- **Nothing was lost from `mantel-55da80b`.** `beab39f4` was pushed about 10 minutes before #382 merged.
  The only local change after that was a deleted temp file (`_shot.html`).
- **Since 09-23, t2 works in worktrees it creates itself** next to its own:
  `~/.operator/worktrees/mantel-55da80-<task>`, about 40 so far. Its node_modules are symlinked from the
  main checkout. Today only `mantel-55da80-apifu` (clean, pushed) and `-ledger` (clean, merged) remain.
- **Its registered cwd is still the gutted `mantel-55da80`.** Every shell resets there. Operator's view of
  the lane (sessions record, Settings live claim, release row #10) points at a directory git cannot read.
  When t2 exits, `releaseWorktreeOnExit` will keep it (`releaseBlocker`: "git could not say…"), so the
  skeleton stays until someone removes it manually.

## Recommendations

1. **Mantel coordinator merge recipe.** Stop letting `gh pr merge --delete-branch` touch worktrees:
   - merge with `gh pr merge <n> --squash` and delete the remote branch with `git push origin --delete <branch>`;
   - or check first that no worktree has the branch checked out (`git worktree list --porcelain`).

   Also stop piping gh through `| tail -1`, which hid "Removed worktree" or "Could not remove worktree".
   This belongs in the mantel project's coordinator memory, or in Operator's orchestration note for
   coordinators.
2. **Lanes should not check a PR branch out in their Operator worktree and leave it there after pushing.**
   t2 switches branches inside its home worktree, so whichever PR was checked out last gets its home
   removed when it merges. Either return to the lane's own branch after pushing, or accept per-task
   worktrees but put them under the lane's scratchpad, not `~/.operator/worktrees` (see the worktree
   audit, G4).
3. **Operator:**
   - add the `ptyClaimOn`/`livePtyCwds` refusal to `mergeBranch` and `discardBranch`;
   - warn in the lane header when a live lane's cwd stops being a git worktree (`.git` missing), so the
     user sees it before the agent does.
4. **Bare `git worktree prune` by lanes** (t2, 09-24 00:49Z) expires the admin record of every worktree
   whose directory is missing at that moment. That is the hazard Review M1 removed from Operator's own
   code. Lanes should not run it.
5. **Cleanup, for the user to approve.** `mantel-55da80` holds only `CLAUDE.md` and a `.vite` cache, and
   `mantel-55da80b` the same. Remove both once t2 is closed; removing them earlier would pull the cwd out
   from under the running lane. `worktree_release` row 10 can then be marked handled.

## Not verified

- gh's exact removal command (with or without `--force`), and its printed message for these two merges,
  because `| tail -1` discarded it. The binary's strings and the surviving local branches are the evidence.
- The directory-order explanation for why `CLAUDE.md` survived.
- Whether `mantel-d6de00` (released by t5 at 09-23 22:22Z, now gone, `worktree_release` #13 still open)
  went the same way. The pattern fits; not checked.
