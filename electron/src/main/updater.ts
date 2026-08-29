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
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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

/** The running version, or null outside Electron — same reasoning as `packaged()`: the checker
 *  must answer, not throw, when `app` is a path string under plain node. */
function currentVersion(): string | null {
  try {
    return app?.getVersion?.() ?? null
  } catch {
    return null
  }
}

let pending: { version: string } | null = null
let configuredUrl: string | null = null

/** Set once a download has completed. From that moment `autoInstallOnAppQuit` is on, so a user
 *  who dismisses the restart and quits later still gets the update — the download is not thrown
 *  away because the moment passed. */
let downloaded = false

/** Where the update's own account of itself goes.
 *
 *  Every failure in this module used to end at `console.error`, which in a packaged app is
 *  nowhere a user can reach — so "Install & Restart did nothing" arrived with no evidence at all.
 *  electron-updater is verbose and its log is the difference between the next report being a
 *  guess and being a diagnosis. */
const LOG_PATH = () => join(process.env.OPERATOR_DIR || join(homedir(), '.operator'), 'updater.log')

function log(level: string, ...args: unknown[]): void {
  const line = `${new Date().toISOString()} [${level}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a, replaceErrors))).join(' ')}\n`
  try {
    mkdirSync(join(process.env.OPERATOR_DIR || join(homedir(), '.operator')), { recursive: true })
    appendFileSync(LOG_PATH(), line)
  } catch { /* a log that cannot be written must not break the update */ }
  console.error(line.trimEnd())
}

/** `JSON.stringify` renders an Error as `{}`, which is the least useful possible log line. */
function replaceErrors(_k: string, v: unknown): unknown {
  return v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v
}

/** What the renderer is told while this runs. Wired in `index.ts`; absent under test. */
type Sink = {
  progress?: (percent: number, transferred: number, total: number) => void
  error?: (message: string) => void
}
let sink: Sink = {}
export function setUpdateSink(next: Sink): void { sink = next }

/** THE REAL MESSAGE, not "install failed". A user who is told an update failed and nothing else
 *  cannot act; the message names the signature check, the 404, or the disk. */
function reportError(stage: string, e: unknown): void {
  const message = e instanceof Error ? e.message : String(e)
  log('error', `${stage}:`, e)
  try { sink.error?.(`${stage}: ${message}`) } catch { /* the sink is best-effort */ }
}

/** THE FILE THAT BROKE EVERY UPDATE, and the belt to the release script's braces.
 *
 *  `AppUpdater.getOrCreateDownloadHelper()` reads `<Resources>/app-update.yml` for
 *  `updaterCacheDirName` — on the DOWNLOAD path only. `checkForUpdates()` never touches it,
 *  because `setFeedURL()` sets the client directly. So a bundle without that file passes the
 *  check, shows "0.18.0 available", and then `downloadUpdate()` rejects with ENOENT.
 *
 *  It was missing because this app is packaged with `@electron/packager` and its feed metadata is
 *  hand-written — `electron-builder`, which normally emits `app-update.yml`, never runs.
 *  `release.mjs` writes it now. This function is what rescues a bundle that shipped WITHOUT it:
 *  0.17.2 and 0.18.0 both lack the file, so without a runtime fallback every installed copy would
 *  be permanently unable to update itself, and the only way forward would be a manual download —
 *  forever, for every future version.
 *
 *  Writing our own and pointing `updateConfigPath` at it is equivalent: the packaged file is data,
 *  not code, and every value in it is one this module already knows. */
function ensureUpdateConfig(url: string): void {
  try {
    const packagedPath = process.resourcesPath ? join(process.resourcesPath, 'app-update.yml') : null
    if (packagedPath && existsSync(packagedPath)) return
    const dir = process.env.OPERATOR_DIR || join(homedir(), '.operator')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'app-update.yml')
    writeFileSync(path, `updaterCacheDirName: com.operator.app.tauri-updater\nprovider: generic\nurl: ${url}\n`)
    // `updateConfigPath` also resets the client, so it must be set BEFORE `setFeedURL` below or
    // the feed we just chose is discarded.
    ;(autoUpdater as unknown as { updateConfigPath: string }).updateConfigPath = path
    log('info', `app-update.yml missing from the bundle; using ${path}`)
  } catch (e) {
    // Non-fatal: the download may still fail, but it will now say why rather than vanishing.
    log('warn', 'could not provide an update config:', e)
  }
}

