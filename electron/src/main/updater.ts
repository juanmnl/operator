// Auto-update. Replaces the Tauri updater plugin with `electron-updater`.
//
// THE FEED FORMAT CHANGES, AND THAT IS THE WHOLE MIGRATION RISK HERE. Tauri checks a
// `latest.json` on `juanmnl/operator-releases` against a minisign key baked into
// `tauri.conf.json`; electron-updater expects a `latest-mac.yml` alongside a `.zip`, verified
// through the bundle's code signature instead. Both cannot be served from one artifact set, so
// the changeover release has to publish the electron-updater feed BEFORE any Electron build
// ships — see dev/briefs/2026-08-20-electron-mcp-serve-probe-RESULT.md on the one-way door.
//
// Until that feed exists, `checkUpdate` answers "no update" rather than throwing. That matches
// the Tauri bridge, which wraps its own check in a catch and returns null: an update checker
// that surfaces its own plumbing errors to the user is worse than one that stays quiet.
import { autoUpdater } from 'electron-updater'

/** Set once the release feed is published. Until then the updater is deliberately inert —
 *  pointing it at the Tauri `latest.json` would have it parse a format it does not speak and
 *  report a corrupt-feed error on every launch. */
const FEED_URL = process.env.OPERATOR_UPDATE_FEED ?? null

let pending: { version: string } | null = null
let configured = false

function configure(): boolean {
  if (!FEED_URL) return false
  if (!configured) {
    autoUpdater.setFeedURL({ provider: 'generic', url: FEED_URL })
    // The renderer drives this: `checkUpdate` then `installUpdate`, both explicit. Downloading
    // on its own would spend the user's bandwidth on a decision they have not made.
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.logger = { info: console.error, warn: console.error, error: console.error, debug: () => {} }
    configured = true
  }
  return true
}

export async function checkUpdate(): Promise<{ version: string } | null> {
  // `configure()` is INSIDE the try. It was outside, and anything it threw — a malformed feed
  // URL, electron-updater reaching for `app.getVersion()` before the app exists — rejected this
  // promise instead of resolving null, which breaks the renderer's `.then()` chain rather than
  // quietly reporting "no update". A checker must never reject.
  try {
    if (!configure()) return null
    const result = await autoUpdater.checkForUpdates()
    const version = result?.updateInfo?.version
    if (!version) return null
    pending = { version }
    return pending
  } catch (e) {
    console.error('[updater] check failed:', e)
    return null
  }
}

export async function installUpdate(): Promise<void> {
  if (!pending) return
  try {
    if (!configure()) return
    await autoUpdater.downloadUpdate()
    // `true` = force even with other windows open; the renderer only calls this after asking.
    autoUpdater.quitAndInstall(false, true)
  } catch (e) {
    // Same reasoning as the check: the caller is a menu item, not an error reporter.
    console.error('[updater] install failed:', e)
  }
}
