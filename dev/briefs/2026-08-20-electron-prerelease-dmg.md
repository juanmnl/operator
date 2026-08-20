# Brief — ship the Electron Operator as a signed, notarized, downloadable DMG (pre-release)

**Top priority — ahead of S0/S1. Implement on your branch; Operator merges to main, pushes and
tags.** Output: **`dev/briefs/2026-08-20-electron-prerelease-dmg-RESULT.md`** with the exact tag
name to push and what the user will see.

## What the user asked for
"Fire a build and cut a tag, then give me the link to download" — after trying the Electron dev
shell (`spike/electron`, commit 91a3eb2) and finding it works. They want to run it as their
Operator. **Guardrail (Operator's decision): this ships as a GitHub PRE-RELEASE DOWNLOAD on
`juanmnl/operator`, NOT through `latest.json`/`juanmnl/operator-releases`** — that feed would
auto-swap every installed copy through the unproven one-way door (S4 step 0). No `latest.json`,
no upload to operator-releases, no `v*` tag (that pattern triggers the Tauri release job in
`build.yml`). Tag pattern for this: **`electron-v*`**.

## Build spec
- **Product name `Operator`, bundle id `com.operator.app.tauri`** (hand-off recipe: keep the id
  so a drag-over-/Applications replaces the Tauri install cleanly and TCC/LS identity is
  unchanged; rename later), **version `0.17.0-alpha.1`** (shell `package.json` version; make
  `app.getVersion()` and `--mcp-serve` report it — the spike already fixed the dev-mode
  fallback). Icon = `src-tauri/icons/icon.icns`.
- arm64 only. Prune `node-pty/prebuilds` to darwin-arm64. asar on. The MCP self-spawn path
  (`process.execPath --mcp-serve`) must keep working from the packaged app — assert it in CI by
  running the probe's driver against the built `.app` (`spike/electron/mcp-probe/scripts/drive.mjs`
  pattern) BEFORE notarization.
- **Sign**: Developer ID Application (`Juan Cornejo (UJS4C5GUCW)`), hardened runtime, the
  entitlements the probe used (`com.apple.security.cs.allow-jit`,
  `allow-unsigned-executable-memory`, `disable-library-validation` as needed for Electron),
  sign helpers/frameworks deep. Tool: `@electron/osx-sign` (or electron-builder if you switch —
  your call, but don't spend the evening on a tool migration).
- **Notarize + staple**: `@electron/notarize` or `xcrun notarytool submit --wait` with the API
  key; `xcrun stapler staple` the `.app` AND the `.dmg`; assert `stapler validate` + `spctl -a -t
  exec` on the `.app` (the probe proved an unstapled quarantined bundle hangs `--mcp-serve`).
- **DMG**: `Operator_0.17.0-alpha.1_aarch64.dmg` with an /Applications symlink (`hdiutil` or
  `create-dmg`); also produce `Operator-0.17.0-alpha.1-arm64-mac.zip` + `latest-mac.yml`
  (electron-updater shape, generic provider, feed URL = the operator-releases
  `releases/latest/download/`) and attach them to the pre-release too, so the installed Electron
  app can be updated later without another manual download. **Do not publish the yml anywhere
  else.** The updater in-app stays inert unless the feed URL serves a yml (it won't yet).

## CI: `.github/workflows/electron.yml`
- `on: push: tags: ['electron-v*']` + `workflow_dispatch`. `macos-14`. Permissions
  `contents: write`.
- Steps: checkout; setup-node 20; root `npm ci` (the shell's Vite resolves renderer plugins from
  the ROOT node_modules); shell `npm ci` — **npm's install-scripts policy skipped esbuild and
  node-pty install scripts locally today**; make CI robust: either `npm ci --foreground-scripts`
  with explicit approval or run `node node_modules/esbuild/install.js` + node-pty's
  `scripts/prebuild.js`/`post-install.js` explicitly, and assert `require('node-pty')` loads.
- Import the Developer ID cert into a temp keychain from `APPLE_CERTIFICATE` (base64 .p12) +
  `APPLE_CERTIFICATE_PASSWORD` (mirror what tauri-action does); `APPLE_SIGNING_IDENTITY`,
  `APPLE_TEAM_ID`, `APPLE_API_KEY_BASE64`→file, `APPLE_API_KEY`, `APPLE_API_ISSUER` are all
  existing secrets (see `build.yml` L63-81).
- Build → package → mcp-serve assertion → sign → notarize → staple → validate → DMG/zip/yml →
  `gh release create "$GITHUB_REF_NAME" --prerelease --title "Operator $VERSION (Electron
  preview)" --notes-file <generated> <dmg> <zip> <yml> <sha256sums>` on THIS repo using
  `GITHUB_TOKEN`. Print the DMG URL as the last log line and as a job summary.
- Also run the root test gate (`npm test`, tsc) like `build.yml`'s verify job — same bar.

## Release notes (generate into the release body)
What it is (Electron preview of Operator 0.17), what changed for users (no hourly renderer
restart, terminal renderer, bigger download ~280 MB), that it replaces `/Applications/Operator.app`
by drag-and-drop and reads the same `~/.operator` state, that auto-update from the Tauri app is
NOT wired on purpose, and how to go back (re-download 0.16.0 from operator-releases).

## RESULT must state
The tag name to push, which checks ran locally (you can test packaging + signing locally; say if
notarization was CI-only), the expected DMG URL shape
(`https://github.com/juanmnl/operator/releases/download/electron-v0.17.0-alpha.1/Operator_0.17.0-alpha.1_aarch64.dmg`),
and anything the user must know before dragging it over the installed app.
