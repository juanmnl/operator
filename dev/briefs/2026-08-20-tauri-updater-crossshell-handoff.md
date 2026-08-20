# Brief — can the Tauri updater install the Electron Operator? Settle it from source.

**Investigate and report. Change no code.** Output:
**`dev/briefs/2026-08-20-tauri-updater-crossshell-handoff-RESULT.md`**.

Two lanes disagree and the answer decides the hand-off for every installed user:
- Spike (`dev/briefs/2026-08-20-electron-shell-spike-RESULT.md`, "Signing, notarization,
  updates"): the Tauri updater minisign-verifies the `.app.tar.gz` and replaces the `.app`
  **without inspecting its contents**, so an Electron `.app` with the same bundle id + Developer
  ID should install over it once — *inference, untested*.
- Plan (`dev/briefs/2026-08-20-electron-migration-plan-RESULT.md`, "Hand-off plan"): "not
  bridgeable", recommends a final Tauri release that only shows a "download the new Operator"
  notice.

Settle it from the **source of `tauri-plugin-updater`** at the version pinned in
`src-tauri/Cargo.lock` (read the lock; fetch that exact tag from `tauri-apps/plugins-workspace`).
Answer, with file:line citations:
1. macOS install path: after signature verification, what exactly does it do with the archive?
   Does it check bundle id, `Info.plist`, Tauri-ness, executable name, or anything about the
   payload — or just extract-and-swap? Does it require the archive to contain a single `.app`
   at the root, with what name? Does it relaunch via a path that assumes the old executable name
   (`Contents/MacOS/operator`)?
2. Our config: `src-tauri/tauri.conf.json` `plugins.updater` (endpoint, pubkey) and
   `createUpdaterArtifacts: true` — what the CI produces (`.github/workflows/build.yml`) and what
   `latest.json` looks like today on `juanmnl/operator-releases` (fetch the live one).
3. Electron side: with `electron-builder` producing the `.app`, can we (a) tar it as
   `Operator.app.tar.gz`, (b) sign that tar with the existing minisign key
   (`~/.operator/updater-private.key`, NEVER regenerate), (c) publish a `latest.json` pointing at
   it — and have the Tauri updater swap it in? What about the bundle id: today
   `com.operator.app.tauri`; the plan proposes `com.operator.app` for Electron — does the updater
   care? Does macOS (LaunchServices/Gatekeeper/TCC) care about the id change for an in-place swap?
4. After the swap the Tauri updater is gone. Does `electron-updater` need anything at first
   launch for the NEXT update to work (feed shape `latest-mac.yml` alongside `latest.json` in the
   same GitHub release — any conflict)?
5. Verdict: **one-way door works / works with conditions / does not work** — and if it works, the
   exact release recipe; if not, the notice-release recipe (version must exceed 0.16.0 etc.).
Recommend what a throwaway test would look like (a dummy signed tar installed over a local
Tauri build pointed at a local `latest.json`) — don't run it if it needs the private key; say so.
