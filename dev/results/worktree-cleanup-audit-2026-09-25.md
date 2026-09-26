# Worktree cleanup audit against real disk (2026-09-25)

Read-only. Nothing was removed, moved or committed. Every git call ran with `GIT_OPTIONAL_LOCKS=0`
(no fetch). Sizes come from `du -sk`. Live lanes were identified from `claude --settings …/sessions/<id>/`
process command lines, not `lsof`. Code references are at `65ffdd2`.

## Summary

- `~/.operator/worktrees` holds **70 entries and 18.67 GB** today: 64 directories, the trash
  directory, and 5 stray files. The brief's figure was 67.
- **The 67-versus-19 gap is not an orphan count.** `git worktree list` in this repo shows 19 because
  it covers only the `operator` repo: the main checkout plus the 18 `operator-*` entries. The other
  46 entries belong to el-encanto (17), mantel (7 git-valid), mantel-landing (9), web27 (4),
  uwazi_app (2), Operator-landing (1), and a dead repo (4). Only 7 directories are not registered
  with git.
- **No automatic path removes anything except lane close and `worktree_done`.** In 0.24.0 the boot,
  quit and trigger paths are dry-run or report-only (`AUTO_REAP_ON_TRIGGERS = false`,
  `electron/src/main/worktree-reap.ts:52`). Everything created before 0.24.0, or not closed through a
  lane close, stays until someone removes it in Settings.
- **About 12.4 GB (31 directories) can go with nothing lost** (classes A, B, S below). The largest
  blocker is not unmerged work. It is dirt that `unsavedWorkOf` counts as unsaved:
  - a one-line `CLAUDE.md` vault-path edit in 20 directories;
  - brief and result files that are byte-identical copies of files in the main checkout (11 directories);
  - old `node_modules` symlinks (2 directories).
- **Correct refusals, 5.3 GB:**
  - 17 directories hold uncommitted files that exist nowhere else;
  - 4 have commits on no other branch or remote;
  - 5 are live lanes;
  - 4 have a dead source repo.

  Several of the unique files are `dev/results/*.md` reports that never reached the main checkout.
- **One live defect found in passing, and it matters more than disk.** The live mantel Code lane `t2`
  runs in `mantel-55da80`, and that checkout has been gutted: no `.git`, only `CLAUDE.md` and
  `apps/web/.vite`, git's admin entry gone, branch `operator/55da80` intact at `8e52de15`. Something
  removed it while the lane was running. Details in G4.

## Classes

| Class | Meaning | Dirs | GB | Survived because | Verdict |
|---|---|---|---|---|---|
| **A** | Merged (ancestor, or every patch already in the default branch); dirt only CLAUDE.md vault edit, node_modules symlink, or byte-identical copies of main-checkout files | 26 | **12.04** | Automation off (G1); dirt counted as unsaved (G2); one interrupted lane close never retried (G3) | **Gap** |
| **B** | Clean; every commit held by another branch or remote; not merged | 4 | 0.34 | G1, and G5 for agent-made ones | **Gap** |
| **S** | Would be A, but `sessions.json` still claims it with a dead terminal id | 1 | 0.01 | Stale claim (G6) | **Gap** |
| **C** | One commit only on its own branch, patch already in `main` | 1 | 0.54 | Counts as unsaved by the user's rule | Correct refusal; needs your OK |
| **D** | Uncommitted files that exist nowhere else | 17 | 2.37 | `unsavedWorkOf` (`worktree-reap.ts:271-278`) | **Correct refusal** |
| **E** | Commits on no other branch or remote | 4 | 0.64 | same | **Correct refusal** |
| **F** | Source repo gone (`~/Documents/Claude/uwazi_2026`); git cannot read them | 4 | 0.46 | Unknown unsaved state, manual only (`wouldAutoRemove` `:292`) | Correct refusal of automation; manual path exists |
| **L** | Live lane process running in it | 5 | 2.27 | `live-claimed` (`:208`) | Correct |
| **G** | Debris: stray files, interrupted-creation leftover, gutted skeleton, stuck trash | 8 | < 0.01 | G7 | Gap (tiny) |

Merge state uses two tests, with the default branch at `main`. "Ancestor" is
`merge-base --is-ancestor HEAD main`. "Patch-equal" is `git cherry main HEAD` showing no `+` lines,
which covers squash and rebase merges. Operator's own classifier uses only the ancestor form
(`git branch --merged`), so it labels `landing-fraunces` and `mantel-3cdcc0` "unmerged". The label
is cosmetic, since `wouldAutoRemove` does not use merge state.

## Every entry

"Uncommitted" is broken down per file. A **copy of main-checkout file** is byte-identical to the same
path in the source repo's working tree. A **CLAUDE.md vault-path edit** is a diff in which every
changed line is the Obsidian vault path line (the 2026-08-05 vault move). **UNIQUE** means the
content exists in neither the main checkout nor the default branch. For UNIQUE files, the "exists but
differs" versus "absent" split is in §Class D.

