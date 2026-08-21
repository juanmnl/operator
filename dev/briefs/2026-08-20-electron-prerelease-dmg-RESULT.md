# Result — the Electron Operator, as a signed pre-release DMG

**Ready to tag.** Everything except notarization ran on this machine, end to end, against the
real bundle. Notarization is CI-only (the App Store Connect issuer id is a secret), so that step
and the release upload are the parts that run for the first time on CI.

## The tag to push

```
electron-v0.17.0-alpha.1
```

**Not `v0.17.0-alpha.1`** — `v*` triggers the Tauri release job in `build.yml`, which would build
and publish the Tauri app to `operator-releases`. `.github/workflows/electron.yml` listens on
`electron-v*` only.

## The download link it produces

```
https://github.com/juanmnl/operator/releases/download/electron-v0.17.0-alpha.1/Operator_0.17.0-alpha.1_aarch64.dmg
```

A **pre-release on `juanmnl/operator`**, four assets: the DMG, the zip, `latest-mac.yml` and
`SHA256SUMS.txt`. The workflow prints that URL as its last log line and writes it into the job
summary. Nothing goes to `operator-releases`; no `latest.json` is written anywhere.

## What the build produces

| | |
|---|---|
| `Operator_0.17.0-alpha.1_aarch64.dmg` | **143.0 MB** — Operator.app + an `/Applications` symlink |
| `Operator-0.17.0-alpha.1-arm64-mac.zip` | 128.6 MB — the electron-updater payload |
| `latest-mac.yml` | the electron-updater feed descriptor (sha512 + size) |
| `SHA256SUMS.txt` | so a download can be checked without trusting the page |
| Installed app | **313 MB**, arm64 only |

Bundle id `com.operator.app.tauri`, product name `Operator`, version `0.17.0-alpha.1` — asserted
against `Info.plist` in the build, not assumed. `app.getVersion()` and the `--mcp-serve`
`serverInfo` both report `0.17.0-alpha.1` (verified: the gallery footer reads `v0.17.0-a…`).

313 MB rather than the ~366 MB a naive package produces, because node-pty's prebuilds are pruned
to `darwin-arm64` — 58 MB of the bundle was prebuilt binaries for platforms this app cannot run
on. Pruned by `ignore` at copy time, not deleted afterwards: a signature seals the contents.

## What ran locally

| Check | Result |
|---|---|
| Renderer built by the app's own pinned vite | **7.3.5** (see the trap below) |
| Bundle id / version asserted against `Info.plist` | ✅ |
| Icon is ours, byte-checked against `src-tauri/icons/icon.icns` | ✅ 352 KB |
| node-pty prebuilds pruned | `darwin-arm64` only |
| `codesign --verify --deep --strict` | ✅ valid, hardened runtime |
| **Packaged app answers `--mcp-serve`** | ✅ 7/7 protocol checks, 1726 ms cold |
| DMG mounts with an `/Applications` symlink | ✅ |
| **Packaged app launches and renders the real fleet** | ✅ screenshot, 16 projects, 504 MB RSS across 4 processes |
| Shell typecheck + 84 tests | ✅ |
| Root typecheck + 786 tests | ✅ |

**Notarization, stapling and `spctl` were NOT run locally** — `notarytool` needs
`APPLE_API_ISSUER`, which exists only as a CI secret. The script does them unconditionally unless
`SKIP_NOTARIZE=1`, and asserts `stapler validate` + `spctl -a -t exec` on the `.app` afterwards,
so a failure there fails the build rather than shipping a bundle that hangs. That assertion
matters more than it looks: the MCP probe measured that a **quarantined, unnotarized bundle hangs
silently when spawned as `--mcp-serve`** — no output, no error, no exit code — which is exactly
how every lane's artifact plane would fail for anyone who downloaded it.

## One script, not a workflow full of steps

