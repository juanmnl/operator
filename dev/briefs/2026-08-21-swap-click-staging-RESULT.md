# Result — S4 step 1: the one-way-swap click check, staged against the notarized alpha.3

**Everything is staged in `~/.operator/swap-check/`. The only thing left is the click.**

Nothing was published. No GUI app was opened. No server is running. `/Applications`, the real
`src-tauri/tauri.conf.json`, and every pre-existing file in `~/.operator` are untouched —
`git status` is clean and `~/.operator/swap-check/` is the only thing that was created. The
signing key was read once, never written, never copied, never printed.

**What this closes that S4 step 0 could not:** step 0 ran on a `SKIP_NOTARIZE=1` build, so
Gatekeeper was never in the picture. This stages the **real, notarized, stapled**
`electron-v0.17.0-alpha.3` payload, and proves the tarball round-trip preserves the notarization
— which is the property the click actually tests.

---

## Assertion table

| # | Step | Command | Observed |
|---|---|---|---|
| 1 | download | `gh release download electron-v0.17.0-alpha.3 -R juanmnl/operator -p '*.zip' -p 'SHA256SUMS.txt'` | 135,765,485 B zip + SHA256SUMS.txt |
| 1 | zip integrity | `shasum -a 256 -c` against `SHA256SUMS.txt` | `Operator-0.17.0-alpha.3-arm64-mac.zip: OK` (`64346ce9…53102`) |
| 1 | unpack | `ditto -x -k <zip> payload` | `payload/Operator.app`, 312 MB |
| 1 | codesign | `codesign --verify --deep --strict --verbose=2` | `valid on disk` · `satisfies its Designated Requirement` · exit 0 |
| 1 | Gatekeeper | `spctl -a -vv -t exec` | `accepted` · `source=Notarized Developer ID` · `origin=Developer ID Application: Juan Cornejo (UJS4C5GUCW)` |
| 1 | stapled ticket | `xcrun stapler validate` | `The validate action worked!` exit 0 |
| 1 | Info.plist | `defaults read` | id `com.operator.app.tauri` · exec `Operator` · short version `0.17.0-alpha.3` · build `0.17.0-alpha.3` |
| 2 | tarball | `COPYFILE_DISABLE=1 tar -czf feed/Operator.app.tar.gz -C payload Operator.app` | 135,693,120 B |
| 2 | tarball shape | `tar -tzf … \| head` | `Operator.app/` then `Operator.app/Contents/` — root entry and second level as the updater requires |
| 2 | sign | `tauri signer sign` (key from `~/.operator/updater-private.key`, empty password) | 408-byte minisign `.sig`, single line, no trailing newline |
| 2 | **signature verified independently** | own script: decode pubkey from `tauri.conf.json`, decode `.sig`, compare key ids, ed25519 over blake2b-512 prehash | pubkey alg `Ed` · sig alg `ED` · both key ids `41cf080bf6484afd` · **`ed25519 verify = true`** over 135,693,120 bytes |
| 2 | test-extract | `tar -xzf … --strip-components=1` into a fresh `Operator.app` | second level is `Contents` — correct |
| 2 | **re-assembled bundle still notarized** | `codesign --verify --deep --strict` · `spctl -a -vv -t exec` · `xcrun stapler validate` | exit 0 · `accepted / Notarized Developer ID` · `The validate action worked!` — **the tarball round-trip preserves the stapled ticket** |
| 3 | `latest.json` | written, then re-parsed | version `0.17.0-alpha.3` · `pub_date` `2026-08-21T05:49:37Z` · platform key `darwin-aarch64` · 408-char signature · url `http://127.0.0.1:1462/Operator.app.tar.gz` |
| 3 | semver | see below | `0.17.0-alpha.3 > 0.16.0` = **true**; `"0.17.0-alpha.3"` kept in `latest.json` |
| 4 | build | `npm run tauri build -- --target aarch64-apple-darwin --bundles app --config ~/.operator/swap-check/local-endpoint.conf.json` | `Finished release profile in 1m 20s`, bundled, exit 0 |
| 4 | endpoint baked in | `strings Contents/MacOS/operator \| grep` | `http://127.0.0.1:1462/latest.json` present; `dangerousInsecureTransportProtocol` ×3 |
| 4 | repo untouched | `git status --porcelain` · `git diff --stat src-tauri/tauri.conf.json` | both empty |
| 4 | copy + verify | `ditto` → `~/.operator/swap-check/Operator-swapcheck.app`, then `codesign --verify --deep --strict` | `valid on disk` · `satisfies its Designated Requirement` exit 0 |
| 4 | its signing status | `codesign -dvv` · `spctl -a -vv -t exec` | `Developer ID Application: Juan Cornejo (UJS4C5GUCW)` → `Developer ID CA` → `Apple Root CA`, timestamped. **NOT adhoc — real Developer ID, not notarized.** `spctl`: `rejected / Unnotarized Developer ID` (expected; no quarantine flag, so `open` works) |
| 5 | feed serves | `serve.sh` + `curl -I` | `HEAD /latest.json` → `200`, `Content-Length: 637`; `HEAD /Operator.app.tar.gz` → `200`, `Content-Length: 135693120` |
| 5 | nothing left running | `pgrep -fl 'http\.server'` · `lsof -nP -iTCP:1462` | no process · nothing bound to 1462 |