| Class | Entry | GB | Source repo | Branch | Merged (ancestor / patch) | Uncommitted | Unsaved commits | Upstream | Session ref | Last modified | git registers |
|---|---|---|---|---|---|---|---|---|---|---|---|
| L | `operator-57440` | 0.67 | ~/Developer/operator | operator/57440 | no (3 unmerged) | clean | 3 | — | live lane t15 design | 2026-09-25 | yes |
| L | `operator-d91080` | 0.67 | ~/Developer/operator | operator/d91080 | no (1 unmerged) | 1 UNIQUE modified; 1 UNIQUE untracked | 1 | — | live lane t13 code | 2026-09-25 | yes |
| L | `uwazi_app-937700` | 0.47 | ~/Developer/huridocs/uwazi_app | library/pane-responsive | no (148 unmerged) | clean | 0 | — | live lane t4 design | 2026-09-24 | yes |
| L | `uwazi_app-464540` | 0.46 | ~/Developer/huridocs/uwazi_app | main-selection-results | yes | clean | 0 | origin/main | live lane t8 code | 2026-09-23 | yes |
| L | `mantel-55da80` | 0.00 | ~/Developer/mantel | — | — | unreadable | — | — | live lane t2 code | 2026-09-22 | no |
| S | `operator-db3d00` | 0.01 | ~/Developer/operator | operator/db3d00 | yes | 1 copy of main-checkout file | 0 | — | stale claim t20 research | 2026-09-11 | yes |
| A | `operator-63cc58` | 3.92 | ~/Developer/operator | operator/rail-close | yes | 4 copy of main-checkout file | 0 | — | — | 2026-08-10 | yes |
| A | `operator-808fe8` | 3.05 | ~/Developer/operator | operator/808fe8 | yes | 9 copy of main-checkout file | 0 | — | — | 2026-08-05 | yes |
| A | `operator-3b4cb8` | 1.08 | ~/Developer/operator | operator/3b4cb8 | yes | 22 copy of main-checkout file | 0 | — | — | 2026-08-04 | yes |
| A | `operator-d16e40` | 0.64 | ~/Developer/operator | operator/integrate-0.19.0 | yes | 1 copy of main-checkout file | 0 | — | — | 2026-08-29 | yes |
| A | `mantel-3cdcc0` | 0.57 | ~/Developer/mantel | feat/red-eventos-pasados | patch-equal | clean | 0 | origin/feat/red-eventos-pasados | — | 2026-09-17 | yes |
| A | `el-encanto-6db458` | 0.52 | ~/Developer/el-encanto | operator/6db458 | yes | 1 CLAUDE.md vault-path edit | 0 | — | — | 2026-08-04 | yes |
| A | `el-encanto-abdbc0` | 0.50 | ~/Developer/el-encanto | operator/abdbc0 | yes | 1 CLAUDE.md vault-path edit | 0 | — | — | 2026-08-04 | yes |
| A | `el-encanto-1ef490` | 0.50 | ~/Developer/el-encanto | land/dirty-tree | yes | 1 CLAUDE.md vault-path edit | 0 | origin/main | — | 2026-08-03 | yes |
| A | `el-encanto-d22178` | 0.50 | ~/Developer/el-encanto | docs/rescued-specs | yes | 1 CLAUDE.md vault-path edit | 0 | origin/main | — | 2026-08-03 | yes |
| A | `operator-63f860` | 0.16 | ~/Developer/operator | operator/63f860 | yes | 6 copy of main-checkout file | 0 | — | — | 2026-08-06 | yes |
| A | `operator-192a68` | 0.16 | ~/Developer/operator | operator/192a68 | yes | 4 copy of main-checkout file | 0 | — | — | 2026-08-10 | yes |
| A | `mantel-landing-fa7798` | 0.09 | ~/Developer/mantel-landing | operator/fa7798 | yes | 1 CLAUDE.md vault-path edit | 0 | — | — | 2026-08-04 | yes |
| A | `mantel-landing-45c800` | 0.09 | ~/Developer/mantel-landing | operator/45c800 | yes | 1 CLAUDE.md vault-path edit | 0 | — | — | 2026-08-03 | yes |
| A | `mantel-55da80-ledger` | 0.08 | ~/Developer/mantel | fix/asientos-dia-de-negocio | yes | clean | 0 | origin/main | — | 2026-09-24 | yes |
| A | `el-encanto-f42a00` | 0.04 | ~/Developer/el-encanto | operator/f42a00 | yes | 1 node_modules symlink | 0 | — | — | 2026-08-23 | yes |
| A | `landing-fraunces` | 0.03 | ~/Developer/mantel-landing | design/fraunces | patch-equal | clean | 0 | origin/design/fraunces | — | 2026-09-18 | yes |
| A | `el-encanto-306eb0` | 0.02 | ~/Developer/el-encanto | operator/306eb0 | yes | 1 CLAUDE.md vault-path edit; 2 copy of main-checkout file | 0 | — | — | 2026-08-03 | yes |
| A | `el-encanto-22a2b8` | 0.02 | ~/Developer/el-encanto | operator/22a2b8 | yes | 1 CLAUDE.md vault-path edit | 0 | — | — | 2026-08-04 | yes |
| A | `mantel-landing-22d6e8` | 0.01 | ~/Developer/mantel-landing | operator/22d6e8 | yes | 1 CLAUDE.md vault-path edit | 0 | — | — | 2026-08-03 | yes |
| A | `mantel-landing-374c8` | 0.01 | ~/Developer/mantel-landing | operator/374c8 | yes | 1 CLAUDE.md vault-path edit | 0 | — | — | 2026-08-03 | yes |
| A | `mantel-landing-3ff9d0` | 0.01 | ~/Developer/mantel-landing | operator/3ff9d0 | yes | 1 CLAUDE.md vault-path edit | 0 | — | — | 2026-08-03 | yes |
| A | `mantel-landing-8f5168` | 0.01 | ~/Developer/mantel-landing | operator/8f5168 | yes | 1 CLAUDE.md vault-path edit | 0 | — | — | 2026-08-03 | yes |
| A | `operator-fe5a78` | 0.01 | ~/Developer/operator | operator/fe5a78 | yes | 8 copy of main-checkout file | 0 | — | — | 2026-08-06 | yes |
| A | `operator-3d7d10` | 0.01 | ~/Developer/operator | operator/3d7d10 | yes | 6 copy of main-checkout file | 0 | — | — | 2026-08-06 | yes |
| A | `operator-1aefa8` | 0.01 | ~/Developer/operator | operator/1aefa8 | yes | 8 copy of main-checkout file | 0 | — | — | 2026-08-05 | yes |
| A | `Operator-landing-78e140` | 0.00 | ~/Developer/Operator-landing | operator/78e140 | yes | 1 CLAUDE.md vault-path edit | 0 | — | — | 2026-08-04 | yes |
| B | `mantel-sec5` | 0.11 | ~/Developer/mantel | fix/seguridad-logo-hashes-y-hallazgos | no (4 unmerged) | clean | 0 | origin/fix/seguridad-logo-hashes-y-hallazgos | — | 2026-09-21 | yes |
| B | `mantel-55da80-apifu` | 0.09 | ~/Developer/mantel | fix/review-followups-api | no (7 unmerged) | clean | 0 | origin/fix/review-followups-api | — | 2026-09-25 | yes |
| B | `mantel-ee6740d` | 0.09 | ~/Developer/mantel | feat/voucher-rounding-server | no (3 unmerged) | clean | 0 | origin/feat/voucher-rounding-server | — | 2026-09-18 | yes |
| B | `el-encanto-a53ef0` | 0.05 | ~/Developer/el-encanto | design/inventario-duplicate-family | no (1 unmerged) | 1 node_modules symlink | 0 | — | — | 2026-08-11 | yes |
| C | `el-encanto-bb3510` | 0.54 | ~/Developer/el-encanto | operator/bb3510 | patch-equal | 1 CLAUDE.md vault-path edit | 1 | — | — | 2026-08-03 | yes |
| D | `el-encanto-df90b0` | 0.53 | ~/Developer/el-encanto | operator/df90b0 | yes | 1 CLAUDE.md vault-path edit; 2 UNIQUE modified; 2 copy of main-checkout file; 2 UNIQUE untracked | 0 | — | — | 2026-08-03 | yes |
| D | `el-encanto-998868` | 0.52 | ~/Developer/el-encanto | operator/998868 | yes | 1 CLAUDE.md vault-path edit; 18 UNIQUE modified; 6 UNIQUE untracked; 4 copy of main-checkout file | 0 | — | — | 2026-08-03 | yes |
| D | `el-encanto-4994e0` | 0.50 | ~/Developer/el-encanto | fix/product-sheet-unit-assumption | yes | 1 CLAUDE.md vault-path edit; 1 UNIQUE untracked | 0 | — | — | 2026-08-03 | yes |
| D | `web27-40c980` | 0.30 | ~/Developer/web27 | operator/40c980 | yes | 539 copy of main-checkout file; 1 UNIQUE untracked | 0 | — | — | 2026-08-28 | yes |
| D | `web27-511ca0` | 0.21 | ~/Developer/web27 | operator/511ca0 | yes | 1 UNIQUE modified | 0 | — | — | 2026-08-01 | yes |
| D | `mantel-landing-10d8d0` | 0.09 | ~/Developer/mantel-landing | operator/10d8d0 | yes | 1 CLAUDE.md vault-path edit; 3 UNIQUE modified; 1 UNIQUE untracked | 0 | — | — | 2026-08-03 | yes |
| D | `mantel-design-money` | 0.08 | ~/Developer/mantel | design/dinero-dueno-oculto | no (2 unmerged) | 1 UNIQUE untracked | 0 | origin/design/dinero-dueno-oculto | — | 2026-09-24 | yes |
| D | `web27-fd4700` | 0.02 | ~/Developer/web27 | operator/fd4700 | yes | 34 UNIQUE untracked; 4 copy of main-checkout file | 0 | — | — | 2026-08-28 | yes |
| D | `el-encanto-375d90` | 0.02 | ~/Developer/el-encanto | hotfix/restock-availability | yes | 1 CLAUDE.md vault-path edit; 1 UNIQUE untracked; 3 copy of main-checkout file | 0 | origin/main | — | 2026-08-03 | yes |
| D | `el-encanto-354ec8` | 0.02 | ~/Developer/el-encanto | operator/354ec8 | yes | 1 CLAUDE.md vault-path edit; 1 UNIQUE untracked; 1 copy of main-checkout file | 0 | — | — | 2026-08-03 | yes |
| D | `operator-4fbc0` | 0.01 | ~/Developer/operator | operator/4fbc0 | yes | 1 UNIQUE untracked | 0 | — | — | 2026-08-29 | yes |
| D | `operator-521cc0` | 0.01 | ~/Developer/operator | operator/521cc0 | yes | 1 UNIQUE untracked | 0 | — | — | 2026-08-25 | yes |
| D | `operator-4a1ec0` | 0.01 | ~/Developer/operator | operator/4a1ec0 | yes | 1 UNIQUE untracked | 0 | — | — | 2026-08-25 | yes |
| D | `mantel-landing-4c9588` | 0.01 | ~/Developer/mantel-landing | operator/4c9588 | yes | 1 UNIQUE untracked | 0 | — | — | 2026-08-18 | yes |
| D | `operator-311c00` | 0.01 | ~/Developer/operator | operator/311c00 | yes | 4 copy of main-checkout file; 2 UNIQUE untracked | 0 | — | — | 2026-08-24 | yes |
| D | `operator-7d8780` | 0.01 | ~/Developer/operator | operator/7d8780 | yes | 1 UNIQUE untracked; 4 copy of main-checkout file | 0 | — | — | 2026-08-24 | yes |
| D | `operator-941778` | 0.01 | ~/Developer/operator | operator/941778 | yes | 9 copy of main-checkout file; 1 UNIQUE untracked | 0 | — | — | 2026-08-20 | yes |
| E | `el-encanto-dfb638` | 0.52 | ~/Developer/el-encanto | operator/dfb638-envase-qa | no (1 unmerged) | 1 CLAUDE.md vault-path edit; 1 UNIQUE untracked | 1 | — | — | 2026-08-03 | yes |
| E | `web27-44dde8` | 0.05 | ~/Developer/web27 | operator/44dde8 | no (3 unmerged) | 4 UNIQUE modified; 1 UNIQUE untracked | 3 | — | — | 2026-08-01 | yes |
| E | `el-encanto-f35ab8` | 0.05 | ~/Developer/el-encanto | operator/f35ab8 | patch-equal | 1 CLAUDE.md vault-path edit; 1 UNIQUE untracked | 1 | — | — | 2026-08-03 | yes |
| E | `el-encanto-830078` | 0.02 | ~/Developer/el-encanto | operator/830078 | no (4 unmerged) | 1 CLAUDE.md vault-path edit | 4 | — | — | 2026-08-04 | yes |
| F | `uwazi_2026-bv7r00` | 0.21 | ~/Documents/Claude/uwazi_2026 | — | — | unreadable | — | — | — | 2026-08-03 | no (dead repo) |
| F | `uwazi_2026-k1xoqp` | 0.21 | ~/Documents/Claude/uwazi_2026 | — | — | unreadable | — | — | — | 2026-08-03 | no (dead repo) |
| F | `uwazi_2026-a5d0i5` | 0.02 | ~/Documents/Claude/uwazi_2026 | — | — | unreadable | — | — | — | 2026-08-03 | no (dead repo) |
| F | `uwazi_2026-mcck6a` | 0.02 | ~/Documents/Claude/uwazi_2026 | — | — | unreadable | — | — | — | 2026-08-03 | no (dead repo) |
| G | `rv-full.log` (file) | 0.00 | — | — | — | — | — | — | — | 2026-09-14 | — |
| G | `.operator-worktree-trash` | 0.00 | — | — | — | unreadable | — | — | — | 2026-09-22 | no |
| G | `rv2.log` (file) | 0.00 | — | — | — | — | — | — | — | 2026-09-14 | — |
| G | `copa-run.log` (file) | 0.00 | — | — | — | — | — | — | — | 2026-09-14 | — |
| G | `.tmpIBNq7t-d96ee0` | 0.00 | /private/var/folders/qf/ldd1qm516ds597tkx3r17wvr0000gn/T/.tmpIBNq7t | — | — | unreadable | — | — | — | 2026-08-10 | no (dead repo) |
| G | `mantel-55da80b` | 0.00 | — | — | — | unreadable | — | — | — | 2026-09-23 | no |
| G | `.DS_Store` (file) | 0.00 | — | — | — | — | — | — | — | 2026-06-15 | — |
| G | `rv.log` (file) | 0.00 | — | — | — | — | — | — | — | 2026-09-14 | — |

