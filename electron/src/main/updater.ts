// Auto-update. Replaces the Tauri updater plugin with `electron-updater`.
//
// THE FEED FORMAT CHANGES, AND THAT WAS THE WHOLE MIGRATION RISK. Tauri checks a `latest.json`
// on `juanmnl/operator-releases` against a minisign key baked into `tauri.conf.json`;
// electron-updater expects a `latest-mac.yml` alongside a `.zip`, verified through the bundle's
// code signature instead. Both cannot be served from one artifact set — so the swap release
// (`electron-vX.Y.Z`, no prerelease suffix) publishes BOTH to the same operator-releases
// release: `latest.json` for the copies still running Tauri, `latest-mac.yml` + `.zip` for the
// ones that have crossed over. See `.github/workflows/electron.yml`.
//
// A failed check still answers "no update" rather than throwing. That matches the Tauri bridge,
// which wraps its own check in a catch and returns null: an update checker that surfaces its own
// plumbing to the user is worse than one that stays quiet.
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

/** The packaged default feed.
 *
 *  `provider: 'generic'` pointed at `releases/latest/download`, NOT `provider: 'github'`, and the
 *  reason is which URLs each one actually touches:
 *
 *  - Generic makes ONE metadata request. `GenericProvider.getLatestVersion` fetches
 *    `<url>/latest-mac.yml` (`GenericProvider.js:18-23`; the `-mac` suffix comes from
 *    `Provider.getChannelFilePrefix`, `Provider.js:30-38`) and resolves the `.zip` against the
 *    same base (`GenericProvider.js:46-48`). Both are `releases/latest/download/<name>`, which
 *    GitHub answers with a 302 to the current "Latest" release's asset — the very URL shape
 *    `tauri.conf.json`'s endpoint has been using in production.
 *  - GitHub makes THREE, and one of them is undocumented: `releases.atom`
 *    (`GitHubProvider.js:43`), then `GET /<owner>/<repo>/releases/latest` with
 *    `Accept: application/json` (`GitHubProvider.js:158-171`) — an HTML route that answers JSON
 *    only for that header, and only after a same-origin 302 whose headers survive by way of
 *    `HttpExecutor.prepareRedirectUrlOptions` (`builder-util-runtime/out/httpExecutor.js:286`) —
 *    and only then the `latest-mac.yml` under the resolved tag.
 *
 *  What GitHub buys is a tag-pinned download, so a release published mid-check cannot be raced.
 *  Generic's window is closed instead by the `sha512` in the yml, which `resolveFiles` requires
 *  and refuses to proceed without (`Provider.js:127-129`) — a mismatch fails the verify rather
 *  than installing the wrong build. One request against a proven URL shape beats three against a
 *  route GitHub never promised. */
const DEFAULT_FEED_URL = 'https://github.com/juanmnl/operator-releases/releases/latest/download'

/** Which feed to use, as a pure decision so it can be tested without an Electron app.
 *
 *  A DEV BUILD MUST STAY INERT. `npm run dev` runs the same code with the same version number as
 *  whatever is published, so a default feed that applied unpackaged would offer every developer
 *  an "update" to the build they are sitting on. */
export function resolveFeedUrl(env: string | undefined, isPackaged: boolean): string | null {
  if (env) return env
  return isPackaged ? DEFAULT_FEED_URL : null
}

/** `app` is undefined when this module is loaded outside Electron — the unit tests import it
 *  under plain node, where `require('electron')` resolves to a path string. Treat that as "not
 *  packaged" rather than letting a property read throw inside the checker. */
function packaged(): boolean {
  try {
    return app?.isPackaged === true
  } catch {
    return false
  }
}

let pending: { version: string } | null = null
let configuredUrl: string | null = null

function configure(): boolean {
  // Read the env on every call rather than at import: the module is imported at startup, and
  // caching the answer there made `OPERATOR_UPDATE_FEED` untestable without a module reset.
  const url = resolveFeedUrl(process.env.OPERATOR_UPDATE_FEED, packaged())
  if (!url) return false
  if (configuredUrl !== url) {
    autoUpdater.setFeedURL({ provider: 'generic', url })
    // The renderer drives this: `checkUpdate` then `installUpdate`, both explicit. Downloading
    // on its own would spend the user's bandwidth on a decision they have not made.
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.logger = { info: console.error, warn: console.error, error: console.error, debug: () => {} }
    configuredUrl = url
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
