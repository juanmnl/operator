# Does the CI-built Electron bundle ship `Resources/app-update.yml`, and does the install path work without it?

Scope: `.github/workflows/electron.yml`, `electron/scripts/release.mjs`, `electron/src/main/updater.ts`,
and `electron-updater@6.8.9` source (read from an adjacent worktree's `node_modules`, since this worktree
has none installed — same version pinned in `electron/package.json`). Report only, no code changed.

## 1. Does the bundle ship `Resources/app-update.yml`? No.

`Resources/app-update.yml` is a file **electron-builder** generates during packaging (from its
`build.publish` config) and drops into `Contents/Resources/`. This project does not use electron-builder
at all — `release.mjs` packages with `@electron/packager` (`electron/scripts/release.mjs:67`) and hand-rolls
every release artefact itself:

- `latest-mac.yml` is written straight to the **release output directory** (`electron/release/`), sitting
  next to the DMG/zip on the GitHub release — never copied into the `.app` (`release.mjs:334-352`).
- Nothing in `release.mjs`, `electron.yml`, or anywhere else in the repo (grepped for
  `app-update.yml|appUpdateConfigPath|updaterCacheDirName`, zero hits outside `node_modules`) writes a
  file into `Contents/Resources/`.
- There is also no `electron/dev-app-update.yml` for a forced-dev-config test path.

So: confirmed, the CI-built 0.18.1 `.app` has no `Resources/app-update.yml`, packaged or dev.

## 2. Does the install path work without it, given `setFeedURL` is used? No — it fails at download, not at check.

`electron/src/main/updater.ts:82` calls `autoUpdater.setFeedURL({ provider: 'generic', url })` explicitly on
every `checkUpdate()`/`installUpdate()` call. Walking `electron-updater@6.8.9`'s `AppUpdater.js`:

- **`setFeedURL()`** (`AppUpdater.js:234-247`) builds the provider from the passed options and does
  `this.clientPromise = Promise.resolve(provider)` — this bypasses `configOnDisk` (i.e. `app-update.yml`)
  entirely for provider construction.
- **`getUpdateInfoAndProvider()`** (`AppUpdater.js:380-391`), used by `checkForUpdates()`, only falls back to
  `this.configOnDisk.value` when `clientPromise == null` — which it never is here, since `setFeedURL` set it
  synchronously. **So `checkUpdate()` works fine with no `app-update.yml` on disk.**
- **`getOrCreateDownloadHelper()`** (`AppUpdater.js:543-556`), however, is called unconditionally as the
  *first line* of `executeDownload()` (`AppUpdater.js:585`, which `MacUpdater.doDownloadUpdate` calls
  directly, `MacUpdater.js:89`) — and it independently reads
  `(await this.configOnDisk.value).updaterCacheDirName` to name the update cache directory. `configOnDisk`
  is a `Lazy` wrapping `loadUpdateConfig()` (`AppUpdater.js:482-485`), which does
  `js_yaml.load(await readFile(this._appUpdateConfigPath, 'utf-8'))` — and `appUpdateConfigPath` for a
  packaged app is hardcoded to `path.join(process.resourcesPath, 'app-update.yml')`
  (`ElectronAppAdapter.js:22`).

With that file absent, `readFile` throws `ENOENT`, the `Lazy` rejects, and the rejection propagates up
through `executeDownload → doDownloadUpdate → downloadUpdate()`'s returned promise. `installUpdate()` in
`updater.ts:122-133` awaits `autoUpdater.downloadUpdate()` inside a `try/catch`, so the failure is swallowed
(logged via `console.error`) rather than crashing the app — but `quitAndInstall()` is never reached and the
update silently never installs.

**Net: `setFeedURL` makes the *check* path independent of `app-update.yml`, but the *download* path is
not — `getOrCreateDownloadHelper` reads it regardless of how the provider was configured.** This is a real
gap in the current shell, not a hypothetical: `checkUpdate()` will keep reporting "update available" every
launch while `installUpdate()` quietly no-ops.