Session references: `sessions.json` references only 6 of these directories (the 5 live lanes, plus the
stale claim on `operator-db3d00`). No other directory has a saved or suspended session.

## Why each class survived, with code

What 0.24.0 actually removes, and what it does not:

| Path | Removes? | Where |
|---|---|---|
| Lane close (renderer) | Yes. WIP-commits a dirty tree, then `worktreeRemove` → `removeWorktreeDurably` | `src/renderer/views/DashboardView.tsx:3148-3177`, `electron/src/main/ipc.ts:224-226`, `worktree-reap.ts:1110-1134` |
| `worktree_done` + lane pty exit | Yes, if clean and the branch is not detached | `worktree-reap.ts:1236-1268`, rule `releaseBlocker` `:1198-1203` |
| Settings → Worktrees, manual selection | Yes, on the user's press | `removeSelected` `:845` |
| Settings "Remove N safe worktrees" | Yes, confirmed paths ∩ auto tier | `reap` `:980`; tier `isAuto` `:250-259` |
| Boot: `reconcileAtBoot` | **No.** Backfills provenance, queues ended sessions, then `drainPending(true)` and `reap({dryRun:true})` | `:1056-1076`; switch `AUTO_REAP_ON_TRIGGERS = false` `:52` |
| Quit: `reapOnQuit` | **No.** Same dry-run pair | `:1082-1092` |
| Triggers: `checkAutoRemoval` (boot, lane-exit, task-done) | **No.** Writes `worktree-auto-check.json` only | `:788-817` |

