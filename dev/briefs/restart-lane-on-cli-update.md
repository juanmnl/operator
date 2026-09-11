# Restart an idle lane when Claude Code has updated underneath it

## Problem (2026-09-11)
Claude Code updates itself in the background (`~/.local/share/claude/versions/<v>`, the `claude`
symlink moves to the newest). A lane spawned before the update keeps running the old binary and
shows Claude Code's own banner in the terminal: `✔ Update installed · Restart to update`. Today six
of eight lanes (spawned 6–9 Sep) were on an old binary while 2.1.268 had installed at 09:01. The
only remedy is to end the lane and resume it, which the user has to do by hand per lane.

## What exists
- Resume path: `handleLaunchSession(cwd, config, { resume: { key, claudeSessionId, worktreeBranch, worktreeBase } })`
  in `src/renderer/views/DashboardView.tsx` (~2500); `lib/launch-args.ts` turns `resumeSessionId`
  into `--resume <id>`. Same worktree branch reattached, same saved-session key.
- Close path: `handleCloseSession` (ends the pty, keeps the saved session resumable).
- Per-lane phase (idle/running/waiting) is already tracked for the orb and for `canAnnounceTo`.
- Backend spawn: `electron/src/main/terminals.ts` `buildCommand`/`spawn`. Sessions store `~/.operator/sessions.json`.

## Task
1. Detect "lane is on an older Claude Code than what is installed now":
   - Record the resolved binary version at spawn (resolve the `claude` symlink target, or run
     `claude --version` once per spawn and cache by realpath) on the session record.
   - Know the currently installed version: watch `~/.local/share/claude/versions/` and the
     symlink target (fs.watch or a cheap poll, ≤ once a minute). Do NOT parse pty output for the banner.
2. Surface it: on a lane whose spawn version < installed version, show a small affordance in the
   lane's header/toolbar (transparent badge style, CSS vars, no solid fills — see feedback_ui_style)
   reading e.g. `Claude Code 2.1.268 available · Restart` with the action enabled ONLY when the
   lane's phase is idle (not mid-turn, not waiting for a permission answer). Also expose the same
   action in the rail ⋯ menu and the ⌘K palette.
3. The action = close the lane's pty and resume it in place: same claudeSessionId (`--resume`),
   same worktree, same saved-session key, same role/effort/model, focus stays where it was.
   Dispatch/report plumbing must keep working after the restart (the terminalId changes — check
   `session-reattach.ts`, dev-port lease, `sessions.json` role mapping, task `terminalId` keys).
4. Optional, behind a Tuning/Preferences switch defaulting OFF: auto-restart idle lanes when a new
   version lands, one lane at a time, never a lane that is running or waiting.
5. Tests: launch-args resume shape, the version comparison, the idle-only gate, and the reattach
   after restart (renderer suite). `npm test`, `cd electron && npm test`, `npm run build` green.
6. Merge to main and push (authorised by the user: "push when done"). No tag, no release.
   Commit trailer: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Output
`dev/results/restart-lane-on-cli-update-RESULT.md`: what was built, files, test tail, merge hash,
what was left out and why. Then `mcp__operator__report`.
