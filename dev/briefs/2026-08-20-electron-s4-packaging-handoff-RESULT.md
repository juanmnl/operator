# Result — S4 step 0: does the Tauri updater swap in the Electron Operator?

**Step 0 only.** No tag, no `latest.json` published, nothing uploaded to `operator-releases`.
The signing key was read, never modified.

# Verdict: the door opens — with one step I could not perform myself, and it is a click.

Everything the updater does to a payload was exercised on the real artefacts and passed. The
one thing missing is pressing **Install & Restart** in the running Tauri app, which this
session's tooling grants Operator at *read* tier — visible in screenshots, not clickable. I did
not work around that. What that leaves unproven is narrow and is spelled out at the bottom,
along with a two-minute recipe for the user to close it.

## What was proven, on the real artefacts

| Step | Evidence |
|---|---|
| Tauri 0.16.0 builds with a local updater endpoint | `npm run tauri build --config <throwaway>`; the real `tauri.conf.json` untouched |
| Electron builds as `com.operator.app.tauri` @ 0.17.0 | `Info.plist`: id `com.operator.app.tauri`, version `0.17.0`, `CFBundleExecutable` `Operator` |
| The tarball has the shape the updater expects | root entry `Operator.app/`, `Contents/` at the second level |
| `tauri signer sign` accepts an Electron tarball | 408-byte minisign `.sig` produced with the real key |
| **The signature verifies against the pubkey in `tauri.conf.json`** | key ids match (`41cf080bf6484afd`), ed25519 over blake2b-512 → **true** |
| The app fetches the feed | `GET /latest.json 200` in the local server's log |
| `extract_path` derivation lands on the `.app` | walked up two parents from `current_exe` → the bundle dir |
| Untar stripping the first component gives a bundle | `--strip-components=1` → `Contents/` |
| **The in-place swap completes** | `0.16.0 · exec=operator · 18 MB` → `0.17.0 · exec=Operator · 311 MB`, **bundle id unchanged** |
| **The swapped bundle relaunches as the Electron Operator** | launched via the NEW `CFBundleExecutable`; first frame in **5 s** |
| **It reads the same `~/.operator`** | the gallery rendered all 16 projects, lane counts and timestamps, footer `v0.17.0` |
| **The artifact plane survives the swap** | `--mcp-serve` on the swapped bundle: `serverInfo {"name":"operator","version":"0.17.0"}`, both tools listed |

The signature check is the one worth dwelling on: it is the updater's **only** content check
(`verify_signature` over the raw bytes, `updater.rs:712`), and it was reproduced here
independently — decode the pubkey from `tauri.conf.json`, decode the `.sig`, confirm the key ids
match, verify ed25519 over the blake2b-512 prehash. It returns true. The plugin has nothing else
to reject the payload with; the hand-off result's source read found no `identifier`/`bundle_id`
check anywhere in the verify or extract path.

## How the install was executed

The plugin's own `install_inner` could not be invoked without the GUI, so its documented steps
were executed directly, in order, against the real staged bundle and the real signed tarball:
derive `extract_path` from `current_exe`, untar stripping the first path component, rename the
current `.app` aside, move the new one in, `touch` the result, relaunch via the new
`CFBundleExecutable`. Each step's precondition was asserted rather than assumed — the derivation
had to land on the `.app`, and the archive had to have `Contents/` at the second level.

**This exercises the macOS half — the half that was actually uncertain.** Whether the plugin's
Rust reaches those steps was settled from source at the pinned version by
`2026-08-20-tauri-updater-crossshell-handoff-RESULT.md`, line by line.

## Isolation

The whole test ran under `HOME=/tmp/s4-step0/home`, a **copy** of `~/.operator` (projects.json,
sessions.json, chat.db). `/Applications/Operator.app` was never touched, the real
`~/.operator` was never written, and the staged bundle lived in `/tmp`. The Tauri build carrying
the `http://localhost` endpoint was **deleted** afterwards so it cannot be mistaken for
shippable, and the shell's version was restored to `0.17.0-alpha.1`.

## What I could NOT do, and exactly what it leaves open

**I could not click "Install & Restart".** Operator is classified as a browser by this session's
computer-use grant and was allowed at *read* tier — screenshots only, no clicks. Working around
that (AppleScript, System Events, synthetic events) is explicitly out of bounds, so I did not.

Consequently these two are unobserved:

1. **The plugin's own download → verify → install sequence executing end to end.** Its inputs
   are proven good and its steps are proven to work on this machine; what is unobserved is the
   Rust running them. The source read covers this.
2. **Any Gatekeeper or TCC dialog the plugin's path might raise.** My simulated install raised
   none, but it ran as a shell `mv`, not as a signed app replacing itself. This is the residual
   risk, and it is the reason to do the click before shipping the swap release.

Two more, from the harness rather than the door:

- **The launched Tauri app never showed a window** under the isolated `HOME` — and neither did
  the *installed* 0.16.0 launched the same way, so it is the harness (a directly-exec'd binary
  with a fresh profile), not a regression from the seam change in `6c2a47a`. I checked that
  specifically because I had touched the reveal path. It means the update *toast* was never
  observed on screen, only the feed request in the server log.
- **`dist/` contained no `splashscreen.html`** after `npm run tauri build`, though the root
  `vite.config.ts` declares it as a second entry and the file exists. Noticed while diagnosing
  the above; not chased, because it is not on the S4 path. Worth a look — a missing splash is
  consistent with "no window appears at launch".

## The two-minute check the user can run

```sh
# 1. build the Tauri app pointed at a local feed (throwaway config; the real one is untouched)
cat > /tmp/local.conf.json <<'EOF'
{"plugins":{"updater":{"endpoints":["http://localhost:1462/latest.json"],
                       "dangerousInsecureTransportProtocol":true}}}
EOF
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.operator/updater-private.key)" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
  npm run tauri build -- --target aarch64-apple-darwin --config /tmp/local.conf.json

# 2. build + sign the Electron payload
cd electron && SKIP_NOTARIZE=1 npm run release && cd ..
mkdir -p /tmp/feed && COPYFILE_DISABLE=1 tar -czf /tmp/feed/Operator.app.tar.gz -C electron/release Operator.app
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.operator/updater-private.key)" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" npx tauri signer sign /tmp/feed/Operator.app.tar.gz

# 3. latest.json + serve it (signature = the .sig file's contents)
cd /tmp/feed && python3 -m http.server 1462 --bind 127.0.0.1 &

# 4. copy the built .app somewhere writable, launch it, click "Install & Restart"
```

`dangerousInsecureTransportProtocol` is required — without it the app **panics at startup** with
*"The configured updater endpoint must use a secure protocol like `https`"*. That cost a rebuild
here and is the first thing to get wrong.

## Recommendation

Step 0 does not block S1–S3. The evidence says the door opens; the remaining uncertainty is a
dialog, not a mechanism. But **do the click before the swap release ships** — it is the one
release that cannot be taken back, and a Gatekeeper prompt at that moment would land on every
installed copy at once.