**G1 — Automation is off, so nothing revisits old directories (classes A, B; about 12.4 GB).**

- 49 of the 64 directories predate the lane-close removal being made reliable. They were created
  2026-08-01 to 08-29, in the Tauri era and the Electron transition.
- None has a `sessions.json` record, so `queueEndedSessions` (`:1026-1053`) cannot see them either.
- The last trigger run (2026-09-23 18:09, `task-done`) listed 4 of them as removable: `landing-fraunces`,
  `mantel-3cdcc0`, `mantel-ee6740d` and `mantel-sec5`. That list is report-only by design, and nothing acts on it.

**G2 — `unsavedWorkOf` counts non-work as unsaved (22 of class A, about 10.5 GB).**

`unsavedWorkOf` (`:271-278`) counts every `git status --porcelain` line as unsaved. `wouldAutoRemove`
(`:294`) and `isAuto` (`:258`) both require `!any`, so these directories are never offered as safe.
Settings lists them, but every row asks for the second confirmation. Three kinds of dirt that is not
work block them:

1. **A one-line `CLAUDE.md` edit** in 20 directories: the vault path changed from the iCloud location
   to `~/Work Vault` (verified: every changed line is the vault line). It was made in each checkout
   by the 2026-08-05 vault move and never committed.
2. **Untracked brief and result files that are byte-identical to files in the main checkout**, in 11
   `operator-*` directories. These are the brief copies left by the "briefs invisible across
   worktrees" workaround. They include the three largest directories: `operator-63cc58` 3.92 GB,
   `operator-808fe8` 3.05 GB and `operator-3b4cb8` 1.08 GB.
