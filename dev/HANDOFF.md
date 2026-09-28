# Handoff — 2026-09-28

`main` = `8d607ce` (pushed). **0.27.1 published** (`electron-v0.27.1`, lightweight, run `36464485209`
green). Verified: `operator-releases` v0.27.1 is not a draft and has six assets (dmg, zip,
`Operator.app.tar.gz`, `latest.json`, `latest-mac.yml`, `SHA256SUMS.txt`); `latest-mac.yml` and
`latest.json` at `releases/latest/download/` both serve 0.27.1, `latest.json` with a signature for
`darwin-aarch64`.

Juan has **not installed 0.27.1 yet**. It is the first update through 0.27.0's updater: check
`~/.operator/updater.log` for `requested by Squirrel.Mac` before the restart prompt. Installing quits
the app, which stops every lane in every project (the dialog names busy ones; "Not now" installs at the
next quit). Conversations resume with `--resume`, but lanes restart on their own only if Settings →
"Resume on launch" is on, and then only for the last project.

## Verification state

- **Nothing in 0.27.1 is GUI-verified.** Worth trying by hand or through QA after the update:
  1. A dispatch to a role whose idle lane called `worktree_done`: the old lane ends, a fresh one starts
     in a new worktree with the task.
  2. Two dispatches in quick succession: one new lane, not two.
  3. A dispatch to a busy released lane: refused, then one message to the coordinator when it is idle.
- 0.27.0: only refocus-on-activation is GUI-verified (see git history of this file for the rest).
- Tests on `main` @ `5a390f0` (after the merge, before the release commit): root tsc clean, 1663
  tests; electron typecheck clean, 802 tests.

## What shipped in 0.27.1 (release notes: `electron/release-notes/0.27.1.md`)

**Retire a released lane on dispatch.** Branch `operator/917d80`, commits `8cc53fd`, `5406dfd`,
`8a9ca5a`, `d4d07ec`, merged at `5a390f0`. Result: `dev/results/retire-released-lane-2026-09-27.md`.
Review, four rounds: `dev/results/retire-released-lane-review-2026-09-27.md`.

- **Cause.** Coordinators in other projects (mantel, after #436 and #437) kept asking Juan to close
  the Code lane. 0.27.0's `BRANCH_SAFETY_NOTE` says new work needs a fresh worktree, a project has one
  live lane per role (`b220799`, July), dispatch resolved the role to the lane that had already called
  `worktree_done`, and a coordinator has no way to end a lane.
- **Now.** `routeDispatch` (`lib/dispatch.ts`) returns `retire` for a released lane between turns and
  `finishing` for a busy one. Main exposes open `worktree_release` rows (`pendingReleases`).
  - Retire: the task is persisted, the old lane is closed without a WIP commit (main's keep-if-dirty
    rule decides the worktree), and the fresh lane launches only after the close is confirmed.
  - Finishing: refused once; `lib/retire-watch.ts` sends the coordinator ONE message when the lane is
    idle, took work, ended, or after 30 min.
  - New work cancels a release: main watches the transcript for a real prompt taken up after
    `worktree_done` (user record or mid-turn `remove`, not the enqueue), and the renderer cancels on
    submission. `shared/prompt-kind.ts` keeps replies and `[Operator]` notices from counting.
  - `mcp__operator__reply` now carries its kind through the bus tick: a reply goes to a live lane or
    is refused, never retires or launches. Bus replies are no longer held for approval (same brakes as
    `OPERATOR-REPLY`); a reply from a caller with no roster role is refused.
  - The keep-warm lifecycle ends a released lane instead of suspending it.
  - `RETIRE_NOTE` in the coordinator brief: a dispatch is enough, follow-up work for a released lane
    is a dispatch, never a reply, and never ask the user to close a lane.
- **Accepted gaps.** Short window where a lifecycle close and a dispatch leave two lanes on the role
  (R3-5). A joined dispatch's task is lost if the renderer restarts mid-retire. A record can stay
  `retiring` after a respawn mid-retire (R4-1). One-frame race in the alive check (R4-2). Suspended
  records saved before 0.27.1 still resume on their old branch. Human Send / Start all and the
  RosterPanel Launch button still type into a released lane.

## In flight

- **Lanes as profiles, steps 1-3 — brief written, NOT sent.** Brief:
  `dev/results/lane-profiles-steps-1-3-brief-2026-09-28.md` (dispatch with its absolute path). Plan: `dev/results/lane-profiles-plan-2026-09-25.md`.
  The earlier Code lane that had steps 1-3 was gone with no branch, so the work starts from zero.
  The brief corrects the plan: session names are `<slug>--<role>` with `--<n>` for n ≥ 2
  (`lib/bus-name.ts`), 0.27.1's retire routing must stay unchanged, and the plan's line numbers are
  stale. Output: `dev/results/lane-profiles-steps-1-3-2026-09-28.md`.
  - **Blocked on a fresh Code lane.** The only Code lane (`operator-78f2--code`) is the released
    917d80 lane, and the running app is 0.27.0, so a dispatch would type into it. Either Juan closes
    it (safe: everything is in `main`), or installs 0.27.1 and the dispatch retires it (which is also
    GUI check 1 above).
  - Step 12 (UI) needs Design's answers to the plan's §4 questions, not yet dispatched.
- **Settings → Worktrees: "Remove selected" is out of view.** The button sits below every group, so
  ticking rows looks like it does nothing. Offered Juan a sticky action bar while anything is ticked;
  no answer yet, nothing dispatched.
- **Renderer memory (1.26 GB live) is unexplained.** Unchanged from 2026-09-26: next step, if wanted,
  is a heap snapshot of the real app. Baseline: `dev/results/perf-baseline-2026-09-25.md`.

## Worktrees

Unchanged from 2026-09-26: about 12.4 GB of `~/.operator/worktrees` is safe to remove
(`worktree-cleanup-audit-2026-09-25.md`, List 1); Juan removes them through Settings → Worktrees.

## Gotchas

- **Reports live in `~/.operator/artifacts.db`**, table `reports` (not `chat.db`):
  `sqlite3 -line ~/.operator/artifacts.db "select summary from reports where id=N"`.
- **Launching a dev instance of Operator:** `electron/` `npm run dev` with `OPERATOR_DIR` set to a
  scratch dir; `OPERATOR_ELECTRON_PORT` picks the Vite port (strict), `OPERATOR_CDP_PORT` opens CDP.
  Never the root `npm run dev` (Tauri-era).
- **Test lanes are real agents.** Don't leave them running unattended.
- **Late reports** arrive oldest-first; check the commit is already merged before acting on one.
- **Merges into `main` are Juan's** (run via `!`); pushes and tags on his explicit go-ahead.
- **Transcript search:** directory names under `~/.claude/projects` start with `-`, so `ls -t */*.jsonl`
  fails; use `./*/*.jsonl`.
