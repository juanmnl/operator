# `worktree_done`: agents release their own worktree (2026-09-16)

Commit `46fa558` on `operator/worktree-done-tool`, branched from
`operator/worktree-node-modules-clone` (`01114ff`). Merge order: worktree cleanup stage 1, the lane
worktree setting, the node_modules clone, then this.

Not GUI-verified. The tests ran in temp `OPERATOR_DIR` sandboxes; nothing under
`~/.operator/worktrees` was touched.

## Rule: only what removal would lose blocks it (user decision, 2026-09-16)

Follow-up commit `c410760` applies the user's decision. **Only uncommitted files block
`worktree_done`. Commits that exist only on the kept lane branch do not.** That covers work that is
unmerged and unpushed, which is the normal state of a finished Code or Design lane here. The branch
is kept, so removing the folder loses nothing on it.

The tool and its exit re-check share one pure rule, `releaseBlocker` in `worktree-reap.ts`. It keeps
the worktree for:
- uncommitted files;
- a tree git cannot read;
- a detached HEAD: its commits are on no branch, so nothing would keep them.

Settings → Worktrees and the reaper keep the stricter `unsavedWorkOf` rule, unchanged: there,
commits on no other branch or remote still count as unsaved.

The first version (`46fa558`) refused unmerged, unpushed commits too, which would have refused
almost every finished lane.

## What changed

### 1. The tool (`electron/src/main/mcp-serve.ts`)

- **Registration:** `worktree_done` sits in the same `TOOLS` list as `report`/`task_status`, with a
  bare name, so it is exposed as `mcp__operator__worktree_done`. It has no input properties.
- **Probe:** the release `--mcp-serve` probe (`electron/probes/mcp-probe/scripts/drive.mjs`) only
  asserts the tool list is non-empty and calls `report`, so it needed no change.
- **Async:** it is the one async tool. `handle()` returns a promise for it and `serve()` awaits that
  promise. Every other tool is unchanged and synchronous.
- **Caller:** `resolveCaller()` as before (`OPERATOR_TERMINAL_ID`, then project and role). The
  directory comes from a new spawn variable, `OPERATOR_LANE_CWD` (`terminals.ts`, set next to
  `OPERATOR_PROJECT_ID` and scrubbed with the others). Never from an argument or the MCP process's
  cwd; a test passes a `path` argument naming another worktree and it is ignored.
- **Decision:** `worktreeDoneVerdict` in `worktree-reap.ts` is pure, and `evaluateWorktreeDone`
  gathers facts for that one directory only (`gatherFacts({ only })`). It refuses, each time saying
  "Nothing was changed.", for:
  - no `OPERATOR_LANE_CWD` (a lane from an older build);
  - a directory not under the worktree root ("no worktree of its own", e.g. the main checkout;
    told to report instead);
  - no provenance record;
  - a guard refusal;
  - git cannot read it;
  - a detached HEAD;
  - uncommitted state unknown;
  - uncommitted files. The message lists up to 20 (porcelain lines) and tells the lane to commit
    them on its branch and call again, or call `report` and leave the worktree. Since `c410760`
    commits on the lane branch are not listed and do not block.
- **Accepted:**
  - it records a row in a new `worktree_release` table in `artifacts.db` (terminal, project,
    `OPERATOR_APP_PID`, path, branch, source repo);
  - it records a `task_status` row `('worktree_done', 'done')`. That is the same signal as
    `task_status(…, 'done')`: the renderer's poller stamps the lane as reported done, so an
    automatic close is recorded as `reported-done` rather than `went-quiet`, and the unknown task id
    is acknowledged;
  - it replies: "Released. The worktree … will be removed when this session ends, not while you are
    running in it. Your branch … is kept. … Now call mcp__operator__report with your result."

### 2. Removal on exit (`releaseWorktreeOnExit`, wired in `index.ts`)

- **Trigger:** `ExitSink` now also passes the lane's cwd. On any pty exit (the agent quit, or
  Operator closed the lane) main looks up open release rows for that terminal id, path and **this
  app's pid**. Terminal ids restart at `t0` every run, so a row from an earlier run never matches.
