# Handoff — 2026-09-29

`main` = `f988145` (pushed). Nothing to release: the only commit since `electron-v0.27.1` is the
2026-09-28 handoff.

**0.27.1 is installed on Juan's machine.** The update went through 0.27.0's updater on 2026-09-28 at
23:58 local: `~/.operator/updater.log` shows `requested by Squirrel.Mac`, `quitAndInstall(0.27.1)`, and
the app relaunched 2 s later. That is the first update the new updater has installed. Juan saw the
restart as a crash; it was not one (no crash reports).

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

- **Research lane is working on the umbra scrollback freeze.** Juan saw scrollback freeze again on
  0.27.1 in umbra's coordinator pane. 0.27.0's `resyncViewport` runs only on pane hide/show, so the
  task is to find the path it does not cover (scrollback cap trims during long output, pty batching,
  alt-screen, resize, non-active project, renderer respawn). Task `6815af4f`. Output:
  `dev/results/scrollback-freeze-again-2026-09-29.md`. No report yet. Asked Juan whether switching
  project and back unfreezes it, and whether the session was long; no answer yet.
- **Missing input rules: not reproduced** (report #1746, `dev/results/terminal-missing-input-rules-2026-09-29.md`,
  uncommitted until now). The `─` rules above and below the `❯` prompt were blank on screen in a
  uwazi_app lane. Research replayed real Claude 2.1.284 streams at 25-120 cols with chunking and
  resizes: rules are present in the buffer, the DOM and Chromium's pixels. The screenshot footer read
  `← for agents` (subagents/background tasks running), a state Research could not capture. Leading
  guess: Claude omits the rules in that state. Next sighting: Juan enables the ghost probe
  (`localStorage.setItem('operator.terminal.ghostProbe','1')` in DevTools, View → Reload), then
  Ctrl+Alt+Shift+G without clicking the pane, and pastes the output. Research's harness is in
  `dev/results/_scratch/` (untracked, ~1 MB of captures; delete once the freeze task is done).
- **Lanes as profiles, steps 1-3 — brief written, NOT sent.** Brief:
  `dev/results/lane-profiles-steps-1-3-brief-2026-09-28.md` (dispatch with its absolute path). Plan: `dev/results/lane-profiles-plan-2026-09-25.md`.
  The earlier Code lane that had steps 1-3 was gone with no branch, so the work starts from zero.
  The brief corrects the plan: session names are `<slug>--<role>` with `--<n>` for n ≥ 2
  (`lib/bus-name.ts`), 0.27.1's retire routing must stay unchanged, and the plan's line numbers are
  stale. Output: `dev/results/lane-profiles-steps-1-3-2026-09-28.md`.
  - **Ready to dispatch.** 0.27.1 is installed, so a dispatch to Code retires the released 917d80
    lane and launches a fresh one. That is also GUI check 1 above; watch that it happens. Not sent
    yet: Juan has not said go.
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
- **Launching a dev instance of Operator:** (2026-09-29: started on 1420 with CDP 9340; it quit cleanly about 40 s later, cause not established — watch for it) `electron/` `npm run dev` with `OPERATOR_DIR` set to a
  scratch dir; `OPERATOR_ELECTRON_PORT` picks the Vite port (strict), `OPERATOR_CDP_PORT` opens CDP.
  Never the root `npm run dev` (Tauri-era).
- **Test lanes are real agents.** Don't leave them running unattended.
- **Late reports** arrive oldest-first; check the commit is already merged before acting on one.
- **Merges into `main` are Juan's** (run via `!`); pushes and tags on his explicit go-ahead.
- **Transcript search:** directory names under `~/.claude/projects` start with `-`, so `ls -t */*.jsonl`
  fails; use `./*/*.jsonl`.
