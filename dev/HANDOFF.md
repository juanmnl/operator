# Handoff — 2026-09-17

`main` = `0d41d60` (pushed). **0.25.0 published** (`electron-v0.25.0`); 0.24.0 published earlier the
same day. Both feeds on `juanmnl/operator-releases` serve 0.25.0, `latest.json` carries a signature,
and the published files match `SHA256SUMS.txt`.

**Nothing in either release has been verified in the running app.** Every lane result below is
tests-and-probes only.

## What shipped

0.24.0 (`f61c4a9`):

- Worktrees: Settings → Worktrees groups by repo, per-row selection, two-step confirm for unsaved
  work; provenance backfill for pre-2026-08-11 folders; removal goes through the trash; report-only
  "would remove automatically" (24h grace, `AUTO_REAP_ON_TRIGGERS` still false).
- `mcp__operator__worktree_done`: a lane releases its own worktree, removed when that lane's pty
  exits, branch kept. Only uncommitted files block it (user decision).
- Per-lane `useWorktree`: Research now works in the main checkout; Code and Design keep worktrees.
  Main refuses to remove any project path in `projects.json`.
- New worktrees clone `node_modules` with APFS `cp -c` (~1.7s, ~5-6MB real disk for 666MB).
- Home overview at launch: projects, lanes, worktree counts/sizes/flags; a renderer reload still
  restores where you were (main-process launch tracker).
- Project settings / Global settings rename; the page opens straight to a tab.
- Preview: grid colour, SVG toolbar icons, diff wrap, note screenshots, CSS controls v1, redlines
  no longer reset the page.
- `asking` lane state (flashing rail orb) for an open `AskUserQuestion`.
- Plan tab lists a coordinator's dispatched tasks; hidden-pane terminal output is never dropped.

0.25.0 (`0d41d60`): Preview shows a lane's running Electron app over CDP — screencast, input
forwarding, injected inspector/overlay/edit scripts, CSS controls, note screenshots. The target app
opts in with `app.commandLine.appendSwitch('remote-debugging-port', process.env.OPERATOR_CDP_PORT)`;
`ELECTRON_EXTRA_LAUNCH_ARGS` does **not** work. Operator's own unpackaged build opts in too.

## Owed by Juan (GUI)

1. Update from 0.24.0 → 0.25.0 in-app. This is the first real test of 0.23.0's updater fix; if it
   misbehaves, install the DMG by hand.
2. Launch lands on the home overview; a renderer respawn does not.
3. Preview: Redlines on a navigated/scrolled page, Inspect → CSS controls → Send, note screenshots,
   an attached Electron app.
4. Settings → Worktrees: groups, the confirm, the would-remove list. Then decide whether to arm
   automatic removal.
5. Project settings → Environment: `RAILWAY_TOKEN` for mantel, then relaunch a lane and check
   `env | grep RAILWAY_TOKEN`.

## Open

- **Release workflow uploads all assets in one `gh release create`, which deletes the whole release
  if one upload fails.** It failed twice on GitHub 504/500 today, and the re-run then failed with
  "a release with the same tag name already exists". Recovery: create the release empty, then
  `gh release upload --clobber` per file with retries. Worth changing in `electron.yml`.
- Worktree stage 2 (arming automatic removal) waits on Juan reading the report-only list. Orphans
  whose unsaved state git cannot read stay manual-only, and that rule is not enforced in code yet.
- 15 existing projects still carry the old coordinator charter; only new projects get the "keep your
  steps in the task list, not in chat" line. `visual language` has no charter at all.
- Secrets (S4–S7) do not exist: project env values are plaintext in `projects.json`, by Juan's
  decision for now.
- CSS controls on React 19 give the source file but no line (`_debugSource` is gone; the fallback
  parses `_debugStack`), and that fallback is untested against a real React 19 app.
- Pages that refuse to be framed (`X-Frame-Options`) can no longer be inspected — they never
  rendered in the iframe, and Inspect used to open them in a separate view.
- The Tauri shell still swaps hosts for overlays (the bug fixed for Electron).
- Not done from the research: CDP-native inspection (`DOM.getBoxModel`, `Overlay.highlightNode`),
  native macOS apps (ScreenCaptureKit + AX, needs a signed Swift helper and two TCC grants).
- `~/.operator/worktrees` was 16.5GB / 55 dirs before the cleanup work; Juan deleted the main
  checkout's 36GB `src-tauri/target`.

## Notes

Lane reports and full detail: `dev/results/*-2026-09-16.md`, `dev/results/*-2026-09-17.md`
(untracked). Hub note updated through the 0.25.0 release.
