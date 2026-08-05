# The coordinator never gets a worktree, and lane worktrees stop inheriting stale HEAD

User, 2026-08-05: *"a lot of work gets lost in worktrees, and sometimes stale branches are picked
up… operator should not have worktree option then."*

Measured before writing this: **33 worktrees**, 9 unmerged commits across 6 branches, most branches
30–137 commits behind main, one worktree holding **52 uncommitted files**. Already done by Operator:
merged the 3 recoverable branches, reaped 8 clean+merged worktrees (33 → 25). This brief is the code
half so it stops recurring.

## Part 1 — the coordinator runs in the main repo, always

`src/renderer/lib/roster.ts:191` presets the coordinator with `useWorktree: true`. It must be
`false`, **and the option must not be offered for coordinator roles at all.**

- `roster.ts` — `rolePresets`: coordinator (`operator`) becomes `useWorktree: false`.
- `RosterPanel.tsx:941-944` — the worktree toggle must not render for a role where
  `isCoordinator(role.id)`. Don't just hide it silently: the row should say the coordinator runs in
  the repo itself, so the absence reads as a rule rather than a missing control.
- `RosterPanel.tsx:1299` and `AgentsHubView.tsx:178,202` display worktree state — suppress the
  `· worktree` affordance for coordinator roles so no surface implies it's still a choice.

**⚠ A preset change is not enough — 5 projects have `useWorktree: true` PERSISTED on their
coordinator role** (`importer`, `operator`, `el-encanto`, `web27`, and one more; the other 10 are
`undefined` and will follow the preset). Handle both:
1. **Force it at launch** — wherever the launch path reads `useWorktree`, a coordinator role
   resolves to `false` regardless of the persisted value. This is the load-bearing fix; do it even
   if you also migrate.
2. **Backfill** the persisted `true` values on coordinator roles so the stored data stops lying.

**Interaction to check, not assume:** `prune-seeded-lanes.ts:77` decides "is this a stock lane" via
`role.useWorktree !== undefined && role.useWorktree !== preset.useWorktree`. Changing the preset
changes which lanes count as stock, which changes pruning behaviour. Verify the seeded-lane tests
still mean what they meant.

## Part 2 — lane worktrees must not branch from the caller's HEAD

`src-tauri/src/worktree.rs:80`:

```rust
git(&root, &["worktree", "add", "-b", &branch, &path_str, "HEAD"])?;
```

`HEAD` is the **invoking checkout's** head. A coordinator in a stale worktree therefore hands its
staleness to every lane it launches — which is exactly the "stale branches picked up" the user
reported, and is why branches sit 48–137 commits behind. Part 1 makes the common case correct (the
coordinator is on main, so HEAD is current), but the fragility should go too.

Resolve the base explicitly: branch from the repository's **default branch** (`main` — derive it,
e.g. `git symbolic-ref refs/remotes/origin/HEAD` with a `main`/`master` fallback; do not hardcode).
Keep returning it as `base_branch` in `WorktreeCreateResult` so the UI can show what a lane forked
from. If the default branch genuinely can't be resolved, fall back to today's `HEAD` behaviour
rather than failing the launch — a lane that starts is better than a lane that doesn't.

## What NOT to do in this pass

- Don't remove worktrees for non-coordinator lanes. 14 parallel lanes cannot share one checkout;
  worktrees are correct for them.
- Don't add automatic worktree deletion. Reaping is destructive and one worktree currently holds 52
  uncommitted files. If you want to propose a reaper, write it up in the RESULT — don't ship it.

## Verify

- A project whose coordinator had `useWorktree: true` persisted: launching the coordinator now runs
  in the repo root, not a new worktree.
- The worktree toggle is absent for coordinator roles and present for the others.
- A newly launched worker lane's branch is 0 commits behind `main` at creation (this is the whole
  point — check it, don't assume).
- `base_branch` still populates in the launch UI.
- `npm test` green (624 on `main` = `b52e044`), `npm run build` clean, `cargo check` clean.

## Output

Write `/Users/juanmnl/.operator/worktrees/operator-3b4cb8/dev/briefs/2026-08-05-coordinator-no-worktree-RESULT.md`
(absolute path): what changed, how the 5 persisted `true` values were handled, what the default-branch
resolution does when it can't resolve, and the `isStockLane` interaction.