Fix shape (not applied — report only): either write a minimal `Resources/app-update.yml` (just
`provider: generic\nurl: <feed>\nupdaterCacheDirName: operator-updater` or similar) into the packaged app in
`release.mjs` after `@electron/packager` runs, or set `this._appUpdateConfigPath` /
`updateConfigPath` — that setter is documented "test only" (`AppUpdater.js:71-76`) but works from app code
too — to a path the app controls, before the first `downloadUpdate()` call.

## 3. Can Squirrel.Mac replace an app bundle at `src-tauri/target/release/bundle/macos/Operator.app` vs `/Applications`?

`MacUpdater` (`electron-updater`) does not do the file replace itself — it proxies the downloaded zip to
Electron's **native** `autoUpdater` module (`this.nativeUpdater = require('electron').autoUpdater`,
`MacUpdater.js:15`), which is Electron's built-in Squirrel.Mac client. It spins up a local HTTP+basic-auth
proxy server serving the downloaded update zip, points the native updater's feed at that local server
(`nativeUpdater.setFeedURL(...)`, `MacUpdater.js:216`), then calls `nativeUpdater.checkForUpdates()` /
`quitAndInstall()` (`MacUpdater.js:227-249`) to hand off the actual install to Squirrel.Mac.

Squirrel.Mac replaces the bundle **in place, at whatever path it is currently running from** — it is not
hardcoded to `/Applications`. The mechanism (documented Squirrel.Mac/Electron behavior, consistent with
what's in this source) is: verify the downloaded bundle's code signature against the running one, then
atomically swap the bundle contents at the running app's own path and relaunch. The only real constraints
are:

- **Write permission** on the parent directory of the running `.app` — no `sudo`/admin elevation is
  attempted, so if the directory isn't writable by the current user, the swap fails silently or with a
  Squirrel error.
- **Code-signature continuity** — old and new bundles need matching Team ID / consistent signing (this repo
  keeps the Tauri `BUNDLE_ID` `com.operator.app.tauri` and signs with the same Developer ID specifically to
  preserve this, per `release.mjs:29-33`).
- The bundle must not be running from a read-only or translocated location (a mounted DMG, or Gatekeeper's
  App Translocation for a quarantined app opened outside `/Applications` — irrelevant for a locally built,
  unquarantined dev binary).

`src-tauri/target/release/bundle/macos/Operator.app` sits inside the repo checkout under the user's home
directory — normally as writable as anywhere in `/Applications` (which itself is only group-writable to
`admin`, not root-owned-immutable). So mechanically, **yes, Squirrel.Mac can replace a bundle at that path**
— there's nothing in the mechanism that special-cases `/Applications`. The caveats worth flagging for a
local S4-step-0 test:

- That directory is `cargo build`'s own output — a later `cargo tauri build` can freely overwrite or
  restructure it, so anything Squirrel.Mac drops there is not durable across a rebuild the way a
  `/Applications` install is.
- This path is specifically the **Tauri** build output. The scenario where Squirrel.Mac would ever act on a
  bundle at this path is a *post-swap* Electron self-update where the Electron `.app` happens to be running
  from that location (e.g. a local test rig that copies/builds the Electron bundle there to simulate an
  installed copy) — the swap itself (Tauri → Electron, first hop) is done by the **Tauri updater plugin**
  extracting its own tarball, not by Squirrel.Mac, which only becomes relevant for Electron-to-Electron
  updates after the swap has already happened once.

## Summary

| Question | Answer |
|---|---|
| Does 0.18.1's CI bundle ship `Resources/app-update.yml`? | **No** — nothing in `release.mjs`/`electron.yml` writes it; this repo doesn't use electron-builder. |
| Does `electron-updater` install work without it when `setFeedURL` is used? | **No, not fully.** Update *checks* work (bypass `configOnDisk`). Update *downloads* fail — `getOrCreateDownloadHelper` reads `app-update.yml` for `updaterCacheDirName` regardless of `setFeedURL`, throws `ENOENT`, and `installUpdate()` silently swallows it. This is a live gap in the current updater wiring. |
| Can Squirrel.Mac replace a bundle outside `/Applications` (e.g. under `src-tauri/target/release/bundle/macos/`)? | **Yes** — it replaces in place at the running app's own path; no `/Applications` special-casing, only a writable-parent-directory + matching-signature requirement. |
