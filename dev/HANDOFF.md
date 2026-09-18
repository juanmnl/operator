# Handoff — 2026-09-17 (evening)

`main` = `f1780de` (pushed). **0.26.0 published** (`electron-v0.26.0`, run 35290271734 green).
Verified end to end: `operator-releases` v0.26.0 is Latest and not a draft, six assets;
`latest.json` serves 0.26.0 for `darwin-aarch64` with a 408-char signature; `latest-mac.yml` serves
0.26.0; `Operator.app.tar.gz` was re-downloaded and hashes to the published `63af0d1a…`.

**Nothing in 0.24.0, 0.25.0 or 0.26.0 has been verified in the running app.** Three releases deep.
Everything below is tests, typechecks, probes and source reading.

## What shipped in 0.26.0

Two navigation dead ends, both found by reading source after Juan hit them.

**A way back out of every full-page view** (`operator/ba0200`, `348a38b` + `6a984a6`):

- New pure `src/renderer/lib/nav-origin.ts`: `describeOrigin` / `originLabel` / `originKey` /
  `pushOrigin`. `NavOrigin extends ContinueTarget` so there is one definition of "a view you can
  return to", plus four optional fields it never needed (gallery tab; which of the two pages that
  both report `mode: 'prefs'`; the Global settings tab; the lane).
- The control lives in `PageShell` and arrives by `PageBackContext`, not a prop threaded through
  `PrefsView` / `AgentsHubView` / `TuningView`. All five page modes inherit it from one provider.
- It is a **chain** (capped at 8, in-memory only), because the rail's foot reaches Preferences,
  Global settings and Agents from each other, so `gallery → prefs → globals` is an ordinary path
  and one slot would leave those two pages each claiming to be the other's origin.
- `BACK_BTN` extracted to `lib/chrome.ts` and shared with `ProjectGallery` (its local `backBtn` is
  gone), so the gallery's back button and this one cannot drift.
- Lane-as-origin: `LaneOrigin = { terminalId }` on `NavOrigin.lane` with `mode: 'project'`. No name
  and no session id are recorded — the name resolves at render through `sessionLabel`
  (`lib/session-label`, called with the same arguments as `paletteActions`), the session id resolves
  in `applyView` from `sessionsRef`. `originKey` is `lane:<terminalId>`, so two lanes of one project
  are two places.
- **The existence guard:** `backLanes` filters the named lane against `terminals` — the same
  `terminals.some(...)` test `contentMode` uses — so control and router cannot disagree about what
  exists. Lane gone → no label → no control, never a fallback to the lane's project. Absent origin
  renders nothing at all.
- **Fixed a real pre-existing bug in `applyView`:** it set six states but left `activeFolderPrefs`,
  `activeSessionId` and `activeTerminalId` standing, so returning from the per-project settings page
  to the gallery changed nothing on screen (gallery ranks *below* folderPrefs in `contentMode`).

**The global Environment tab is a doorway** (`operator/eda0c0`, `9366fbd`):

- `EnvironmentSection`'s `project === null` branch listed nothing and said "Open a project's
  settings" without a way to do it. It now lists every project with `tildePath` and a count
  (`3 variables` / `none set`), each row calling `onOpenFolderPrefs(path, name, 'Environment')`.
- `envDoorwayRows` is exported and pure, sorts by count descending, stable among equals.
- Two optional props through `FolderPreferencesView`; the DashboardView change is two lines at the
  `globalPrefs` render site. The project's own page is untouched.
- Shelved projects are listed like any other — hiding them from a list whose purpose is
  reachability would recreate the defect in miniature.

Merged as `594a072` with build CI green on the merge *before* tagging. Post-merge: root tsc 0,
electron tsc 0, renderer 101 files / 1495 tests, electron 681 tests, `npm run build` clean.

## Owed by Juan (GUI)

Carried forward, plus this release. Items 1–4 are still owed from 0.24.0/0.25.0.

1. Update in-app to 0.26.0. 0.23.0's updater fix has now had one real test (the 0.25.0 install); if
   it misbehaves, install the DMG by hand.
