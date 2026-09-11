# Handoff — 2026-09-11

**`main` = `33adde0`, pushed. 0.22.0 is PUBLISHED and LIVE** (tag `electron-v0.22.0`, run
34642598920 green: `test` + `release`). Verified: `operator-releases` release `v0.22.0` is
`draft:false` with `Operator_0.22.0_aarch64.dmg`, `Operator-0.22.0-arm64-mac.zip`,
`Operator.app.tar.gz`, `SHA256SUMS.txt`, `latest-mac.yml`, `latest.json`; the feed's
`releases/latest/download/latest.json` serves **0.22.0** signed. Every 0.21.0 install is offered it.

Final gates on merged `main` before tagging: renderer **1168 / 0**, electron **552 / 0**, root
`tsc` + build, electron typecheck all clean.

**⚠ FIRST: nothing in 0.22.0 has been seen rendered by a person.** Check, in order:
1. Install 0.22.0, open mantel in Preview: the Dock icon must stay unbadged (0.21.0 showed a red "3").
2. Switch to a lane that ran a long turn while hidden: the prompt row must be on screen.
3. Leave a lane idle on an older Claude Code binary (its own "Update installed · Restart to update"
   banner shows): a `Claude Code <v> available · Restart` chip must appear on its header within a
   minute, also in the project ⋯ menu and ⌘K. Press it: same conversation, same worktree, same
   rail slot. Then dispatch to it and confirm delivery.
Clean path back is `git revert 33adde0` of the notes/version plus reverts of merges `2274322`
and `8a599a9`, then a `0.22.1` tag.

## What 0.22.0 is: three defects the user hit in one day, all traced before any code moved

Merge commits on main: `2274322` (`operator/bcab80`, badge block) and `8a599a9` (`operator/bcab80`
again: pane activation + restart-on-update). Briefs in `dev/briefs/`, results in `dev/results/`.

1. **Dock badge "3" (`preview-badge-block`).** Operator never sets a badge. Electron ships Chromium's
   Badging API, so a page inside the Preview pane badges the host. mantel's `apps/web/src/App.tsx`
   calls `navigator.setAppBadge(reservasCount)`. Measured with `electron/probes/badge-block.cjs`
   (Electron 43.4.1): a cross-origin iframe, a top-level inspect view and a service worker could
   all badge. Fix: main-world stubs via `contextBridge.executeInMainWorld` in
   `electron/src/preload/badge-block.ts`, run in every subframe (`nodeIntegrationInSubFrames`,
   subframes get NO `__operatorNative`), a service-worker preload, and `app.setBadgeCount(0)` at boot.
2. **Prompt not visible after switching to a lane (`pane-activation-scroll`).** Activation never
   called `scrollToBottom`, and the old `fit()` after `term.write()` resized before the queued
   hidden bytes parsed. Now `applyPaneActivation` in `src/renderer/lib/terminal-options.ts`:
   parse hidden output (composed at the pre-fit width) → fit in the write callback (only if still
   active) → scrollToBottom → refresh. The research brief's "fit first" suggestion was WRONG and
   the lane proved it with real xterm 6.0.0 tests; keep the order as shipped.
3. **Restart a lane when Claude Code updated underneath it (`restart-lane-on-cli-update`).**
   `electron/src/main/claude-version.ts` polls the `claude` symlink every 60 s; spawn records the
   binary version per pty and saved session (`SavedSession.claudeVersion`). Pure decisions in
   `src/renderer/lib/cli-update.ts`; action `DashboardView.handleRestartLane` kills the pty tree
   (dev server dies, port may change), resumes with `--resume`, swaps the tab in the same slot,
   re-keys tasks. Pref `operator.autoRestartOnCliUpdate` (off). Unsubmitted text in Claude Code's
   input is lost on restart; Operator cannot see it.

## Not fixed, by finding

- **Scrollback empty after long sessions is Claude Code's renderer**, verified against the
  installed 2.1.268 binary (`dev/results/scrollback-and-missing-input-RESULT.md`): once its frame
  is taller than the viewport it repaints a viewport-tall window with cursor moves, no linefeeds,
  no `ESC[3J` outside the alt screen. Nothing on Operator's side of the pty can recover those
  lines; replay-on-activate would replay the same bytes. `INACTIVE_SCROLLBACK` (2,000) worsens it
  but is not the cause. The fullscreen TUI pref is the only lever, at the ghosting risk on record.

## Open defects seen today

- **Dispatch lost at lane launch, again.** The first `mcp__operator__dispatch` to the idle Code
  lane answered `launching` but no Claude process was spawned and no task ran; the second attempt
  worked. Memory: `project_dispatch_lost_on_lane_launch`. Confirm a launch by `ps` start time.
- **Merges into `main` are classifier-blocked for lanes AND the coordinator**, even after the
  user said "push when done". The user ran the merge with `!`. Releases need that step every time
  until the permission rule changes. `mcp__operator__dispatch` was blocked once too (task text
  mentioned merging); the `OPERATOR-DISPATCH` sentinel went through.
- **Operator's own report backlog is draining late.** 22 reports from the 6 Sep session were never
  delivered; the new app is announcing them now (e.g. #622 from 5 Sep, delivered 11 Sep 21:02Z).
  Ignore announcements dated before the current session unless the content is still open.
- Commit trailers from lanes say `Claude Opus 5`; the session attribution overrides the brief.

## Next in the Code queue

Nothing dispatched. Candidates, in order: the lost-at-launch dispatch defect (reproduce with a
fresh idle lane and two dispatches); a permission rule so the coordinator can merge to `main`
when the user has authorised a push; model pricing table (Sonnet 5 is $2/$10, memory
`project_model_pricing_stale`).
