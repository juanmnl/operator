# Updater visibility — already shipped upstream, plus the app-update.yml answer

**Date:** 2026-08-25 · **Lane:** Code · **Verdict: no code written. Every item in the brief is
already on `origin/main` and released as 0.18.1.** My checkout's `main` (`e574c08`) is 7 commits
behind; I built the whole thing before noticing, then dropped it rather than ship a second,
conflicting implementation. The parked diff is at
`scratchpad/updater-visibility-duplicate.patch` if any of it is wanted.

---

## 1. What the brief asked for, and where it already is

| Brief | Upstream | Where |
|---|---|---|
| (1) `updater` log file, append, timestamped, mirroring the electron-updater logger + check/install outcomes | **done** — `~/.operator/updater.log` (not `logs/updater.log`), `log(level, …)` at `updater.ts:92`, wired as `autoUpdater.logger` for info/warn/error/debug, plus our own check and install outcomes | `feffecd`, `ef75b14` |
| (2) `onUpdateProgress` / `onUpdateFailed` events + a state that shows progress and surfaces failure text | **done** — `Sink` + `setUpdateSink` in `updater.ts`, `onUpdateProgress` / `onUpdateError` in `env.d.ts:132,135`, subscribed in `DashboardView.tsx:3307-3319` (progress toasts at 25% steps, failure toast carrying the real message) | `ef75b14` |
| (3) unit test for the failure path | **done** — `updater.test.ts`: "a failed DOWNLOAD reports the real message and never asks", "an autoUpdater error reaches the sink with its message", "forwards download progress rather than swallowing it", plus the ordering suite | `ef75b14`, `feffecd` |

Two naming differences from the brief, both cosmetic: the log is `~/.operator/updater.log` rather
than `~/.operator/logs/updater.log`, and the event is `onUpdateError` rather than
`onUpdateFailed`. Not worth churning.

Upstream also found and fixed something the brief did not know about: **the quit guard was
vetoing the install** (`ef75b14`). `quitAndInstall` lands on `before-quit`, where `QuitGuard`
`preventDefault()`s while lanes are busy — cancelling the updater's own quit. The fix is an
order: download → ask once → `prepareQuit` (disarm the guard) → quit. It is pinned by tests.

### Genuinely still open (small, and not in the brief's three items)

- **`PrefsView.tsx` is untouched.** Its Install button still reads `Installing…` forever and has
  no failure line — the same inert surface the brief describes, in the other place it appears.
  It does not subscribe to `onUpdateProgress` / `onUpdateError` at all.
- **The sidebar rail's update arrow** (`ProjectRail.tsx:1258`) has no downloading state either;
  it stays a plain press-me arrow for the whole download.
- The Tauri bridge (`src/operator-bridge.ts`) implements neither event. Both are optional in
  `env.d.ts`, so it degrades rather than breaks; noting it only because the ledger should say so.

Recommend these three to the coordinator as a follow-up rather than doing them here — this lane's
base is stale and a `DashboardView`/`updater.ts` edit from here would conflict with `origin/main`.

---

## 2. Does the CI 0.18.1 bundle ship `Resources/app-update.yml`?

**Yes — 0.18.1 does. 0.18.0 and 0.17.2 did not.**

- `origin/main`'s `electron/scripts/release.mjs` writes it inside packager's `afterCopy`, keyed
  `updaterCacheDirName: com.operator.app.tauri-updater` + `provider: generic` + the feed URL. It
  has to be `afterCopy` and not a later step: `osxSign` runs *during* packaging, so a file added
  afterwards falls outside the sealed `Resources` and breaks `codesign --verify`.
- `electron.yml` adds nothing here — it just runs `npm run release`. The whole answer is
  `release.mjs`.
- Verified on the installed artifact rather than from source alone:
  `/Applications/Operator.app` is `CFBundleShortVersionString 0.18.1`, carries a Chrome
  quarantine xattr (so it is the downloaded CI build, not a local one),
  `Contents/Resources/app-update.yml` exists with exactly those three keys, and
  `codesign --verify --strict` on the bundle exits 0 — i.e. the file was inside the signed
  artifact, not dropped in afterwards.

Before `feffecd`, nothing in the repo produced that file: the app is packaged with
`@electron/packager` and `latest-mac.yml` is hand-written, so `electron-builder` — the thing that
normally emits `app-update.yml` — never runs, while the *client* is `electron-updater` all the
same.

## 3. Can electron-updater 6.8.9 download + `quitAndInstall` without it, given `setFeedURL`?

**No. `setFeedURL` covers the check completely and the download not at all.** That asymmetry is
the entire bug, and it is why 0.17.0 "found" an update and then died silently.

Traced in `electron/node_modules/electron-updater/out`:

- `setFeedURL` assigns `this.clientPromise = Promise.resolve(provider)` directly
  (`AppUpdater.js:234-248`). `checkForUpdates()` → `getUpdateInfoAndProvider()` uses that client
  and **never reads a config file** (`AppUpdater.js:380-391`). So the check works with no
  `app-update.yml` anywhere. This is why the toast always appeared.
- `downloadUpdate()` → `executeDownload()` → `getOrCreateDownloadHelper()`
  (`AppUpdater.js:585`, then `542-556`), which reads `updaterCacheDirName` out of
  `configOnDisk` → `loadUpdateConfig()` → `readFile(this.app.appUpdateConfigPath)`
  (`AppUpdater.js:482-486`). `appUpdateConfigPath` is
  `join(process.resourcesPath, 'app-update.yml')` when packaged
  (`ElectronAppAdapter.js:22-24`).
- With no such file that read rejects **ENOENT**, `downloadUpdate()` rejects, and the old
  `installUpdate` caught it into `console.error` — nowhere, in a packaged app. `quitAndInstall`
  is never reached, which matches the report exactly: no dialog, no quit, no error.
- Note the `dirName == null` branch at `AppUpdater.js:548` only handles a config that *parsed*
  without the key. A *missing file* throws before it and is not defended.

So: `setFeedURL` alone is not sufficient. The config file must exist somewhere, and
`updateConfigPath` is the only supported way to point at one that is not in `Resources`.

**Which is what `origin/main` does, on both ends** (`updater.ts:138-155`, `ensureUpdateConfig`):
if `<Resources>/app-update.yml` is absent, it writes one to `~/.operator/app-update.yml` and sets
`autoUpdater.updateConfigPath` to it — **before** `setFeedURL`, because that setter nulls
`clientPromise` and would otherwise discard the feed just chosen. A test asserts the call order
(`['updateConfigPath', 'setFeedURL', 'downloadUpdate', 'quitAndInstall(false,true)']`).

That runtime fallback is load-bearing, not belt-and-braces: **0.17.2 and 0.18.0 both shipped
without the file**, so without it every installed copy would be permanently unable to update and
every future version would need a manual DMG. With it, an installed 0.18.0 can update itself once
it is running code that contains `feffecd` — which it is not, so the consequence stated in that
commit stands: **0.17.2 → 0.18.0 and 0.18.0 → 0.18.1 need one manual DMG install; after that both
mechanisms work independently.**

---

## Verification

Nothing was changed, so nothing new was run against `main`. The upstream work reports 381
electron tests green at `feffecd`. My own (now dropped) parallel implementation typechecked and
passed 384 electron tests + `npm run build`; the renderer suite was 33 failed / 920 passed both
with and without it, i.e. pre-existing and unrelated.
