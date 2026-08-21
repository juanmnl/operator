# Brief — packaged Electron app cannot spawn a pty: node-pty's `spawn-helper` is sealed inside app.asar

**Found 2026-08-21 during S4 step 1 (the one-way swap click).** The CI-built, notarized `Operator.app`
(electron-v0.17.0-rc.1 payload, now sitting at `~/.operator/swap-check/Operator-swapcheck.app`) loads
`better-sqlite3` and `node-pty` fine, but every `pty.spawn()` fails with **`posix_spawnp failed.`**

Why: on macOS node-pty 1.x execs a tiny helper binary next to its `.node`
(`lib/unixTerminal.js`: `var helperPath = native.dir + '/spawn-helper'`). The packager unpacks
`**/*.node` to `app.asar.unpacked/` but leaves `spawn-helper` INSIDE the asar, where nothing can
`exec` it:

```
app.asar.unpacked/node_modules/node-pty/build/Release/        pty.node            ← only this
app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/ pty.node            ← only this
app.asar/node_modules/node-pty/build/Release/spawn-helper                          ← sealed
app.asar/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper                 ← sealed
```

Reproduced headlessly (no window) against the shipped bundle:
```sh
APP=~/.operator/swap-check/Operator-swapcheck.app
ELECTRON_RUN_AS_NODE=1 "$APP/Contents/MacOS/Operator" -e '
  const pty=require(process.argv[1]+"/node_modules/node-pty");
  try { pty.spawn("/bin/echo",["hi"],{name:"xterm",cols:80,rows:24}).onExit(()=>console.log("OK")) }
  catch(e){ console.log("FAIL:", e.message) }' "$APP/Contents/Resources/app.asar"
# → FAIL: posix_spawnp failed.
```
This means the packaged 0.17.0 cannot launch a single lane. S1–S3 ran unpackaged (`npx electron`),
so nothing caught it.

## Task (Code lane)
1. In `electron/scripts/release.mjs`, make the packager unpack node-pty's `spawn-helper` alongside
   its `.node` (e.g. `asar: { unpack: '{**/*.node,**/node-pty/**/spawn-helper}' }` — or unpack the
   whole `node_modules/node-pty` dir; check what `@electron/packager` 20 accepts). Keep the
   `prebuilds/(?!darwin-arm64)` ignore.
2. The helper must stay executable (mode) and get SIGNED with the rest of the bundle — `osxSign`
   with `optionsForFile` should pick it up as a nested Mach-O; verify with
   `codesign -dv <unpacked>/spawn-helper` on the output. If the signer skips it, notarization
   will reject the bundle — handle that explicitly.
3. Add the headless pty smoke test above to `step('verify what shipped')` in release.mjs (fail
   the build on `posix_spawnp failed`). It needs no window: `ELECTRON_RUN_AS_NODE=1`.
4. Build locally with `SKIP_SIGN=1` (whatever the script's local path is — do NOT sign/notarize,
   do NOT publish, do NOT install or open any .app) and show the smoke test passing.

Do not touch `src-tauri/`, the updater key, or anything under `~/.operator`.

**Output:** `dev/briefs/2026-08-21-node-pty-spawn-helper-unpack-RESULT.md` — the diff, the
packager option that worked, and the smoke-test output before/after. Report via `operator__report`.