3. **An untracked `node_modules` symlink** in 2 directories (`el-encanto-f42a00`, `el-encanto-a53ef0`), from
   an older build that symlinked dependencies. `.gitignore`'s `node_modules/` (with the slash) does not
   match a symlink, so git lists it. The current build clones instead (`worktree.ts:86-108`), so new
   worktrees do not get this.

The refusal is correct by the letter of the rule ("any uncommitted change"). In practice it is the
main gap: none of these files holds work.

**G3 — An interrupted lane close is never retried (`mantel-3cdcc0`, 0.57 GB).** `worktree-pending.json`
still holds a `lane close` record from 2026-09-17 15:27. `removeWorktreeDurably` writes that record
before removing (`:1115-1121`) and clears it on success or refusal. A leftover record therefore means
the removal was interrupted. The retry is `drainPending`, and boot and quit call it with
`dryRun = true` (`:1062`, `:1084`), so it never runs. The tree is clean and the branch is pushed to
`origin`.

**G4 — Lanes create worktrees in Operator's root, and one live lane's checkout was gutted.**

- **Worktrees Operator did not create.** `mantel-55da80-apifu`, `mantel-55da80-ledger`,
  `mantel-design-money` and `mantel-55da80b` have no provenance. Their names do not follow Operator's
  `<project>-<6hex>` pattern, so a lane ran `git worktree add` itself. Operator has not booted since
  (the app has been up 3 days), so backfill has not seen them. When it does, `backfillProvenanceAtBoot`
  (`:525`) will record them as Operator's (`createdBy: 'backfill'`), because it proves only the git
  pairing, not who created them (Review L4). `landing-fraunces`, `mantel-ee6740d` and `mantel-sec5`
  already went through that and were adopted.