- **Re-check:** main checks again before removing:
  - directory already gone → `already-gone`;
  - no provenance, `releaseBlocker` (uncommitted files, unreadable tree, or detached HEAD at exit),
    or another open terminal in it (`ptyClaimOn`) → **kept**. Commits made on the branch after the
    call do not keep it. The row records `kept: <reason>`, a line is logged, and the folder
    stays listed in Settings → Worktrees with its unsaved state.
  - Otherwise → `removeWorktreeDurably`: git-vouch check, project-path guard, trash, only its own
    admin entry. The branch is kept.
  - sessions.json is not consulted here: at exit it still lists the lane that just ended.
- **Race with lane close:** the renderer's close path removes the same worktree moments later.
  `removeWorktreeDurably` now treats "the directory is already gone" as success, so whichever
  removal runs second neither errors nor shows the "Kept the worktree folder" toast.

### 3. Launch note (`roster.ts`, `lane-workspace.ts`)

`WORKTREE_DONE_NOTE`: "When your task is done and your work is committed on your branch, call
`mcp__operator__worktree_done`, then `mcp__operator__report`." It is appended for a non-coordinator
lane that launches in its own worktree (`launchWorkspace(...).ownWorktree`). By default that is Code
and Design. A Code lane switched to the main checkout does not get it; a custom lane switched to
its own worktree does. I keyed it on "has its own worktree" instead of role names, because the tool
refuses every lane without one.

### 4. Migration fix (`model-config.ts`)

`migrateGlobalsToLanePins` no longer writes `useWorktree` for any lane. A re-run from a lost
localStorage flag can no longer pin the Research lanes back into worktrees from
`role-defaults.json` (`research: true`). Tests changed:
- the effective-config matrix no longer compares `useWorktree`, with the reason in a comment;
- "pins worktree OFF…" is replaced by "never writes a useWorktree pin, whatever the old tier said".

## Tests and results

`electron/src/main/worktree-done.test.ts`, 15 tests after `c410760`: real `handle()`, real store,
real git, in a sandbox.
- **Caller resolution:**
  - the tool is listed with a bare name;
  - no terminal id is refused;
  - no `OPERATOR_LANE_CWD` is refused;
  - the directory comes from the environment, not a `path` argument.
- **Refusals:**
  - the main checkout (no worktree);
  - a worktree added by hand with no provenance;
  - an uncommitted file, listed (no release row written);
  - a detached HEAD with a commit on no branch.
  - Accepted: a commit only on the lane branch (unmerged, unpushed).
- **Release on exit:**
  - clean: the reply waits for exit, the folder still exists before exit, the done status row is
    written, the folder is removed on exit, the branch is kept, and the row is settled;
  - dirty at exit: kept, with `kept: 1 uncommitted file(s) at exit` on the row;
  - a commit made on the branch after the call: removed on exit, the commit still on the branch;
  - HEAD detached after the call: kept, with `kept: HEAD is detached…`;
  - another terminal id, another app pid, or no release: nothing happens;
  - already removed by the close path: `already-gone`, and a second `removeWorktreeDurably`
    resolves.

Renderer:
- `lane-workspace.test.ts`: the line appears for Code/Design by default and not for
  Research/Review/QA/coordinator; it names the order (committed, worktree_done, report); a Code note
  stays under the 3300 guard.
- `model-config.test.ts`: the migration changes above.

- Root `tsc --noEmit -p .`: pass. `electron` `tsc -p tsconfig.json` and
  `tsc -p tsconfig.renderer.json`: pass.
- Electron suite: 33 files, 631 passed, 0 failed at `46fa558`; **33 files, 633 passed, 0 failed at
  `c410760`**.
- Renderer suite (`vitest run src/renderer`): 83 files, 1269 passed, 0 failed (unchanged by
  `c410760`).
- Run with the main checkout's `node_modules` and `electron/node_modules` symlinked in, removed
  after.

## Risks and gaps

- **Lane close still removes worktrees on its own terms.** Closing a lane by hand, or the automatic
  close after a reported-done lane goes quiet, runs the existing renderer path: it commits
  uncommitted changes as "WIP preserved…" and removes the worktree. So "dirty at exit keeps it"
  holds for the exit-time removal, but a close from the renderer still commits and removes. That
  path predates this task and I did not change it.
- **Lanes already running** were spawned without `OPERATOR_LANE_CWD`. They get the "older build"
  refusal until relaunched.
- **No UI for release outcomes.** A kept release is only in the log and the store row. The folder
  shows in Settings → Worktrees like any other, but nothing there says it was released and kept.
- **The DashboardView wiring** (passing `ownWorktree` to the note) is not run by a test; the
  decision it uses is.
