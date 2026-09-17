# Per-lane "own worktree" setting (2026-09-16)

Commit `383921f` on `operator/lane-worktree-setting`, branched from `operator/worktree-cleanup-stage1`
(`4712abc`). It is based on stage 1 on purpose: the project-path guard goes into `removeWorktree`
and `removePlainDirectory` as stage 1 rewrote them. On `main` it would need a second version
against the old `git worktree remove` code. Merge stage 1 first.

Not GUI-verified. Nothing was removed on this machine; the removal tests ran in a temp
`OPERATOR_DIR` sandbox. `~/.operator/projects.json` was only read.

## The brief's premise, checked

The brief said every lane launch creates a worktree. It does not. The per-lane setting already
exists, under a different name:

- **Field:** `Role.useWorktree` (`src/shared/types.ts`), a tri-state: `true`, `false`, or absent.
- **Resolution:** `resolveAgentConfig` (`src/renderer/lib/model-config.ts`) takes the lane's pin,
  then the preset (`rolePresets()` in `roster.ts`), then `HARD_FALLBACK` (off). A coordinator is
  always off, whatever is pinned.
- **Editing:** RosterPanel shows an On/Off control per lane (clicking the lit option clears it back
  to the default). For the coordinator it says "runs in the repo".
- **Launch:** there are two `worktreeCreate` call sites in `DashboardView.tsx`.
  `handleLaunchSession` creates a worktree only when `config.useWorktree` is true, and
  `handleLaunchRole` passes the resolved value. `handleRestoreSession` rebuilds a worktree only
  for a saved session that had a `worktreeBranch`.
- **Close:** it calls `worktreeRemove` only when the tab has `worktreeBranch` and `sourceCwd`. A
  lane launched without a worktree has neither, so nothing is removed and no provenance is
  written.

So I reused `useWorktree` instead of adding `ownWorktree`. A second field would give two sources
for one decision. What actually differed from the brief was the Research default, suspended lanes,
the launch-brief line and the main-process guard.

Real store, read-only: every stored lane has no `useWorktree` value (7 code, 7 design, 15 operator,
6 qa, 7 research, 6 review), except one qa and one review pinned `false`. They all take the default
for their role.

## What changed

1. **Defaults** (`roster.ts` presets): Research `true` → `false`. The result is Code on, Design on
   (per the correction), and Review, QA, Research, custom lanes and the coordinator off. Stored
   rosters have no value for these lanes, so they take the new default by role id at resolve time.
   Nothing is written to `projects.json` on load. `isStockLane` (seeded-lane prune) compares only
   stored values, and none is stored for Research, so the prune is unaffected.
2. **Suspended lanes keep what they have** (`src/renderer/lib/lane-workspace.ts`,
   `launchWorkspace`). A suspended lane relaunches with a worktree exactly when its record has a
   `worktreeBranch`, whatever the setting says now. A setting change takes effect on the lane's
   next fresh launch. Running lanes are untouched. `handleRestoreSession` already uses the saved
   `cwd`.
3. **Launch-brief line** (`roster.ts`, `SHARED_CHECKOUT_NOTE`). This is appended to a
   non-coordinator lane's orchestration note when it launches without a worktree: "You work in the
   project's main checkout, shared with other lanes: do not commit, switch branches, stash, or edit
   tracked files; write results only under dev/results/." The coordinator also runs in the main
   checkout but does not get it, because it merges and commits there.
4. **Hard guard in main** (`worktree.ts`, `projectPathReason`). `removeWorktree` and
   `removePlainDirectory` refuse any path that is, or contains, a `path` in `projects.json`. It runs
   before the git checks, so every removal path goes through it: lane close, Settings, the safe
   button, merge, discard and the pending drain. Lane close also skips removal when
   `tab.cwd === tab.sourceCwd`.

## Tests and results

- `src/renderer/lib/lane-workspace.test.ts`:
  - default resolution by role with nothing stored (code/design on; research/review/qa/custom/
    coordinator off);
  - a pin wins either way;
  - resolving never adds the field to the stored role;
  - `launchWorkspace`: fresh launch follows the setting, the coordinator doesn't get the line, a
    suspended lane resumes where it was in both directions;
  - the brief line is present only when shared, names every rule, and the note stays under the
    3300-character guard.
- `model-config.test.ts`: the preset-defaults test is updated for Research.
- `electron/src/main/worktree.test.ts` (sandbox):
  - `removeWorktree` refuses a registered project path;
  - `removePlainDirectory` refuses a project registered directly under the worktree root, and a
    directory containing one; all files stay;
  - a worktree of a registered project is still removable.
- Root `tsc --noEmit -p .`: pass. `electron` `tsc -p tsconfig.json` and
  `tsc -p tsconfig.renderer.json`: pass.
- Electron suite: 32 files, 612 passed, 0 failed.
- Renderer suite (`vitest run src/renderer`): 83 files, 1266 passed, 0 failed.
- Run with the main checkout's `node_modules` and `electron/node_modules` symlinked in, removed
  after.

## Not covered, and risks

- **The launch path itself is not exercised by a test.** `handleLaunchSession`/`handleLaunchRole`
  live in `DashboardView.tsx`, which has no test harness. The decision is extracted into
  `launchWorkspace` and tested there. The wiring is two lines, read but not run.
- **One-time migration, if its flag is lost.** `migrateGlobalsToLanePins` runs once, gated by a
  localStorage flag. It compares each lane against the deleted global tier, and
  `~/.operator/role-defaults.json` still says `research: { useWorktree: true }`. It has already run
  on this machine. If that localStorage entry were ever cleared, a re-run would now see Research
  disagree and write `useWorktree: true` onto the 7 stored Research lanes, rewriting `projects.json`
  on load and keeping them isolated. I did not change the migration, because its worktree
  behaviour is a tested contract. The simplest fix, if wanted, is to exclude `useWorktree` from it
  the same way the coordinator is excluded.
- **Guard limit.** `loadProjects` reads a missing or corrupt `projects.json` as `[]`, so the
  project-path guard then has nothing to compare against. `dangerousRemovalReason` still refuses
  the source repo itself and `$HOME`.
- **Research lanes running now** in worktrees keep them until closed. A suspended Research lane
  goes back onto its worktree branch. Only fresh launches move to the main checkout.
- **The brief line is an instruction to the agent, not an enforcement.** Nothing stops a
  main-checkout lane from committing.