2. Launch lands on the home overview; a renderer respawn does not.
3. Preview: Redlines on a navigated/scrolled page, Inspect → CSS controls → Send, note screenshots,
   an attached Electron app.
4. Settings → Worktrees: groups, the confirm, the would-remove list. Then decide whether to arm
   automatic removal.
5. **New — the back control.** From the home overview → a project's Worktrees row action → press
   `‹ Worktree overview` and check it returns to the overview *tab*, not the projects list. Then
   from a focused lane → rail foot → Preferences, and check the control is labelled with the lane's
   name. Then close that lane from elsewhere while sitting in settings and check the control
   *disappears* rather than pointing at a dead pty.
6. **New — the Environment doorway.** Global settings → Environment lists your 16 projects; a row
   opens that project's own Environment tab.

## Open

- **Env variables have never been set on any project.** Verified: the `env` key is absent from all
  16 records in `~/.operator/projects.json` and from every backup checked back to 2026-09-11. Not
  cleared — never written, which is consistent with the discoverability defect 0.26.0 fixes. The
  `RAILWAY` strings in `projects.json` are task and dispatch text, not values.
- **`RAILWAY_TOKEN` for mantel is still unset, and setting it is a decision, not a chore.** It would
  land as plaintext in `projects.json`. v1 is config-only by design; the `{name, secret}` `EnvEntry`
  shape is reserved and unimplemented (Keychain-backed secrets, S4–S7). Decide plaintext vs
  Keychain before setting it.
- **The release workflow still uploads every asset in one `gh release create`**, which deletes the
  whole release if one upload fails. It did **not** fail on this cut, but the workflow is unchanged,
  so the 0.25.0 failure mode stands. Recovery that worked: create the release empty, then
  `gh release upload --clobber` per file with retries. Worth changing in `electron.yml`.
- **Back control, known residue:** a one-frame race if a lane dies between the render that drew the
  control and the press (backstopped by `contentMode`'s own liveness test, pre-existing); a lane with
  no session object and no role labels as the generic `Session`; nothing is persisted, so a reload
  starts with an empty chain and no control (by design — terminal ids are a per-run counter, so a
  persisted chain would name last run's lane); going back leaves no forward trail.
- `CLAUDE.md` is **modified and uncommitted** — a one-line fix repointing the hub note to
  `~/Documents/Vaults/Work/Operator/Operator.md` after the vault move. Kept out of the release
  commit deliberately. Worth committing on its own.
- `operator/eda0c0` and `operator/ba0200` are merged into `main` but their worktrees are still on
  disk (`~/.operator/worktrees/operator-{eda0c0,ba0200}`). 19 worktrees, 17GB total — candidates for
  the cleanup page.
- Worktree stage 2 (arming automatic removal) waits on Juan reading the report-only list. Orphans
  whose unsaved state git cannot read stay manual-only, and that rule is not enforced in code yet.
- 15 existing projects still carry the old coordinator charter; only new projects get the "keep your
  steps in the task list, not in chat" line. `visual language` has no charter at all.
- CSS controls on React 19 give the source file but no line (`_debugSource` is gone; the fallback
  parses `_debugStack`), untested against a real React 19 app.
- Pages that refuse to be framed (`X-Frame-Options`) can no longer be inspected.
- The Tauri shell still swaps hosts for overlays (the bug fixed for Electron).
- Not done from the research: CDP-native inspection (`DOM.getBoxModel`, `Overlay.highlightNode`),
  native macOS apps (ScreenCaptureKit + AX, needs a signed Swift helper and two TCC grants).

## Notes

Lane reports for this round are tracked: `dev/results/global-env-doorway.md`,
`dev/results/pageshell-back-affordance.md`, `dev/results/pageshell-back-lane-origin.md`. Earlier
rounds (`dev/results/*-2026-09-16.md`, `*-2026-09-17.md`) remain untracked. Hub note updated through
the 0.26.0 release.

One discrepancy worth knowing if you read the lane reports: `pageshell-back-lane-origin.md` says
`nav-origin.test.ts` has 31 tests; it runs 32. A count slip, not a failure.
