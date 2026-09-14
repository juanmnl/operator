# "Install & Restart" left the app running torn down — RESULT

Coordinator, 2026-09-14. Branch `operator/updater-install-fix` on top of `main` = `9abbda6`.
**Not verified with a real update**: only a published release exercises Squirrel.Mac.

## What the user saw

On 2026-09-11 they installed the 0.22.0 update. The app appeared to restart and they kept
working. It was still 0.21.0, and for 61 hours every `mcp__operator__dispatch` from mantel's
coordinator returned "Operator did not answer in time". 0.22.0 only installed at 12:59Z on 09-14.

## Timeline (evidence)

| UTC | Source | Event |
|---|---|---|
| 09-11 22:33:53 | `~/.operator/updater.log` | 0.22.0 downloaded; proxy for Squirrel.Mac listening; "autoInstallOnAppQuit armed" |
| 09-11 22:35:26 | updater.log | `quitAndInstall(0.22.0)`. No "requested by Squirrel.Mac", no `nativeUpdater.update-downloaded` before or after |
| — | `~/Library/Caches/com.operator.app.tauri.ShipIt/ShipIt_stderr.log` | no install request on 09-11 at all |
| 09-11 22:53 | mantel coordinator transcript `417caf39` | a new coordinator session starts (lanes had been killed) |
| 09-11 23:38 → 09-13 00:34 | `artifacts.db` `dispatch_requests` #61–#65 | never answered |
| 09-11 23:12 → 09-14 12:58 | updater.log | every 3 h "Found version 0.22.0": the running app is still 0.21.0 |
| 09-14 12:58:53 | updater.log | second download in the same process: Squirrel.Mac requests the zip, `update-downloaded` |
| 09-14 12:58:55 | ShipIt log (07:58:55 local) | install request, "Installation completed successfully", relaunch |
| 09-14 12:59:04 | updater.log | "Update for version 0.22.0 is not available": 0.22.0 is running |
| 09-14 12:59:05 | `dispatch_requests` | #61–#65 closed as "expired: Operator was not running when this was sent" |

## Root cause

1. `configure()` sets `autoUpdater.autoInstallOnAppQuit = false`, and `installUpdate` armed it only
   AFTER `downloadUpdate()`.
2. electron-updater 6.8.9 `MacUpdater.doDownloadUpdate` calls Squirrel.Mac's `checkForUpdates()` —
   the step that makes Squirrel fetch the zip from the local proxy — only when
   `autoInstallOnAppQuit` is already true (`MacUpdater.js:220-224`). So Squirrel never got the update.
3. `MacUpdater.quitAndInstall` with `squirrelDownloadedUpdate === false` only registers an
   `update-downloaded` listener, and, because the flag was by then true, does not trigger the fetch
   either (`MacUpdater.js:240-256`). Nothing happened.
4. Before that call, `prepareQuit` had run `teardown()` (`electron/src/main/index.ts`): every lane's
   pty killed, transcript tailer stopped, `chat.db` and `artifacts.db` closed, tray destroyed. The
   window stayed open on top of that. With `artifacts.db` closed, `openDispatches` threw and the
   renderer's dispatch tick returned silently every 500 ms, so no dispatch was answered.
5. Why 09-14 worked: it was the SAME 0.21.0 process. The flag was still true from 09-11, so the
   second download made Squirrel fetch, and the listener registered by the 09-11 `quitAndInstall`
   fired and installed at once. That is why the log says "user declined the restart" in the same
   second ShipIt started.

## Fix (`electron/src/main/updater.ts`, `index.ts`)

- `autoInstallOnAppQuit = true` is set immediately BEFORE `downloadUpdate()` (reset to false if the
  download fails).
- After the download, `nativeInstallerReady()` waits (up to 60 s) for
  `MacUpdater.squirrelDownloadedUpdate === true`. Updaters without that field (non-macOS) pass at
  once. If it never becomes true: an error names it, the user is not asked, and nothing is torn down.
- After `quitAndInstall`, a 30 s watchdog calls `host.quitAnyway` (`app.quit()` in `index.ts`), so
  an install that still does not quit cannot leave a torn-down app running.

## Checks

- Electron: 32 files, 562 passed, 0 failed (+3). `npm run typecheck`: exit 0. `build-main.mjs`: ok.
  - arms `autoInstallOnAppQuit` before the download (the fake records the flag inside `downloadUpdate`);
  - a failed download leaves it off;
  - macOS fake: asks and quits once `squirrelDownloadedUpdate` turns true;
  - macOS fake that never turns true: error "did not take the downloaded … Nothing was closed", no
    confirm, no `prepareQuit`, no `quitAndInstall`;
  - watchdog calls `quitAnyway` after the timeout.
- Renderer untouched.

## ⚠ The installed 0.22.0 still has the bug

The fix ships inside the NEXT release, but the update from 0.22.0 to it runs 0.22.0's updater. A
0.22.0 copy pressing "Install & Restart" once will repeat 09-11: lanes killed, app left on 0.22.0.
Options for that one update:

1. Download the DMG from the release page and install it by hand.
2. In 0.22.0: Install, choose "Not now" at the restart prompt, then Install again and restart. The
   first attempt leaves the flag on in that process, so the second download reaches Squirrel.Mac —
   what the 09-14 log shows. Inferred from that log, not tested.

Release notes for the next version should say this.
