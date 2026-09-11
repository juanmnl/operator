# Restart an idle lane when Claude Code has updated underneath it — RESULT

Brief: `dev/briefs/restart-lane-on-cli-update.md`. Branch `operator/bcab80`, commit **`a287c86`**.
Not merged, not pushed: per the user's instruction, the coordinator merges.

**The branch also carries two unmerged commits from the previous brief** (pane activation,
`a3d25bf` + `03eaf95`). Merging `operator/bcab80` brings those in too.

## What was built

### Detection (main process)

**`electron/src/main/claude-version.ts`**: `ClaudeVersionWatcher`.
- Resolves the `claude` a lane's login shell runs (`$SHELL -ilc 'command -v claude'`, cached, with
  `~/.local/bin/claude` as fallback) and follows the symlink with `realpath`. It reads the version
  off the target's name (`…/versions/2.1.269`).
- For an install not named by version (npm, Homebrew) it runs `--version` once per resolved target
  and caches the result.
- If the cached command path stops resolving, it asks the shell again.
- Re-reads every 60 s, and broadcasts `onClaudeVersion` only when the value changes.
- It never parses pty output.
- Checked against this machine: `which=/Users/juanmnl/.local/bin/claude version=2.1.269`, first read 35 ms.

**Spawn** (`ipc.ts` → `terminals.ts`) resolves the version (bounded at 2 s, so a slow shell never
blocks a launch) and records it on the pty. `terminalSpawn` and `terminalList` return it, so a tab
re-attached after a renderer reload keeps it. The tab persists it onto the saved session
(`SavedSession.claudeVersion`).

**API**: `claudeVersion()` (invoke) and `onClaudeVersion` (event) in `SPEC`, `env.d.ts` and the mock bridge.

### Decisions (`src/renderer/lib/cli-update.ts`, pure)

- `compareVersions`: numeric; a release outranks its own prerelease.
- `isOutOfDate(spawned, installed)`: false when either side is unknown, so there is no button on a guess.
- `canRestartLane`: `canAnnounceTo` (between turns, not ended) and no prompt pending in the submit queue.
  - A lane waiting on a permission answer has an open `tool_use`, which `derivePhase` reports as
    `running`, so it is excluded.
  - `waiting` in this codebase means the turn ended.
- `restartable`: out of date, restartable now, not ended, and has a Claude session id to resume.
- `pickAutoRestart`: first eligible lane in rail order, nothing while a restart is in flight.
- `restartLaunchOptions`: `resumeSessionId` plus the lane's model, effort, permission mode,
  `projectId`/`roleId`, orchestration note and remote-control setting.
- `replaceTab` (same slot) and `rekeyTasks` (terminal-stamped tasks follow the new id).
- The auto-restart preference: `operator.autoRestartOnCliUpdate`, off by default.

### The action (`DashboardView.handleRestartLane`)

Re-checks the gate at click time. Then:
1. Kills the pty.
2. Spawns in the same cwd with `--resume <same id>`. The worktree directory is NOT removed and the
   lane's tasks are NOT completed; this is why it does not reuse `handleCloseSession`.
3. Swaps the tab in place: same key, so the persist effect rewrites the same `sessions.json` row
   with the new terminal id.
4. Moves the active terminal/session selection only if that lane was the one on screen.
5. Re-keys terminal-stamped tasks and any pending done report to the new id.

The old id goes into `restartedFromRef`. Both the exit event and the reconcile path ignore it, so
the killed pty does not mark the lane's running tasks done. The orchestration note is re-sent,
because `--append-system-prompt` belongs to the process.

Dispatch and reports keep working:
- `pickLaneTab` resolves lanes through the tabs.
- `joinReattach` pairs by Claude session id, which `--resume` keeps; tested with a recycled terminal id.
- `OPERATOR_PROJECT_ID`/`OPERATOR_ROLE_ID` are re-exported on the new pty.
- The session bus does not address lanes by terminal id.

