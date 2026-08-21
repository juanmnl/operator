# Brief — stage the one-way-swap click check (S4 step 1), nothing published, nothing launched

**Lane:** Code. **Output:** `dev/briefs/2026-08-21-swap-click-staging-RESULT.md` on your branch
+ `operator__report` when done. **Hard rules:** do NOT open any GUI app or window, do NOT start a
long-lived server, do NOT touch `/Applications`, the real `src-tauri/tauri.conf.json`, or any
file already in `~/.operator` — you only CREATE `~/.operator/swap-check/`. The signing key at
`~/.operator/updater-private.key` is read, never written, never copied, never printed.

## Why

`dev/briefs/2026-08-20-electron-s4-packaging-handoff-RESULT.md` proved the Tauri updater swaps in
the Electron `.app` — except the one click (**Install & Restart** in a live Tauri window), which
is the residual Gatekeeper/TCC risk before the release that moves every installed copy. The user
will press that button themselves. Your job is to stage everything so that the click is the ONLY
thing left, and to stage it against the **real, notarized** `electron-v0.17.0-alpha.3` payload
(S4 step 0 used a `SKIP_NOTARIZE=1` build — Gatekeeper on relaunch was therefore never exercised).

Read S4's RESULT first (the recipe, the `dangerousInsecureTransportProtocol` panic, the
"no window under isolated HOME" harness note). Read `.github/workflows/electron.yml` and
`electron/scripts/release.mjs` to know what the zip contains.

## Stage, in `~/.operator/swap-check/`

1. **Payload.** `gh release download electron-v0.17.0-alpha.3 -R juanmnl/operator -p '*.zip' -p 'SHA256SUMS.txt'`.
   Verify the zip's SHA256 against `SHA256SUMS.txt`. Unpack with `ditto -x -k` (never `unzip`/`cp -R`).
   Assert on the unpacked `Operator.app`: `codesign --verify --deep --strict`, `spctl -a -vv -t exec`
   says accepted/Notarized Developer ID, `xcrun stapler validate`, `Info.plist` bundle id
   `com.operator.app.tauri`, `CFBundleExecutable` `Operator`, version `0.17.0-alpha.3`.
2. **Tarball + signature.** `COPYFILE_DISABLE=1 tar -czf feed/Operator.app.tar.gz -C <dir> Operator.app`
   (root entry must be `Operator.app/`, `Contents/` at the second level — assert with `tar -tzf | head`).
   Sign: `TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.operator/updater-private.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" npx tauri signer sign feed/Operator.app.tar.gz`.
   **Verify the `.sig` against the pubkey in `src-tauri/tauri.conf.json` independently** (minisign
   format: key ids match, ed25519 over blake2b-512 prehash of the raw bytes — S4 did this; redo it,
   don't assume). Also assert the tarball still matches the stapled bundle after a test-extract
   (`--strip-components=1` → `Contents/`; `codesign --verify --deep --strict` on the re-assembled app).
3. **`feed/latest.json`** — `{"version":"0.17.0-alpha.3","notes":"swap check","pub_date":"<now, RFC3339>","platforms":{"darwin-aarch64":{"signature":"<the .sig file's full contents>","url":"http://127.0.0.1:1462/Operator.app.tar.gz"}}}`.
   Confirm the Tauri updater's semver compare treats `0.17.0-alpha.3` as newer than `0.16.0` — read
   the vendored `tauri-plugin-updater` source in `~/.cargo/registry` (the `version` comparison), cite
   file:line. If it does NOT, say so and use `"0.17.0"` in latest.json instead (the updater never
   compares the payload's own version; S4 established that).
4. **Throwaway Tauri 0.16.0** pointed at the local feed, built IN YOUR WORKTREE with `--config` (the
   repo's `tauri.conf.json` untouched; `git status` must show no change to it):
   `{"plugins":{"updater":{"endpoints":["http://127.0.0.1:1462/latest.json"],"dangerousInsecureTransportProtocol":true}}}`.
   `npm run tauri build -- --target aarch64-apple-darwin --bundles app --config <that file>` with the
   `TAURI_SIGNING_PRIVATE_KEY`/`_PASSWORD` env as in S4. Copy the result with `ditto` to
   `~/.operator/swap-check/Operator-swapcheck.app` — rename the bundle so it can never be mistaken for
   shippable, and `codesign --verify` it after the copy. (It is adhoc/dev-signed — say which.)
5. **`serve.sh`** — `cd feed && python3 -m http.server 1462 --bind 127.0.0.1` (foreground; the user
   runs it in a terminal). **`README.md`** — the user's exact steps (see below) and the teardown
   (`rm -rf ~/.operator/swap-check`). Do NOT run `serve.sh` yourself beyond a curl smoke test you
   then kill (`curl -sI http://127.0.0.1:1462/latest.json` → 200, then stop it; assert no listener
   is left on 1462 when you finish).

## The user's steps (write them into the README, verify each path you name exists)

`./serve.sh` in a terminal → `open ~/.operator/swap-check/Operator-swapcheck.app` → wait for the
update toast → **Install & Restart** → expected: the bundle dir now holds the Electron app (exec
`Operator`, ~300 MB, same bundle id), it relaunches as Electron, first frame in seconds, the
gallery shows the real projects, footer `v0.17.0-alpha.3`; note ANY Gatekeeper/TCC dialog. Point
out that it reads the real `~/.operator` (the Tauri one they run does too) — the swap must be done
with the daily Operator quit, or accept two apps on one `sessions.json` for a minute; state which
you recommend and why.

## Result file must contain

The assertion table (step → command → observed), the semver finding with citation, the final
tree of `~/.operator/swap-check/` with sizes, every command the user runs, and anything that
surprised you. If any step fails, stop there and report — do not work around signing or
notarization.
