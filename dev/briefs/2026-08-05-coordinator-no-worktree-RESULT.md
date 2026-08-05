# RESULT — the coordinator runs in the repo, and lanes fork from the default branch

Branch `operator/ac9328`, on `b52e044`. `npm run build` clean · `npm test` **632 passed** (624 + 8)
· `cargo check` clean · `cargo test` **130 passed** (125 + 5).

---

## Part 1 — the coordinator never gets a worktree

**The load-bearing fix is in `resolveAgentConfig`, not in the preset.** The preset change alone
would only have reached the 10 projects whose coordinator was `undefined`; the 5 with a persisted
`true` would have carried on exactly as before.

```ts
const useWorktree = isCoordinator(role.id)
  ? false
  : [role.useWorktree, preset?.useWorktree].find(setBool) ?? HARD_FALLBACK.useWorktree
```

It **overrides the pin instead of ranking below it** — the only field in the cascade that does.
That inversion is the point: a migration is a one-shot on data we can see, and this has to hold for
a roster restored from a backup, synced from another machine, or hand-edited. It is keyed on
`isCoordinator`, so the pre-rename `orchestrator` id is covered too.

Because that one function is the single resolver, it fixes every surface that reads it at once —
the launch path (`handleLaunchRole` → `settings.useWorktree`), the AgentsHub cards (both live and
idle), and the roster toggle's value. `handleLaunchSession` is called from exactly **one** site
with a `roleId`, and it reads the resolver, so there is no second launch path to miss. (The resume
path spawns into a session's existing `cwd` and creates no worktree.)

**Changed as well:** `rolePresets()` coordinator → `useWorktree: false`, and the two surfaces that
read the raw pin rather than the resolver — `RosterPanel`'s compact `· worktree` chip and the
command palette's `Launch …` detail — now read the resolved value, so neither advertises a worktree
the launch will not create.

### The 5 persisted `true` values

Handled **both** ways the brief asks, and they are doing different jobs:

1. **Forced at launch** — above. This is what makes the behaviour correct today, with no migration
   in the picture.
2. **Backfilled** — `clearCoordinatorWorktree` (`lib/model-config.ts`), composed into the hydrate
   chain beside `clearSeededRoleFields`, so `projects.json` stops saying something untrue.

**It DELETES the pin rather than writing `false`.** The pin means "I chose this", and nobody chose
it — a preset wrote it. Writing `false` would swap one fiction for another and leave the lane
looking deliberately opted out of a choice it is not offered. Absent is the truth: it inherits, and
what it inherits is now a rule. It clears a persisted `false` for the same reason. Same shape as
its neighbour — returns the identical object when there is nothing to do, so hydrate early-bails
and a second run is free.

### The toggle is gone for coordinators, and says so

`RosterPanel` renders, in the slot the control occupied, a muted **"runs in the repo"** with a
title explaining why. Not a silent absence (reads as a bug, or as something you failed to find) and
not a disabled segmented (a greyed control still implies it could be un-greyed). Verified in the
running app — coordinator card: `segmenteds: [model, effort]`, note present; `code` and `research`:
`segmenteds: [model, worktree, effort]`, no note.

### ⚠ The interaction I did NOT find where the brief pointed — I found a worse one

The brief flagged `prune-seeded-lanes.ts:77`. That one is real but **inert**: a coordinator with a
persisted `true` now *differs* from its preset, so `isStockLane` calls it a decision rather than
stock — but the coordinator is a **floor lane**, and `isPrunable` refuses it before `isStockLane` is
consulted. Inert, and inert in the safe direction ("not stock" means "keep") even if the floor were
ever removed. No other preset moved, so no other lane's stock-ness changed. Pinned as a test rather
than left as a claim.

**`migrateGlobalsToLanePins` was the actual hazard, and it is not mentioned in the brief.** It
writes a pin wherever the old cascade and the new one disagree — and the deleted global tier
(`role-defaults.json`) is exactly where the coordinator was told to isolate. So on the same hydrate
that deletes the pin, the migration would have **dutifully re-created it**, from a file we no longer
read. Caught by three failing tests, not by reading. Fixed at the source: `useWorktree` is skipped
for coordinator roles, because a rule cannot be migrated back into a preference.

---

## Part 2 — lanes fork from the default branch, not the caller's HEAD

`default_base(root)` in `worktree.rs`, then `worktree add -b <branch> <path> <base>`.

**Two steps, because they are different questions.** The *name* is a property of the repository and
is derived, never hardcoded: `git symbolic-ref --quiet refs/remotes/origin/HEAD` →
`refs/remotes/origin/main` → `main`, with `main`/`master` as candidates only for a repo that has
never had a remote. Then the *commit-ish*, and here the **local branch wins over `origin/<name>`**:

> this project merges lane branches into local `main` and pushes later, so `origin/main` is
> routinely behind by exactly the work just merged. Forking from the remote ref would drop it —
> the same defect pointing the other way, and subtler, because the branch would look current
> against the remote.

**When it cannot resolve** — no `origin/HEAD`, no local or remote `main`/`master` (a detached
checkout, or a repo whose only branch is named something else with no remote) — `default_base`
returns `None` and the caller falls back to `"HEAD"`, i.e. exactly today's behaviour. A lane that
starts from a stale base is worse than one that starts current; both beat a launch that fails.

**`base_branch` now reports what the lane actually forked from**, not `info.branch` (the caller's
current branch). Those were the same thing before and are not any more, so reporting the caller's
branch would describe a fork that did not happen. It is still populated on every path — the
fallback returns `Some("HEAD")` rather than `None`.

### Verified in Rust, hermetically (5 new tests)

| Test | What it pins |
|---|---|
| `default_base_prefers_the_repos_own_default_over_the_callers_head` | on `operator/stale`, still resolves `main` — the defect itself |
| `default_base_derives_the_name_from_origin_head_rather_than_assuming_main` | a real clone whose default is `trunk` resolves to `trunk`; hardcoding `main` would silently fall back to HEAD |
| `default_base_takes_the_LOCAL_branch_so_merged_but_unpushed_work_is_not_dropped` | fixture asserts the clone is genuinely ahead of `origin/main`, then that the base resolves to the local rev |
| `a_new_lane_is_zero_commits_behind_the_default_branch` | **the brief's acceptance test**: launch from a branch cut before `main`'s latest commit; `rev-list --count <lane>..main` is `0`, and `base_branch` is `main` |
| `create_worktree_still_starts_a_lane_when_no_default_branch_resolves` | no `main`, no remote → `default_base` is `None`, the lane still starts, `base_branch` is `HEAD` |

---

## Verify — each bullet

| Bullet | Result |
|---|---|
| Coordinator with `useWorktree: true` persisted launches in the repo root | Unit: `resolveAgentConfig(role({id:'operator', useWorktree:true})).useWorktree === false`, plus the same for `orchestrator`. The launch path reads that resolver at its one call site |
| Toggle absent for coordinators, present for others | Verified in the running app (DOM): coordinator `[model, effort]` + note; workers `[model, worktree, effort]` |
| A new lane's branch is 0 commits behind `main` | `a_new_lane_is_zero_commits_behind_the_default_branch` — measured with `rev-list --count`, launched deliberately from a stale branch |
| `base_branch` still populates | Asserted in both Rust tests (`main`, and `HEAD` on the fallback). Always `Some` now |
| `npm test` / `npm run build` / `cargo check` | 632 · clean · clean (and `cargo test` 130) |

## Not done / worth knowing

- **No reaper**, per the brief. If you want one later, the shape I would propose: a *reporter*
  first — list worktrees with `(branch, commits ahead of main, uncommitted file count, last commit
  date)` and reap **nothing** automatically; a candidate is only ever "merged into main **and**
  `git status --porcelain` empty **and** no live pty", and even then it should be a one-click
  action per row with the numbers visible, never a background sweep. The 52-uncommitted-files
  worktree is the argument for exactly that ordering.
- **`worktreeStateOf` is unchanged.** It still reports `inherit`/`on`/`off` from the raw pin, which
  is now unreachable for coordinators (the control that consumed it does not render for them). Left
  alone rather than special-cased for a caller that no longer exists.
- **The backfill has not been run against the real store** — it runs on hydrate in the app, which
  is yours to launch. Its behaviour is covered by 5 unit tests including idempotence.
- **Existing worktrees and branches are untouched**, including the 5 coordinators currently sitting
  in one. They keep running where they are; the rule applies to the next launch.