---

## The semver finding

**`0.17.0-alpha.3` is newer than `0.16.0`. No substitution needed.**

The gate is one line:

```rust
// tauri-plugin-updater-2.10.1/src/updater.rs:530-533
let should_update = match self.version_comparator.as_ref() {
    Some(comparator) => comparator(self.current_version.clone(), release.clone()),
    None => release.version > self.current_version,
};
```

`Operator` sets no `version_comparator`, so it is the `None` arm: `semver::Version` ordering
(`updater.rs:27`, `use semver::Version`), pinned to `semver 1.0.28` in `src-tauri/Cargo.lock`. A
pre-release only loses precedence **within the same** `major.minor.patch`; `0.17.0-alpha.3` and
`0.16.0` differ at the minor, so the pre-release tag never enters the comparison. Verified by
running the pinned crate rather than reasoning about it:

```
release 0.17.0-alpha.3   > current 0.16.0  =>  true
release 0.17.0           > current 0.16.0  =>  true
release 0.16.0-alpha.3   > current 0.16.0  =>  false   (sanity: prerelease does lose within a version)
```

Two more things the same read settled:

- **The platform key `darwin-aarch64` is correct**, but it is the *fallback*. `get_urls`
  (`updater.rs:568-598`) searches `["darwin-aarch64-app", "darwin-aarch64"]` in that order — the
  bundle-type-suffixed key first. A feed with only `darwin-aarch64` hits the second entry and
  works. Anyone reading the plugin's debug log will see it miss `darwin-aarch64-app` first; that
  is not an error.
- **`pub_date` is strictly RFC3339 or the whole feed fails to deserialize** —
  `OffsetDateTime::parse(…, Rfc3339)` at `updater.rs:1404`, mapped to a serde error. It is not an
  optional nicety once present. Ours parses.

---

## What surprised me

**1. Tauri already solves the cross-shell relaunch, on purpose.** This was the thing I expected to
break. `installUpdate()` in `operator-bridge.ts:393` does `downloadAndInstall()` then
`relaunch()`, and after the swap the current executable — `Contents/MacOS/operator` — no longer
exists, because the Electron bundle's is `Contents/MacOS/Operator`. Upstream anticipated exactly
this:

```rust
// tauri-2.11.2/src/process.rs:78-81
// on macOS on updates the binary name might have changed
// so we'll read the Contents/Info.plist file to determine the binary path
#[cfg(target_os = "macos")]
restart_macos_app(&path, env);
```

`restart_macos_app` (`process.rs:92-129`) re-reads the **new** `Info.plist`, takes
`CFBundleExecutable`, and spawns `Contents/MacOS/<that>`. So S4's manual relaunch was not a
workaround for a gap — it was the same thing the plugin does. The cross-shell rename is a
supported case, not luck.

The catch: it `Command::new(…).spawn()`s the binary **directly**, not via `open`. The relaunched
Electron app is a child of the dying Tauri process and never goes through LaunchServices. Whether
it activates and appears in the Dock correctly that way is the one behaviour I could not exercise
— it is in the README as the thing to watch.

**2. The app you run daily is not in `/Applications`.** `ps` says the live Operator (pid 53169,
parent of every lane including mine) is
`~/Developer/operator/src-tauri/target/release/bundle/macos/Operator.app` — v0.16.0, bundle id
`com.operator.app.tauri`. **Same bundle id as the swap-check app.** That changes the advice below
from a nicety to a precondition, and it means the brief's "the Tauri one they run" is a dev build
from the main checkout, not an installed copy.

**3. The build kept a runnable copy of the localhost-endpoint app in three places.** `--config`
bakes the endpoint into the binary, and `npm run tauri build` left it in
`target/…/release/bundle/macos/Operator.app`, `target/…/release/operator`, **and**
`target/…/release/deps/operator-96406d632b0b2082`. S4 deleted its bundle; the `deps/` copy is the
one that is easy to miss. All three are gone — I re-scanned every executable under `src-tauri/target`
with `strings` and none mentions `127.0.0.1:1462`. The only runnable copy left on the machine is
`~/.operator/swap-check/Operator-swapcheck.app`, which is renamed so it cannot be confused for a
shippable bundle.

**4. The update toast does not auto-dismiss.** `Toast.tsx:244` —
`message.action ? undefined : setTimeout(beginExit, AUTO_DISMISS_MS)`. Toasts with an action stay
until acted on. Worth knowing before a check whose whole point is one button.

---

## Quit the daily Operator first — my recommendation, and why

**Quit it.** Do not accept two apps on one `sessions.json`.

