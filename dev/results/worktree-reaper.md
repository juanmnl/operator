# The worktree reaper

**Branch:** `operator/a30080` · commit `7c62037` · 2026-08-24 · Code lane
**Built from:** `dev/results/worktree-lifecycle-audit.md` (copied onto this branch)
**Armed?** **No.** `AUTO_REAP_ON_TRIGGERS = false`. Nothing was deleted building this — verified
after the fact: still 108 directories, 34 GB, and no pending-removal file was written.

---

## What the audit said, and what that meant for the build

> the removal logic is not what is broken.

`dangerousRemovalReason` and `removeWorktree` are careful, well-tested, and are **reused
untouched**. Every line of new code is either a classifier deciding *what may be touched*, or a
trigger calling the existing removal *at a moment nothing was calling it before*. That framing
kept the diff away from the one part of this system that already works.

## The classifier

`electron/src/main/worktree-reap.ts`, pure, 27 unit tests against a fabricated table.

Eight classes. The audit names seven; **`corrupt` is the eighth**, and it comes from the audit's
own policy section (*"git-corrupt but registered or provenance-attributable … something is wrong
with these that a script shouldn't paper over silently"*). None of the seven describes that
truthfully, and labelling it with a reason that isn't true seemed worse than adding a class.

**Precedence is the policy**, so it is written down rather than left implicit:

1. **`live-claimed`** first — nothing below can out-argue an open lane.
2. **`debris`** next, and it is the one class that is *not* a git question. Size + provenance +
   registration separate an interrupted `worktree add` from a real worktree that broke, and none
   of those tests needs the source repo.
3. **`dead-source-repo`** — every rule after it asks git something that needs the repo to exist.
4. **`corrupt`** for the rest of what git cannot read.
5. **`unattributed`** *before* any merge-based class, because attribution is the **gate** on the
   automatic tier. A merged, clean, unattributable directory is an ask, not an auto — the
   codebase's own stated rule (`worktree.ts:79-81`) is that the reaper removes only what Operator
   can prove it made.
6. **`unmerged`** — including when git could not answer. An unknown is not a "no", but it is
   certainly not grounds to delete, and `unmerged` is the class whose meaning is *ask a human*.
7. **`merged-dirty`** / **`merged-clean`**.

### Two findings from running it against the real disk

**1. `dead-source-repo` was unreachable for exactly the directories it was written for.** My
first version derived the source repo from the provenance record — but the four `uwazi_2026-*`
directories (471 MB, repo deleted) *have no provenance*, which is why the audit found them in the
first place. They classified as merely `corrupt`, which hid the one case the audit says a human
must decide. Fixed by reading the worktree's own `.git` pointer file:

```
gitdir: /Users/juanmnl/Documents/Claude/uwazi_2026/.git/worktrees/uwazi_2026-a5d0i5
```

This is **not** attribution — it does not make anything removable — it only lets a directory name
its repo so we can ask whether that repo still exists.

**2. Ordering `debris` after the dead-repo rule made an 8 KB husk into a human decision.**
`.tmpIBNq7t-d96ee0` is 8 KB, holds one stray file, and its repo is also gone. Both facts are
true; only one should decide, and the audit is explicit that debris is *"zero risk, zero value in
asking"*. Debris is now tested first. Both cases are pinned by tests.

## The automatic tier

Merged (clean, or dirty and committed first) **+** attributable **+** not live **+** accepted by
the guard, plus debris. Everything else is returned as an ask and never removed.

- `commitAll` runs on **every** non-debris entry, not just the dirty ones. It is a documented
  no-op on a clean tree, and running it unconditionally means the "was it clean?" answer cannot
  go stale between the plan and the removal. A failed commit **skips** the directory — the whole
  point of committing first is that no uncommitted work is lost.
- This is what closes defect #8: 35 directories were quarantined by a blunt "any porcelain output
  = don't touch" rule, and inspecting the largest showed a single `M CLAUDE.md`.
- **The guard is consulted for the plan, not only at removal time.** A button that says "Remove
  24 safe worktrees" and then removes 23 is a worse button than one that says 23.
- **The branch always survives.** Only the directory goes, which is what a suspended lane's
  reattach path expects to find.

## Triggers — the part that was actually missing

| Defect | Fix |
|---|---|
| **#1** quit never touched worktrees | `reapOnQuit()` in `teardown()`, **awaited**, **in main**. Both halves matter: awaited so the app cannot exit out from under the removal, in main so a renderer respawn cannot take the continuation with it. Bounded by the same 4s teardown deadline — an app that cannot be quit is worse than a directory that survives one more launch. |
| **#2** removal lived in un-awaited renderer JS | `worktree-pending.json`. The intent is written **before** the attempt; the record is cleared after. A crash after the record is recoverable (boot retries); a crash after the removal is recoverable (the retry finds the directory gone and drops the record). The only unrecoverable order is the one this replaces — no record at all. **The renderer did not have to change**: the existing `worktreeRemove` IPC now routes through `removeWorktreeDurably`. |
| **#3** a lane that ends by itself never gets removed | `queueEndedSessions()` at boot: any session with a `worktreeBranch`, a directory still on disk, and no `terminalId` gets a pending record. Its only previous removal trigger was the user dismissing a renderer-only tab that never survived a restart. |
| **#5** no boot reconciliation | `reconcileAtBoot()`, not awaited (nothing about opening the window depends on it), never throws. |

## The surface

`worktreeReapPlan()` on the bridge (read-only — computing the plan removes nothing) and a
**Worktrees** tab on the existing `PageShell`, listing every directory grouped by class with
sizes, one sentence per class saying what will and won't happen to it, and a single
**"Remove N safe worktrees (X GB)"** button behind a confirm. That button is the only caller in
the entire app that ever passes `dryRun: false`, and only on a press.

This closes defect #4 — there was previously no way to even *audit* these directories from inside
the app; the audit itself had to be built by shelling out to `git` and `du` by hand.

Sizes are one `du -sk` over the root's children. The boot and quit sweeps **skip them** — the auto
tier's decision does not depend on size, only its presentation does, and quit must not wait on a
34 GB stat walk.

## Dry run against this machine

```
TOTAL 108 dirs, 34.05 GB
  unattributed         47  17.05 GB     ask
  merged-clean         20  10.62 GB     AUTO
  live-claimed         24   5.16 GB     never touched
  unmerged              2   0.73 GB     ask
  dead-source-repo      5   0.46 GB     ask
  merged-dirty          2   0.03 GB     AUTO (commit first)
  debris                6   0.00 GB     AUTO
  corrupt               2   0.00 GB     ask
AUTO 28 dirs, 10.65 GB   ASKS 79
```

Totals match the audit almost exactly (107→108 dirs, 34.0→34.05 GB; live-claimed 23→24). The
auto tier is **10.65 GB against the audit's predicted 11.85 GB**, and the gap is explained rather
than mysterious: the audit's 24-directory "merged + clean + not live" set is measured *before*
the attribution gate, and four of those have no provenance record — so they correctly land in
`unattributed` instead, exactly as the audit's own policy section says they should.

**`unattributed` is now the largest bucket: 47 directories, 17.05 GB.** That is defect #6 grown
from the audit's 37, and it is the single biggest decision waiting for the user. These are
disk-safe (merged, clean) but Operator cannot prove it created them, so a human has to stand in
for the missing proof. The Worktrees tab is where that happens.

## Not armed, and how to arm it

One constant, `AUTO_REAP_ON_TRIGGERS` at the top of `worktree-reap.ts`, currently `false`. While
it is false, boot and quit compute the plan and log it and remove nothing. Flip it after looking
at the plan on a real machine; nothing else changes. The Settings button works today regardless —
it is an explicit user action, not a trigger.

## Checks

| | |
|---|---|
| `tsc --noEmit -p electron/tsconfig.json` | **0** |
| `tsc --noEmit` (root) | **0** |
| `vitest run` (electron) | **314 passed, 0 failed** (was 287) |
| `npm test` (root) | **800 passed / 33 failed** — the 33 unchanged |
| Nothing deleted | 108 dirs / 34 GB before and after; no `worktree-pending.json` written |

27 new tests: every class, precedence between them (attribution before merge, debris before dead
repo, live over everything), the guard pulling an entry out of auto, unknown-merge handling, the
`.git` pointer parse, and the audit's own four measured shapes replayed through the classifier.

## Not verified

The **removal** path has not been exercised — deliberately, per the brief. `commitAll` +
`removeWorktree` are existing, tested code, but the reaper calling them in sequence has only ever
run in dry-run. The first real run should be the Settings button on a machine where the plan has
been read, not an armed trigger.