- **The gutted live checkout.** `mantel-55da80` is the cwd of live lane `t2` (mantel Code, active today).
  It has no `.git`. The directory's birth time and `CLAUDE.md` (13:27:39) are original, and
  `apps/web/.vite` was rewritten at 18:26 on 09-22. Git's admin entry is gone, and branch
  `operator/55da80` still points at `8e52de15` (13:41, 09-22).
  - Something deleted the checkout, except `CLAUDE.md`, while the lane was running.
  - An Operator removal renames the whole directory into the trash, and the trash holds no such entry,
    so the deletion likely did not go through Operator's removal path. The cause is not established.
  - `mantel-55da80b` has the same shape (no git, `CLAUDE.md` byte-identical to mantel's, `.vite` temp).
  - Consequence: a later resume of that lane cannot reattach. `reattachWorktree` returns null when the
    path exists (`worktree.ts:268`), so it falls back to a fresh branch.

  **This deserves its own investigation.** It is a defect in a running lane, not only a disk issue.

**G5 — Merge detection by ancestry only.** `git branch --merged` (`gatherFacts` `:621`, query at `:749`) calls
squash- or rebase-merged branches unmerged. Settings labels `landing-fraunces` and `mantel-3cdcc0`
"not merged" although every patch is in `main`. It has no effect on removal, because `wouldAutoRemove`
ignores merge state. It does mislead the user.

**G6 — Stale claims in `sessions.json` block forever (`operator-db3d00`).** `liveClaims` (`:581-595`)
treats any `terminalId` in `sessions.json` as a live lane. `operator-db3d00` is claimed by `t20` from
2026-09-11, and no process runs there. Terminal ids restart every app run, so the claim can never
clear itself. `queueEndedSessions` also skips any record with a `terminalId` (`:1038`). Main holds the
real pty table (`livePtyCwds`, `:821`), but `classify` uses the file.

**G7 — Debris (under 1 MB total).**
- `.tmpIBNq7t-d96ee0`: `reap()` cannot remove debris, because it has no source repo. This is known and
  unchanged since 09-16.
- Two trash entries from 2026-09-17 (`wt-1789698715623-87f7be40`, `wt-1789698717359-b2e34944`, 224 KB)
  are stuck on `electron/node_modules/electron/dist/Electron.app`. The sweep's `rm` must be failing on
  the app bundle (`worktree-trash.ts:80-86`), and the failure goes to stderr only. The cause is
  probably macOS App Management protection on `.app` bundles. Not verified.
- Four agent run logs (`rv.log`, `rv2.log`, `rv-full.log`, `copa-run.log`) and a `.DS_Store` sit in the
  root. `gatherFacts` lists directories only (`:606-607`), so they are invisible to Settings.

**Correct refusals.** Classes D and E hold work that exists nowhere else; details below. Class F cannot
be read by git at all. Class L is running. Class C is a judgment call: `el-encanto-bb3510` has one
commit only on its own branch. `git cherry` says the same patch is already in `main`, and the branch is
kept on removal. By the user's rule it still counts as unsaved.

### Class D and E detail (keep; review before any removal)

- `el-encanto-998868` (0.52 GB): 24 unique file(s), 20 differ from main's copy, 4 absent from main. `apps/api/package.json`, `apps/api/src/app.ts`, `apps/api/src/index.ts`, `apps/api/src/routes/inventory.ts` …
- `el-encanto-df90b0` (0.53 GB): 4 unique file(s), 3 differ from main's copy, 1 absent from main. `apps/site/src/App.tsx`, `apps/site/src/pages/Landing.tsx`, `apps/site/src/lib/wineOrigins.ts`, `apps/site/src/pages/Vinos.tsx`
- `el-encanto-4994e0` (0.50 GB): 1 unique file(s), 0 differ from main's copy, 1 absent from main. `docs/qa-product-sheet-unit.md`
- `web27-40c980` (0.30 GB): 1 unique file(s), 0 differ from main's copy, 1 absent from main. `scripts/photos.mjs`
- `web27-511ca0` (0.21 GB): 1 unique file(s), 1 differ from main's copy, 0 absent from main. `lab.html`
- `mantel-landing-10d8d0` (0.09 GB): 4 unique file(s), 3 differ from main's copy, 1 absent from main. `src/components/Hero.jsx`, `ventas.html`, `vite.config.js`, `comparativa.html`
- `mantel-design-money` (0.08 GB): 1 unique file(s), 0 differ from main's copy, 1 absent from main. `scripts/_m.tmp.mjs`
- `web27-fd4700` (0.02 GB): 34 unique file(s), 34 differ from main's copy, 0 absent from main. `mockups/redesign-a.html`, `mockups/redesign-a-contact.html`, `mockups/redesign-c-notes.html`, `mockups/redesign-b-quest.html` …
- `el-encanto-375d90` (0.02 GB): 1 unique file(s), 1 differ from main's copy, 0 absent from main. `docs/multi-cuenta-mesa-spec.md`
- `el-encanto-354ec8` (0.02 GB): 1 unique file(s), 1 differ from main's copy, 0 absent from main. `docs/multi-cuenta-mesa-ux.md`
- `operator-4fbc0` (0.01 GB): 1 unique file(s), 0 differ from main's copy, 1 absent from main. `dev/results/input-dead-research.md`
- `operator-521cc0` (0.01 GB): 1 unique file(s), 0 differ from main's copy, 1 absent from main. `dev/results/renderer-cpu-burn.md`
- `operator-4a1ec0` (0.01 GB): 1 unique file(s), 0 differ from main's copy, 1 absent from main. `dev/results/updater-bundle-config.md`
- `mantel-landing-4c9588` (0.01 GB): 1 unique file(s), 0 differ from main's copy, 1 absent from main. `docs/ventas-redesign/cerrar.html`
- `operator-311c00` (0.01 GB): 2 unique file(s), 0 differ from main's copy, 2 absent from main. `dev/results/skill-management-design.md`, `dev/results/session-settings-design.md`
- `operator-7d8780` (0.01 GB): 1 unique file(s), 0 differ from main's copy, 1 absent from main. `dev/results/session-settings-research.md`
- `operator-941778` (0.01 GB): 1 unique file(s), 1 differ from main's copy, 0 absent from main. `dev/briefs/2026-08-20-electron-shell-spike-RESULT.md`
- `el-encanto-830078` (0.02 GB): 0 unique file(s), 0 differ from main's copy, 0 absent from main; 4 commit(s) on no other branch. 
- `el-encanto-dfb638` (0.52 GB): 1 unique file(s), 0 differ from main's copy, 1 absent from main; 1 commit(s) on no other branch. `docs/qa-venta-rapida.md`
- `web27-44dde8` (0.05 GB): 5 unique file(s), 4 differ from main's copy, 1 absent from main; 3 commit(s) on no other branch. `assets/css/style.css`, `assets/js/data/projects.js`, `assets/js/main.jsx`, `index.html` …
- `el-encanto-f35ab8` (0.05 GB): 1 unique file(s), 0 differ from main's copy, 1 absent from main; 1 commit(s) on no other branch. `docs/qa-venta-rapida.md`

Seven `dev/results`/`dev/briefs` reports in `operator-*` worktrees exist only there: `input-dead-research`,
`renderer-cpu-burn`, `updater-bundle-config`, `skill-management-design`, `session-settings-design`,
`session-settings-research`, and a differing `electron-shell-spike-RESULT`. These are lane results that
never reached the main checkout. Copying them into `dev/results/` would make those five directories
(0.05 GB) removable. The disk gain is small; the main value is not losing the reports.

## Gaps ranked by GB recovered and risk

| # | Gap | GB it blocks | Risk of fixing | Fix (never deletes unsaved or uncommitted work) |
|---|---|---|---|---|
| 1 | G2 dirt counted as unsaved | ≈ 10.5 | Low | Ignore **provably non-work** dirt in `unsavedWorkOf`: an untracked file byte-identical to the same path in the source checkout or on the default branch; an untracked root `node_modules` symlink. For the `CLAUDE.md` edit, either commit it in the source repo, or treat a tracked-file change as preserved once it has been saved to `~/.operator/rescued/<dir>/<file>.patch` before removal (see 5). |
| 2 | G1 automation off | ≈ 12.4 (the whole safe set, once 1 lands) | Medium | Arm in stages. First `drainPending(false)` at boot: it already holds live, dirty and unknown folders (Review L1) and only retries removals the user started by closing a lane. Then the `wouldAutoRemove` rule for `createdBy: 'operator'` only, keeping backfilled and agent-made folders manual. |
| 3 | G3 interrupted close never retried | 0.57 today, grows | Low | The first half of 2. |
| 4 | G6 stale `sessions.json` claims | 0.01 today | Low | In `liveClaims`, keep a claim only when main's pty table (`livePtyCwds`) has a pty in that cwd. Main owns both. |
| 5 | Unique results stranded in worktrees (class D, `operator-*`) | 0.05, but the content matters | None | "Rescue" action in Settings: copy uncommitted and untracked non-ignored files plus a `git diff` patch into `~/.operator/rescued/<dir>-<date>/`. The directory's unsaved state then becomes "preserved". The user still presses remove. |
| 6 | G4 agent-made worktrees in the root; backfill adopts them | ≈ 0.3 | Medium | Backfill should record `createdBy: 'backfill-unverified'` for names outside `<project>-<6hex>`, and the auto rule should skip them. Tell lanes (orchestration note) to create extra worktrees under their scratchpad, not `~/.operator/worktrees`. **Investigate the gutted `mantel-55da80` separately.** |
| 7 | G7 debris and stuck trash | < 0.01 | None | Let Settings remove debris through the plain-directory path. Persist sweep failures to a log. List non-directory files in the root. |
| 8 | G5 ancestry-only merge label | 0 | None | Also run `git cherry <default> <branch>`: no `+` lines means "merged (by patch)". |

## One-off cleanup list for the user to approve

Do it through **Settings → Worktrees**: select the rows and remove. That path goes through the git
vouch check, the trash, and the second confirmation, and it keeps every branch. The dirty rows below
will show the unsaved-work step, because of G2. Each has been checked here to contain only the dirt
named.

**List 1 — nothing unique inside; branches kept (31 directories, ≈ 12.39 GB).**

- **Merged, dirt is only the vault-path `CLAUDE.md` edit:**
  - `el-encanto-6db458`, `el-encanto-abdbc0`, `el-encanto-1ef490`, `el-encanto-d22178`,
    `el-encanto-22a2b8`, `el-encanto-306eb0` (plus 2 copies of main files)
  - `mantel-landing-fa7798`, `mantel-landing-45c800`, `mantel-landing-22d6e8`, `mantel-landing-374c8`,
    `mantel-landing-3ff9d0`, `mantel-landing-8f5168`
  - `Operator-landing-78e140`
- **Merged, dirt is only byte-identical copies of main-checkout files:**
  - `operator-63cc58` (3.92 GB), `operator-808fe8` (3.05 GB), `operator-3b4cb8` (1.08 GB)
  - `operator-d16e40`, `operator-63f860`, `operator-192a68`, `operator-fe5a78`, `operator-3d7d10`,
    `operator-1aefa8`
  - `operator-db3d00`: stale claim `t20`; no process runs there. Settings will refuse it as live until
    G6 is fixed or its `sessions.json` record is cleared.
- **Merged, dirt is only an old `node_modules` symlink:** `el-encanto-f42a00`.
- **Clean, and every commit is in `main` or on `origin`:**
  - `mantel-3cdcc0` (pending since 09-17), `landing-fraunces`, `mantel-55da80-ledger`
  - `mantel-sec5`, `mantel-ee6740d`, `mantel-55da80-apifu`
  - `el-encanto-a53ef0` (node_modules symlink only)

  The mantel ones contain ignored test output (`apps/api/.uploads`, at most 5.6 MB, and `.test-build`).
  If any upload fixture is wanted, look first.

Caveat on the size: `du` counts APFS-cloned `node_modules` blocks in full. Only `mantel-3cdcc0` in this
list is from the clone era (created after 09-16). The rest are real installs or small, so the
≈ 12.4 GB estimate should hold within a few hundred MB.

**List 2 — needs a judgment call.**

- `el-encanto-bb3510` (0.54 GB): one commit only on `operator/bb3510`, patch already in `main` per
  `git cherry`. Its ignored `apps/site/public/photos/*.webp` look generated.
- `uwazi_2026-*` ×4 (0.46 GB): the source repo `~/Documents/Claude/uwazi_2026` no longer exists, and git
  cannot read these. Removal is plain-directory, and anything in them is lost. Look inside first.
- Debris: `.tmpIBNq7t-d96ee0` (8 KB, one stray file); `mantel-55da80b` (no git; `CLAUDE.md` identical to
  mantel's; a `.vite` temp dir); the four `*.log` files and `.DS_Store` in the root. They are not
  directories, so they must go through Finder or the shell.

**Do not remove:**
- classes D and E (21 directories, 3.0 GB): unique work, listed above;
- class L (5 directories, 2.27 GB): live lanes, including the gutted `mantel-55da80` while its lane runs.

## Method and limits

- Per directory:
  - `du -sk`;
  - `.git` → `gitdir` → admin entry → source repo;
  - `git worktree list --porcelain` per source repo for "registered";
  - `rev-parse --abbrev-ref HEAD`;
  - `status --porcelain` (untracked normal);
  - `merge-base --is-ancestor HEAD main` and `cherry main HEAD`;
  - Operator's own unsaved-commit query:
    `rev-list --count HEAD --not --exclude=<branch> --branches --remotes`;
  - `@{u}` and the ahead count. No fetch, so remote state is as of the last fetch.
- Per dirty file: byte comparison with the same path in the source working tree and on `main`. For
  `CLAUDE.md`, a check that every changed line is the vault line.
- Ignored files: `status --ignored` in the safe set, excluding build output (`node_modules`, `dist`,
  `out`, `.vite`, and the like).
- "Last modified" is the later of the directory mtime and the HEAD commit time. A directory's mtime
  changes only when a direct child changes, so deep edits may be newer.
- Not done: checking what created each agent-made worktree, and the root cause of the gutted
  `mantel-55da80`.
