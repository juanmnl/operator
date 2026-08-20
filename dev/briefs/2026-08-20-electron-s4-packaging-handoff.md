# Brief — Electron S4: packaging, signing, the updater feed, and the one-way swap release

**Implement on your branch after S1 is accepted. Output:
`dev/briefs/2026-08-20-electron-s4-packaging-handoff-RESULT.md`. Do NOT tag, do NOT publish to
`juanmnl/operator-releases`, do NOT touch `~/.operator/updater-private.key` except to READ it
for the local swap test in step 0. The release itself is the user's action.**

Inputs (read first): `dev/briefs/2026-08-20-tauri-updater-crossshell-handoff-RESULT.md` (the
source-read verdict + recipe), `…-electron-mcp-serve-probe-RESULT.md` (notarization is
load-bearing), `…-staple-notarization-ticket-RESULT.md` (what CI does now for Tauri),
`.github/workflows/build.yml`, `src-tauri/tauri.conf.json` (`identifier` =
`com.operator.app.tauri`, `plugins.updater.pubkey`, endpoint), `spike/electron/src/main/updater.ts`
(`OPERATOR_UPDATE_FEED`, generic provider).

## Step 0 — prove the one-way door locally before anything else (half a day)

The hand-off result says the Tauri updater will swap in any minisign-signed tarball whose root is
a single `.app`-shaped dir and relaunch via the NEW `Info.plist`'s `CFBundleExecutable`. Prove it:
1. Build a local **Tauri** Operator (`npm run tauri build`, needs
   `TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.operator/updater-private.key)"` and an empty password —
   see memory `project_tauri_build_state`) with `plugins.updater.endpoints` pointed at
   `http://localhost:<free port>/latest.json` via a **throwaway** `--config` override, version
   0.16.0. Do not install it over `/Applications/Operator.app`; run it from the bundle dir.
2. Build the **Electron** `.app` (step 1 below) with `CFBundleIdentifier` =
   `com.operator.app.tauri`, `CFBundleName`/`productName` = `Operator`, version **0.17.0**. Tar it
   (`COPYFILE_DISABLE=1 tar -czf Operator.app.tar.gz -C <dir> Operator.app`), sign the tar with
   `npx tauri signer sign` using the same key, write a `latest.json` (version 0.17.0,
   `platforms.darwin-aarch64.{url,signature}`) and serve both from that port.
3. Launch the Tauri build → "Install & Restart" → confirm (a) the swap completes, (b) the relaunch
   brings up the **Electron** Operator, (c) it reads the same `~/.operator` state — use a COPY of
   `~/.operator` via `HOME`/env override if the shell supports it, otherwise state that the test
   ran against real state and what it wrote. Record timings and any Gatekeeper/TCC dialog.
If step 0 fails, stop, write the RESULT with the failure, and the fallback becomes the plan's
"notice release" — don't build around an unproven door.

## Step 1 — packaging

- `electron-builder` in `electron/` (or `spike/electron/` if not yet moved): targets `dmg` **and
  `zip`** (Squirrel.Mac needs the zip for `latest-mac.yml`), `arm64` only (parity with today),
  `appId` = `com.operator.app.tauri` **for the swap release** (rename to `com.operator.app` is a
  later, ordinary update — TCC risk isolated), hardened runtime, the entitlements the spike signs
  with, `afterSign` → `@electron/notarize` with the App Store Connect key (CI secrets
  `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_BASE64` already exist), **staple** the
  `.app` and the `.dmg`, and assert `xcrun stapler validate` + `spctl -a -t exec` on the `.app`
  AND on the `.app` unpacked from the updater tarball (same assertion CI now makes for Tauri).
- Prune `node-pty/prebuilds` to darwin-arm64 (the spike measured 58 MB of dead prebuilds).
- `app.getVersion()` must be Operator's (the spike fixed this in dev; confirm in the packaged app)
  and `--mcp-serve` must report it too.

## Step 2 — the feeds

- `electron-updater`: `publish` generic provider → `https://github.com/juanmnl/operator-releases/releases/latest/download/` with
  `latest-mac.yml` + the `.zip`; wire `OPERATOR_UPDATE_FEED` default to that URL in the packaged
  build (dev stays inert). Verify the yml's `sha512` matches the zip.
- Tauri swap payload: `Operator.app.tar.gz` + `.sig` (minisign, same key) + `latest.json`
  (version 0.17.0). Both feeds live in the SAME release; filenames don't collide.

## Step 3 — CI

- New job (or matrix leg) in `.github/workflows/build.yml` for the Electron build on `macos-14`:
  build, sign, notarize, staple, assert, upload artifacts; on a `v*` tag publish BOTH feeds to
  `juanmnl/operator-releases`. Keep the Tauri job until the swap release is out and soaked; after
  that it goes (plan: `src-tauri/` to a branch). The minisign signing uses
  `TAURI_SIGNING_PRIVATE_KEY`/`_PASSWORD` secrets exactly as the staple step does.
- `scripts/electron.mjs` dev wrapper honouring `OPERATOR_DEV_PORT` with strict-port semantics
  (parity with `scripts/tauri.mjs`); `npm run electron dev` at root.

## Step 4 — version + release notes draft

- Bump to **0.17.0** in `package.json` (+ lock) and the Electron config; leave `src-tauri/*`
  versions alone (the Tauri job is not what ships 0.17.0).
- Draft `dev/release-notes-0.17.0.md`: what changed for users (terminal renderer, no more hourly
  restart, bigger download), the one-time swap, and the "nothing moves in `~/.operator`" promise.

## RESULT must state
Step 0's outcome with timings; bundle size and idle RSS of the packaged app; the exact commands
the user runs to tag/release; and what is NOT verified (anything CI-only).