`spike/electron/scripts/release.mjs` does build → package → prune → sign → **assert `--mcp-serve`**
→ notarize → staple → validate → DMG/zip/yml. The workflow sets the environment and calls it. So
what CI ships is what a laptop can run, minus one env var; the alternative — steps inlined in
YAML — means the thing you can test is not the thing that ships.

The `--mcp-serve` assertion sits **after signing and before notarization** deliberately: it is the
signed binary a lane will actually spawn, and notarization takes minutes that are wasted if the
artifact plane is broken. It runs against a sandboxed `OPERATOR_DIR`, because `operator__report`
really inserts a row and pointing it at the real `~/.operator` would leave a probe report in the
user's artifact store on every build. (It did exactly that once during development; the row was
removed, the other 302 untouched.)

## Four traps found while building this

**1. `npx vite` silently downloaded a different bundler.** The shell declares no vite of its own —
the renderer it builds *is* the root renderer — so `npx vite build` fetched **vite 8.2.2** from the
registry and built with rolldown instead of the app's pinned **7.3.5**. In CI it would fetch
whatever was newest that morning. Now invoked by path: `../../node_modules/.bin/vite`.

**2. Copying the packaged app invalidated its signature.** `fs.cpSync` rewrites symlinks relative
to the destination, and a macOS framework is held together by them — `codesign --deep` failed with
`Squirrel.framework: bundle format unrecognized, invalid, or unsuitable`. The script `mv`s the
bundle instead; a rename touches nothing inside.

**3. Signing separately from packaging produced an unquoted `codesign` command** that choked on
the space in `Electron Framework.framework`. Signing now happens *during* packaging, through
packager's JS API — which also fixed the icon, silently dropped by the CLI.

**4. `better-sqlite3` was missing from `postinstall`.** It had been rebuilt by hand during
development, so a clean CI checkout would have shipped a Node-ABI binary and failed at the first
query. `postinstall` is now `electron-rebuild -f -w node-pty,better-sqlite3`, and CI asserts both
`.node` files exist before building.

## Before you drag it over the installed app

- **Quit the running Operator first.** Its lanes are child processes; replacing the app under them
  is not something to discover mid-task.
- It **keeps the Tauri bundle id**, so it replaces `/Applications/Operator.app` cleanly and macOS
  permissions (TCC) carry over rather than being re-prompted. Renaming the id is a later decision.
- It reads the **same `~/.operator`** — projects, sessions, chat history, artifact reports. Nothing
  is migrated or rewritten; both builds read the same files.
- **Auto-update is deliberately not wired.** This build will not update itself, and the Tauri app
  will not update into it. That swap is a one-way door (after it, the Tauri updater is gone), so it
  stays opt-in and manual.
- **Going back** is re-downloading 0.16.0 from `operator-releases` and dragging it over. Neither
  direction touches `~/.operator`.

### Known gaps in this build

- **The custom title bar is not draggable.** Electron has no programmatic window drag; it needs
  `-webkit-app-region: drag` on `DragRegion` in `src/renderer`. This is the one place the
  renderer's contract does not map onto Electron.
- **No GUI verification beyond screenshots.** I can capture frames, not click — so the ⌘Q dialog,
  a real Finder drop, and ⌘C/⌘V in the terminal are unexercised in this shell.
- **WebGL is off**, as it is under Tauri. It was clean for 60 minutes under test, which is not the
  2-hour soak that would settle it.
- **The grid terminal is not ported** (dropped by decision) and the in-app updater is inert.

## If CI fails

The two steps that have never run: notarization (needs the three Apple secrets to be present and
valid — `APPLE_API_KEY_BASE64`, `APPLE_API_KEY`, `APPLE_API_ISSUER`) and the certificate import
into a temp keychain. Both mirror what `build.yml` already does successfully, so the risk is
mistyped secret names rather than mechanism. Everything downstream of them is exercised locally.

`workflow_dispatch` is enabled, so the whole thing can be rehearsed on a branch without a tag —
it derives the tag from the version when there is no `electron-v*` ref.
