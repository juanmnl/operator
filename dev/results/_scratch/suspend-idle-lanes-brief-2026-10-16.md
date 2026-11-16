# Brief: suspend idle lanes to free memory

## Why
On 2026-10-16 the Mac ran out of memory and rebooted. Operator had 19 Claude CLI processes running,
at 220–330 MB each (about 4.9 GB), and many were idle. A lane's conversation lives in its transcript,
so an idle CLI can be ended and restarted later with `--resume <claudeSessionId>` without losing work.
Context: `/Users/juanmnl/Developer/operator/dev/results/_scratch/memory-crash-brief-2026-10-16.md`.

## What to build
1. **Suspend.** A lane whose phase has been `idle` or `waiting` (src/shared/types.ts `SessionPhase`)
   for longer than a threshold gets its CLI ended gracefully. The lane stays in the roster in a visible
   "suspended" state, and its claudeSessionId, cwd, role, project and worktree are kept. Its worktree is
   NOT released or reaped: suspension must never look like `worktree_done` to the reaper.
2. **Never suspend** a lane that:
   - is running, compacting or asking;
   - is the pane the user is currently looking at;
   - has text typed in its input that was not sent;
   - has a queued or held dispatch or reply;
   - holds a dev-server lease or port (ending it kills the server; see dev-servers.ts and leases.ts);
   - is a coordinator (`operator` role). Coordinators receive reports, so they stay up in v1.
3. **Resume** happens on any of these, with `--resume <id>` and the same launch args the lane had:
   - the user focuses or clicks the lane;
   - the user types into it;
   - a dispatch or OPERATOR-REPLY targets it. The message must reach the lane only after the CLI is
     running again; a dispatch to a lane that is still starting has been lost before (see the memory note
     "Dispatch #2 lost at lane launch"). Reuse the existing launch/restart path.
   Look at how the restart-on-CLI-update feature (src/renderer/lib/cli-update.ts) and crash auto-resume
   (last-run / previous-run.ts / ResumeCard) already restart lanes with `--resume`, and reuse that
   instead of adding a third path.
4. **Settings.** Add a Tuning setting (src/renderer/lib/tuning.ts): idle minutes before suspend,
   default 30, and an Off option.
5. **Quit, relaunch and crash.** Record suspended lanes as suspended in last-run.json and sessions.json.
   A relaunch or crash auto-resume must restore them as suspended, not start their CLIs; starting them
   all would cancel the saving. The quit guard must not count a suspended lane as busy.
6. **UI.** Show the suspended state in the roster and the pane with the existing status vocabulary and
   styles. Keep it quiet: a dimmed state and a "Suspended — click to resume" line in the pane. Follow
   the UI rules in memory: never stack opacity on `--fg-muted`, and two verbs never share a glyph.

## Done means
- Unit tests for the eligibility rules (each exclusion), resume-on-dispatch ordering, and the
  last-run round trip.
- `npm test` green in both suites. Report the counts.
- Write `/Users/juanmnl/Developer/operator/dev/results/suspend-idle-lanes-2026-10-16.md` listing the
  files changed, the decisions you made, what is untested, and anything you could not do.
- Commit on your lane branch. Don't merge.
