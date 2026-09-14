# Handoff — 2026-09-14

**`main` = `e54b61d`, pushed. 0.23.0 is PUBLISHED and LIVE** (tag `electron-v0.23.0`, run
34891579086 green in 5m43s). Verified: `releases/latest/download/latest-mac.yml` and `latest.json`
both serve **0.23.0**; `operator-releases` `v0.23.0` is Latest with `Operator_0.23.0_aarch64.dmg`,
`Operator-0.23.0-arm64-mac.zip`, `Operator.app.tar.gz`, `SHA256SUMS.txt` and both feed files; the
notes open with the 0.22.0 warning.

Final gates on `main` before tagging: renderer **1307 / 0**, electron **562 / 0**, root `tsc`,
electron typecheck and `build-main` clean.

**⚠ FIRST: the user is still on 0.22.0, and nothing in 0.23.0 has been seen rendered by a person.**
0.22.0's "Install & Restart" has the updater bug below, so install 0.23.0 from the DMG by hand
(quit Operator first). Then check, in order:
1. ⌘C / ⌘V / ⌘A / ⌘W / ⌘Q still work. 0.23.0 sets its own application menu (Electron's default
   roles rebuilt, Help dropped) so ⌘' and ⌘⇧' fire while the Preview page has focus.
2. Preview as a side-panel tab beside the Console; the panel width stays the same on Plan / Diff /
   Preview; double-click the drag handle splits the row.
3. Redlines on at 1280 in a narrow panel: hover and ⌥-click land on the element under the cursor
   (device emulation maps input; no probe could test it), and Operator's window stays at 100%.
4. Grid (⌘'), settings band, per-project persistence; an anchored Inspect note carries
   `— 16px below …`.
5. Plan meter: one cell, dropdown opens upward, Esc / outside click closes.
6. Type into a braked coordinator's terminal: its next dispatch goes through.

## What 0.23.0 is

All built and merged today. Results in `dev/results/`.

1. **Preview in the side panel + design tools** (spec `preview-panel-and-design-tools-design.md`,
   research `preview-panel-and-overlays-research.md`, stage results `preview-panel-stage{1..4}-RESULT.md`,
   `preview-inspect-measurement-RESULT.md`). One Preview per session that moves between main view and
   panel (`src/renderer/lib/session-layout.ts` `applyLayout`). User override: ONE panel width for all
   tabs. Toolbar tiers from measured width (`lib/preview-toolbar.ts`). Grid geometry
   `src/shared/layout-grid.ts`; redline math `src/shared/redlines.ts`; in-page drawing
   `src/shared/preview-overlay.js` fed the functions as source by `electron/src/main/overlay-fns.ts`.
2. **Zoom isolation** (`preview-zoom-isolation-RESULT.md`). `setZoomFactor` is per HOST in the shared
   session and zoomed the dev build's own `localhost:1420` window; the inspect view now scales with
   `enableDeviceEmulation`. Probe: `electron/probes/preview-zoom-isolation.cjs`.
3. **Plan meter collapse** (`plan-meter-collapse-RESULT.md`, Design lane).
4. **Agent comms** (audit `agent-comms-audit-2026-09-14.md`, fixes `agent-comms-fixes-RESULT.md`).
   The 24-send brake was keyed by bare role id in one app-wide ref, and 15 projects name their
   coordinator `operator`: mantel 9 + uwazi 10 + operator 4 sends braked all three coordinators.
   Now `laneKey(projectId, roleId)`; Enter in a lane's terminal resets it; refusals toast with
   "Let it continue"; reports older than 12 h expire instead of being announced; bus dispatches are
   not truncated; MCP replies no longer file board tasks.
5. **Updater** (`updater-install-fix-RESULT.md`). The 09-11 0.21.0 → 0.22.0 install armed
   `autoInstallOnAppQuit` only after the download, so electron-updater's `MacUpdater` never had
   Squirrel.Mac fetch the zip; `quitAndInstall` did nothing, AFTER `prepareQuit` had killed every
   lane and closed `artifacts.db` — 61 h of unanswered dispatches in mantel. Now armed before the
   download, a wait for `squirrelDownloadedUpdate` before asking or tearing down, and a 30 s quit
   watchdog. **Unproven until the next update**: on 0.23.0 → next, `~/.operator/updater.log` must show
   `requested by Squirrel.Mac` before the restart prompt.

## Open

- **Every 0.22.0 install runs the broken updater for this update.** Notes tell users to use the DMG.
- **Delivery brake still bites the coordinator within a session.** It refused this session's
  dispatches after 24 sends and stayed refused through chat messages (pre-0.23.0 build), so the
  coordinator built steps 5, the comms fixes and the updater fix itself on branches. In 0.23.0 typing
  resets it; confirm.
- **Remaining comms items** (`agent-comms-fixes-RESULT.md` "Not in this branch"): count on confirmed
  `SendMessage` delivery; the announce pass can stall on an unconfirmed line and holds one app-wide
  lock (inferred); report ↔ direct message dedupe; `to_role` never written; `mcp__operator__report`
  rejects 4–10 KB input as unparseable JSON; `OPERATOR-DISPATCH` sentinel still unbraked; terminal
  ids reused across projects.
- **Preview spec open questions** (§10): reload on move (`moveBefore()`), toasts over a panel-hosted
  inspect view, moving Annotate pins into the page.
- Merges into `main` stay classifier-blocked for the coordinator; the user runs them with `!`.
- Lane worktrees from today still exist: `operator-4f0a00` (Code), `operator-b11dc0` (Design),
  `operator-907ac0` (Research). All their work is merged.

## Next

1. User installs 0.23.0 by hand and runs the six checks above.
2. Code queue candidates: the announce-pass stall / global lock, `mcp__operator__report` large-input
   failure, counting brake sends on confirmed delivery.