function configure(): boolean {
  // Read the env on every call rather than at import: the module is imported at startup, and
  // caching the answer there made `OPERATOR_UPDATE_FEED` untestable without a module reset.
  const url = resolveFeedUrl(process.env.OPERATOR_UPDATE_FEED, packaged())
  if (!url) return false
  if (configuredUrl !== url) {
    // BEFORE `setFeedURL` — see the note in `ensureUpdateConfig`: the setter clears the client.
    ensureUpdateConfig(url)
    autoUpdater.setFeedURL({ provider: 'generic', url })
    // The renderer drives this: `checkUpdate` then `installUpdate`, both explicit. Downloading
    // on its own would spend the user's bandwidth on a decision they have not made.
    autoUpdater.autoDownload = false
    // Off UNTIL a download completes — see `downloaded`. Leaving it on from the start would have
    // an unrequested update install itself on the next quit.
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.logger = {
      info: (...a: unknown[]) => log('info', ...a),
      warn: (...a: unknown[]) => log('warn', ...a),
      error: (...a: unknown[]) => log('error', ...a),
      debug: (...a: unknown[]) => log('debug', ...a),
    }
    autoUpdater.on('download-progress', (p: { percent?: number; transferred?: number; total?: number }) => {
      try { sink.progress?.(Math.round(p.percent ?? 0), p.transferred ?? 0, p.total ?? 0) } catch { /* best-effort */ }
    })
    autoUpdater.on('error', (e: Error) => reportError('update', e))
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
    // `updateInfo` IS NOT THE ANSWER TO "IS THERE AN UPDATE". `checkForUpdates()` resolves with
    // the latest entry in the feed whether or not it is newer than what is running, so a
    // packaged 0.17.0 checking a feed whose latest is 0.17.0 gets `updateInfo.version` =
    // '0.17.0'. Reading that alone is what made the shipped 0.17.0 offer itself an update to
    // itself on every launch. The comparison lives in the separate `isUpdateAvailable` flag
    // (`electron-updater/out/AppUpdater.js:400-422`), which is what the Tauri bridge's null
    // return meant and what the renderer still reads as "up to date".
    if (result?.isUpdateAvailable !== true) return null
    const version = result.updateInfo?.version
    if (!version) return null
    // Belt and braces. If the flag and the version ever disagree — a feed quirk, a semver
    // compare surprise — the version already running is not worth a download and a relaunch.
    if (version === currentVersion()) return null
    pending = { version }
    return pending
  } catch (e) {
    // The CHECK stays quiet on the surface — an update checker that surfaces its own plumbing is
    // worse than one that says nothing — but it is no longer silent on disk.
    log('error', 'check failed:', e)
    return null
  }
}

/** What the install needs from the app around it, injected so the ordering is testable. */
export interface InstallHost {
  /** Ask the user ONCE, up front, through the quit guard — so the guard cannot ask again later
   *  and cancel the updater's own quit. Resolves false to abandon the install. */
  confirm: (version: string) => Promise<boolean>
  /** Put the app into "we are quitting" state BEFORE `quitAndInstall`: disarm the guard's veto
   *  and finish teardown, so nothing between here and the relaunch can cancel it. */
  prepareQuit: () => Promise<void>
}

/** THE BUG THIS FUNCTION IS THE FIX FOR.
 *
 *  It used to download and then call `quitAndInstall` directly. That quit lands on `before-quit`,
 *  where `QuitGuard` asks whether to quit while lanes are busy — and the guard's veto
 *  (`e.preventDefault()`) cancels the updater's quit. So the user pressed "Install & Restart",
 *  saw a toast, and stayed on 0.17.2 forever. Every error on the way was swallowed to
 *  `console.error`, which in a packaged app is nowhere, so it looked like nothing happened at all.
 *
 *  The order now, and every step of it matters:
 *
 *    1. DOWNLOAD first, reporting progress. Asking before the bytes exist would put the dialog up
 *       and then make the user wait behind it.
 *    2. `autoInstallOnAppQuit = true` the moment the download lands — so even if everything below
 *       is declined, a later ordinary quit still installs. The download is not wasted.
 *    3. ASK ONCE, through the guard, naming the version and how many lanes are busy. One question,
 *       at the point the user can answer it.
 *    4. PREPARE THE QUIT — mark the guard `quitting` and run teardown to completion — so nothing
 *       downstream vetoes, and so `will-quit`'s teardown hold has nothing left to hold.
 *    5. Only then `quitAndInstall`.
 *
 *  `quitAndInstall(false, true)`: not silent, and FORCE RUN AFTER — the second argument is what
 *  relaunches us once the installer finishes, and it is why step 4 must leave the quit
 *  uninterrupted rather than merely uncancelled. */
export async function installUpdate(host: InstallHost): Promise<void> {
  if (!pending) return
  const version = pending.version
  try {
    if (!configure()) return
    log('info', `downloading ${version}`)
    await autoUpdater.downloadUpdate()
    downloaded = true
    // STEP 2 — the download survives a "not now".
    autoUpdater.autoInstallOnAppQuit = true
    log('info', `downloaded ${version}; autoInstallOnAppQuit armed`)
  } catch (e) {
    reportError('Download failed', e)
    return
  }

  try {
    if (!(await host.confirm(version))) {
      log('info', 'user declined the restart; the update will install on the next quit')
      return
    }
    await host.prepareQuit()
    log('info', `quitAndInstall(${version})`)
    autoUpdater.quitAndInstall(false, true)
  } catch (e) {
    reportError('Install failed', e)
  }
}

/** Has a download completed this run? `index.ts` reads it so a plain quit can say so. */
export const updateDownloaded = (): boolean => downloaded

/** Test seam — the module holds process-wide state and vitest shares one module instance. */
export function __resetUpdaterForTest(): void {
  pending = null
  configuredUrl = null
  downloaded = false
  sink = {}
}