### Surfaces

- **Lane header** (`SessionToolbar`): a transparent chip, `Claude Code 2.1.269 available · Restart`.
  Accent ink when restartable; muted and disabled otherwise, with the "Wait for the lane to finish
  its turn" title. No fill, no opacity stacking.
- **Rail ⋯ menu**: the project menu lists each out-of-date lane as `Restart <lane> on Claude Code
  <v>`, disabled while it is busy. Lane rows in the rail have no ⋯ menu of their own; the project ⋯
  menu is the rail's only one, so it goes there.
- **⌘K palette**: one `Restart <lane> on Claude Code <v>` entry per lane that can be restarted now.
- **Preferences → Claude Code updates**: `Restart idle lanes automatically`, off by default. Read on
  every tick; one lane per 30 s tick at most.

## Files

- `electron/src/main/claude-version.ts` (new), `claude-version.test.ts` (new, 8 tests)
- `electron/src/main/terminals.ts`, `ipc.ts`, `index.ts`, `electron/src/shared/operator-api.ts`
- `src/renderer/lib/cli-update.ts` (new), `cli-update.test.ts` (new, 19 tests)
- `src/renderer/views/DashboardView.tsx`, `components/session/SessionToolbar.tsx`,
  `components/prefs/PrefsView.tsx`, `src/renderer/env.d.ts`, `src/shared/types.ts`, `dev/mock-bridge.ts`

## Tests

Brief's list:
- **launch-args resume shape:** `buildArgs(restartLaunchOptions(...), sessionId)` gives
  `--resume <id>` and never `--session-id`.
- **Version comparison:** covered.
- **Idle-only gate:** running, compacting, permission-pending (derived `running`), ended, untracked
  and queued lanes are all refused.
- **Reattach after restart:** a new terminal id with the same Claude session id joins its own saved
  row, not a recycled id's row.

Also covered: auto-restart selection; the version watcher against a real symlink that moves, plus
the `--version` cache, shell re-query and concurrent-read fallbacks.

```
root       npx vitest run          → Test Files 77 passed (77) · Tests 1168 passed (1168)   (branch baseline 1149)
root       npm run build           → tsc clean, ✓ built in 1.03s
electron/  npx vitest run          → Test Files 30 passed (30) · Tests 552 passed (552)     (baseline 544)
electron/  npm run typecheck       → clean
electron/  node scripts/build-main.mjs → bundles built
```

## Left out, and why

- **Not exercised in the running app.** No lane was restarted for real. To check:
  1. Leave a lane idle on an older version (the "Update installed" banner shows).
  2. Confirm the header chip appears within a minute.
  3. Press Restart: same conversation, same branch, same rail slot, same focus.
  4. Dispatch to it afterwards.
- **No `fs.watch`.** A 60 s poll of the link is cheap and covers both the directory and the link
  target, which the brief allowed.
- **A restart also ends the lane's dev server.** `terminalKill` reaps the whole process tree. The
  port lease is released and the resumed lane gets a fresh allocation for the same cwd, which may
  be a different port.
- **Text typed into Claude Code's own input box but not submitted is lost.** Operator cannot see
  it. A prompt still in Operator's submit queue blocks the restart.
- **Auto-restart does not wait** for a resumed lane to reach its first idle before taking the next
  one. It is still one lane per 30 s tick.
- **For a moment two transcript tracks share one Claude session id:** the old one, ended on its next
  1 s tick, and the new one. The existing suspend→resume path already produces the same state.
- **The legacy Tauri bridge (`src/operator-bridge.ts`) was not given the new methods.** They are
  optional, and the Electron shell is the shipped one.
- **Merge and push were not done**, per the user's instruction.
- **Commit trailer** says `Claude Opus 5`, not the `Claude Fable 5.1` the brief named; the
  session's attribution instruction replaces it.