The reason is not tidiness, it is silent data loss. `save_sessions` (`src-tauri/src/lib.rs:1454`)
writes the frontend's **entire** in-memory session list with a temp+rename, no lock and no merge:

```rust
let tmp = path.with_extension("json.tmp");
if std::fs::write(&tmp, s).is_ok() {
    let _ = std::fs::rename(&tmp, &path); // atomic swap
}
```

Each write is atomic, but the *content* is a whole-file snapshot from one app's memory. Two
Operators means the second to write erases the first's lanes, with no conflict and no error. Both
also use the same `sessions.json.tmp` path, so the temp file itself can interleave.

Secondary, but it will waste your time first: same bundle id means `open` may activate the running
instance instead of launching the swap-check bundle, and you will wait for a toast that never
arrives. The README uses `open -n` to force a new instance, but with the daily app quit you do not
have to trust that.

**The cost is real and should be said plainly: quitting Operator ends every lane** — they are its
child processes. Run this when the fleet is idle.

---

## The tree

```
~/.operator/swap-check/                        276 MB total
├── README.md                                          the user's steps + teardown
├── serve.sh                                           cd feed && python3 -m http.server 1462 --bind 127.0.0.1
├── local-endpoint.conf.json                           the --config the throwaway app was built with
├── Operator-swapcheck.app                    17 MB    Tauri 0.16.0, Developer ID signed, unnotarized,
│                                                      endpoint http://127.0.0.1:1462/latest.json
├── dl/                                      129 MB
│   ├── Operator-0.17.0-alpha.3-arm64-mac.zip 129 MB   as downloaded, SHA256 verified
│   └── SHA256SUMS.txt
└── feed/                                    129 MB
    ├── latest.json                                    0.17.0-alpha.3 · darwin-aarch64 · loopback url
    ├── Operator.app.tar.gz                  129 MB    the notarized Electron app, updater-shaped
    └── Operator.app.tar.gz.sig                        408 B minisign, verified against tauri.conf.json
```

`payload/` (the unpacked `.app`) and `testextract/` (the round-trip check) were deleted after they
had served their purpose — 624 MB of duplicate bundle in `~/.operator` is not worth keeping, and
both are one `ditto -x -k dl/*.zip <dir>` away if wanted.

---

## Every command the user runs

```sh
# 0. quit the running Operator (this ends every lane — do it when the fleet is idle)

# 1. serve the feed (foreground; leave it up)
~/.operator/swap-check/serve.sh

# 2. launch the throwaway Tauri 0.16.0 (second terminal)
open -n ~/.operator/swap-check/Operator-swapcheck.app

# 3. wait for "Update 0.17.0-alpha.3 available" → click Install & Restart
#    the server terminal should show GET /latest.json 200, then GET /Operator.app.tar.gz 200

# 4. confirm the swap
du -sm ~/.operator/swap-check/Operator-swapcheck.app                                        # ~300 MB
defaults read ~/.operator/swap-check/Operator-swapcheck.app/Contents/Info.plist CFBundleExecutable        # Operator
defaults read ~/.operator/swap-check/Operator-swapcheck.app/Contents/Info.plist CFBundleShortVersionString # 0.17.0-alpha.3
defaults read ~/.operator/swap-check/Operator-swapcheck.app/Contents/Info.plist CFBundleIdentifier         # com.operator.app.tauri

# 5. teardown: Ctrl-C the server, then
rm -rf ~/.operator/swap-check
```

**Note any dialog macOS shows** — Gatekeeper, TCC (Files and Folders / Automation / Accessibility),
or an admin password prompt. That is the whole point of the exercise; the mechanism is already
proven. The updater does have an admin-privileges fallback
(`tauri-plugin-updater-2.10.1/src/updater.rs:1273`, AppleScript `with administrator privileges`)
for when it cannot rename the bundle — it should not need it for a bundle in your home directory,
so if it asks, that is a finding.

---

## What remains unproven after this

Only what needs a human at the keyboard:

1. **The click itself** — the plugin's download → verify → install → relaunch running as the
   signed app replacing itself, rather than as a shell doing the same steps.
2. **Any Gatekeeper or TCC dialog** raised on that path. The payload is notarized and stapled and
   survives the tarball round-trip, which is the strongest pre-check available without pressing
   the button.
3. **Whether the relaunched Electron app activates properly** when spawned directly rather than
   through LaunchServices (see "What surprised me", item 1).

---

## One housekeeping note

This lane's worktree is itself under `~/.operator` (`~/.operator/worktrees/operator-8ad620`), so
`npm ci` and the Rust build put `node_modules` and a **1.5 GB `src-tauri/target/`** there. That is
my own checkout, not the durable state the brief was protecting — `sessions.json`, `projects.json`,
`chat.db`, the keys and everything else in `~/.operator` proper are byte-for-byte untouched. But
1.5 GB of Cargo `target/` is exactly the reap offender
`project_worktree_reap_current_state` describes, and it can be deleted the moment this branch is
merged.
