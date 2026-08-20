# Result — can the Tauri updater install the Electron Operator? Settled from source.

Read-only. No code changed. Settled by reading `tauri-plugin-updater` at the exact version pinned
in `src-tauri/Cargo.lock` — **`2.10.1`**, tag `updater-v2.10.1`
(`tauri-apps/plugins-workspace`, commit `d6a3898`) — plus the two crates its restart path actually
runs through, `tauri` core `2.11.2` (tag `tauri-v2.11.2`) and `tauri-plugin-process` `2.3.1` (tag
`process-v2.3.1`), both also read from source at their Cargo.lock-pinned tags. Verdict up front:
**works, with conditions** — the spike's inference was right on the core mechanism and more right
than my own prior plan's "not bridgeable." This corrects `dev/briefs/2026-08-20-electron-migration-plan-RESULT.md`'s
hand-off section.

---

## 1. macOS install path — what it actually does with the archive

**Signature check is the only content check that exists, and it's over raw bytes, not the archive
contents.** `plugins/updater/src/updater.rs:712`: `verify_signature(&buffer, &self.signature,
&self.config.pubkey)?` runs on the full downloaded byte buffer before anything is unpacked. The
function itself (`updater.rs:1453-1462`) does `minisign_verify::PublicKey::decode` +
`public_key.verify(data, &signature, true)` — a pure cryptographic check of bytes against a
signature and the pubkey from `tauri.conf.json`. **It never inspects what's inside the archive.**
I grepped `updater.rs`, `commands.rs`, `lib.rs`, `config.rs` for `identifier`/`bundle_id`/
`CFBundleIdentifier` — zero matches anywhere in the plugin. **The updater has no concept of bundle
id, Info.plist, "Tauri-ness," or executable name at verification or extraction time.**

**The macOS install (`updater.rs:1209-1311`, `impl Update` under `#[cfg(target_os = "macos")]`)**:
1. Gzip-decode + untar the verified bytes into a temp dir. For **every** entry,
   `entry.path()?.iter().skip(1).collect()` (`updater.rs:1238`) **strips the first path
   component** — so the archive's expected shape (documented at `updater.rs:1211-1216`) is
   `[AppName].app/Contents/...`, but **the `[AppName].app` folder name is discarded entirely and
   never checked against anything** — only what's under it (`Contents/...`) matters, and it must
   be a valid bundle layout at that second level.
2. `self.extract_path` — the target directory to replace — is computed once, at
   `Updater::build()` time, from `current_exe()` via `extract_path_from_executable()`
   (`updater.rs:1353-1381`): if the running executable's path contains `Contents/MacOS`, walk up
   two parents to land on the `.app` bundle directory itself (e.g. `/Applications/Operator.app`).
   **This is derived purely from where the app is currently running from — never from a bundle id
   or any config value.**
3. `updater.rs:1254-1303`: try `std::fs::rename` the current `.app` into a backup temp dir; on
   `PermissionDenied` fall back to an AppleScript `do shell script ... with administrator
   privileges` (line 1272-1295); otherwise `remove_dir_all(&self.extract_path)` then
   `std::fs::rename(tmp_extract_dir.path(), &self.extract_path)` (line 1298-1302) — **a wholesale
   directory swap.** The new `Contents/` tree lands inside the *same path and name* the old app was
   running from (e.g. still `/Applications/Operator.app`), regardless of what the extracted
   archive's original top-level folder was named.

**Does it require the archive to contain a single `.app` at the root, with what name?** One
top-level directory, name **irrelevant** (stripped), whose contents look like a standard bundle
(`Contents/Info.plist`, `Contents/MacOS/<exe>`, …). electron-builder's normal `.app` output already
has exactly this shape — `tar czf Operator.app.tar.gz Operator.app` satisfies the format
mechanically regardless of shell.

**Does it relaunch via a path that assumes the old executable name — the single biggest open
question in the brief?** **No, and this is the finding that overturns the plan's "not
bridgeable" verdict.** The bridge calls `pendingUpdate.downloadAndInstall()` then `relaunch()`
(`src/operator-bridge.ts:385-389`) — `relaunch()` is `@tauri-apps/plugin-process`'s `restart`
command, which is `app.request_restart()` in Tauri core
(`tauri-plugin-process` `commands.rs`, `pub fn restart<R: Runtime>(app: AppHandle<R>) {
app.request_restart() }`). `request_restart()` (`tauri` core `app.rs:614-625`) sets a flag and
requests app exit; once the runtime's event loop actually exits, `app.rs:1424-1428` calls
`crate::process::restart(&self.env())`. That function (`tauri` core `process.rs`) has this exact
comment: **"on macOS on updates the binary name might have changed so we'll read the
Contents/Info.plist file to determine the binary path"** — and `restart_macos_app()` does exactly
that: takes the *cached* old executable path only to walk up to `Contents/` (guarded — bails if
the path doesn't literally end `.../Contents/MacOS/<exe>`, which both Tauri's and Electron's
standard layout satisfy), then **freshly reads `Contents/Info.plist` off disk** (which by restart
time is the *new*, swapped-in Info.plist), pulls `CFBundleExecutable`, and execs
`Contents/MacOS/<that name>`. **This is deliberately designed to survive a binary-name change
across an update — it was built for exactly the scenario in question, whether or not that was the
original author's intent.** As long as the Electron `.app`'s own `Info.plist` correctly declares
its own `CFBundleExecutable` (which electron-builder always sets, normal packaging, nothing
special needed), relaunch finds and launches the new Electron binary correctly, no matter what it's
named.

## 2. Our config

- `src-tauri/tauri.conf.json:49-54`: `plugins.updater.endpoints` =
  `["https://github.com/juanmnl/operator-releases/releases/latest/download/latest.json"]`,
  `pubkey` = the base64 minisign public key blob (unchanged from prior research, not re-quoted
  here since it's not secret but no need to repeat it).
- `bundle.createUpdaterArtifacts: true` (`tauri.conf.json:59`) — this is what makes
  `tauri-action`/`tauri build` emit the `.app.tar.gz` + `.sig` pair matching the exact format
  `install_inner` expects, automatically, as part of the normal build in `.github/workflows/build.yml`.
- **Live `latest.json`** fetched from `https://github.com/juanmnl/operator-releases/releases/latest/download/latest.json`
  today: `{"version":"0.16.0","notes":"Operator 0.16.0","pub_date":"2026-08-16T15:37:08Z",
  "platforms":{"darwin-aarch64":{"signature":"...","url":"https://github.com/juanmnl/operator-releases/releases/download/v0.16.0/Operator.app.tar.gz"}}}`
  — confirms the live shape matches exactly what `RemoteRelease`'s deserializer expects
  (`updater.rs:1383-1414`: `version`, optional `notes`/`pub_date`, `platforms` map keyed
  `darwin-aarch64` etc. with `signature`+`url`) — nothing in this schema is Tauri-specific either;
  it's a plain JSON envelope around a signed URL.

## 3. Electron side — can we swap it in?

**(a) Tar it as `Operator.app.tar.gz`**: yes, mechanically — confirmed by the format analysis
above. electron-builder's `.app` output is a standard bundle; a plain `tar czf` of it satisfies the
single-top-level-dir requirement.

**(b) Sign that tar with the existing minisign key**: the verification side
(`verify_signature`, `updater.rs:1453`) is payload-format-agnostic — it's a raw minisign check over
arbitrary bytes, so there's no reason the *signing* side (the `tauri-cli` `signer sign` subcommand,
which I did not fetch source for in this pass — it's a separate crate from what the brief asked me
to settle, flagging this as the one inference in this report rather than a direct read) would
reject non-Tauri-produced bytes either; minisign as a primitive signs whatever bytes you hand it.
**Recommend confirming `tauri signer sign --help` doesn't add a Tauri-specific precondition before
relying on this, but nothing in the verification code suggests one exists.**

**(c) Publish a `latest.json` pointing at it**: yes — shown above, the schema carries no
shell-specific field.

**Bundle id — does the updater care?** No, confirmed by the zero-hits grep in §1: nothing in the
verify/extract path reads `CFBundleIdentifier`. **Does macOS (LaunchServices/Gatekeeper/TCC) care,
independent of the plugin?** This is genuinely outside what source-reading can settle — it's closed
OS behavior, not open-source plugin code — so treat the following as informed inference, not a
citation:
- **LaunchServices**: `install_inner` ends with `touch` on the extract path
  (`updater.rs:1305-1307`), which nudges LS to notice the directory changed; LS re-registering a
  changed bundle id at a stable path is an ordinary event (every app that ever changed its bundle
  id across a version did this) — low risk, not a known hard failure.
- **TCC**: real risk, not zero. TCC's identity model leans on a combination of bundle id and
  code-signing identity; changing `CFBundleIdentifier` while keeping the same Developer ID
  (`Juan Cornejo (UJS4C5GUCW)`, unchanged either way per the migration plan) is the *least*
  disruptive version of an id change, but there's a real chance any TCC grant tied to
  `com.operator.app.tauri` (folder access, etc. — see memory `project_tcc_prompt_second_source.md`
  for Operator's existing TCC-prompt history) doesn't carry to `com.operator.app` automatically.
  **Recommend testing this specifically, and see the recipe below for a mitigation that sidesteps
  it entirely for the risky first swap.**
- **Gatekeeper**: the swap is done by a currently-running process via `std::fs::rename`/AppleScript,
  not a Finder-initiated download-and-open — the `com.apple.quarantine` xattr that triggers
  Gatekeeper's full "are you sure" UI is typically set by browsers/Finder on downloaded files, not
  by a program extracting bytes it fetched itself. The subsequent `Command::new(...).spawn()`
  relaunch runs the new binary the way Terminal would, not the way Finder double-click does — as
  long as the Electron `.app` is validly signed (Developer ID, hardened runtime) and notarized the
  same way the Tauri build already is, code-signing enforcement at `execve` succeeds independent of
  quarantine state. Low risk, but worth confirming empirically since Gatekeeper's quarantine
  inheritance across `tar`/`rename` operations isn't something I can verify from plugin source.

## 4. After the swap — electron-updater's first-run needs

`electron-updater`'s config (the `publish` block, baked into the packaged app at
`Contents/Resources/app-update.yml` by electron-builder at build time) is self-contained — it needs
nothing from the swap itself, no runtime step, no leftover Tauri state. For macOS specifically,
electron-updater/Squirrel.Mac expects a **`latest-mac.yml`** feed file (distinct name from
Windows' `latest.yml` and Linux's `latest-linux.yml` — confirmed via electron-builder's own docs
and issue tracker, not primary plugin source, flagged accordingly) generated alongside the
`.zip` target — **note: Squirrel.Mac's auto-update needs a `.zip` build target, not just `.dmg`**,
so S4's electron-builder config must produce both. `latest-mac.yml` and Tauri's `latest.json` are
different filenames — **no collision** publishing both into the same GitHub release. So: as long
as S4's electron-builder config is wired to publish `latest-mac.yml` (+ its `.zip`) into
`juanmnl/operator-releases` on tag, the very first Electron build already carries everything
`electron-updater` needs for its *next* update — nothing extra to stage during the crossshell swap
release itself beyond making sure that release also contains `latest-mac.yml`.

## 5. Verdict and recipe

**Verdict: works, with conditions.** The core swap-and-relaunch mechanism has no cross-shell
awareness to defeat — it's bytes-in, signature-check, blind-directory-swap, then a
name-agnostic relaunch specifically engineered to survive exactly this kind of change. This
directly contradicts my own prior plan's "not bridgeable" conclusion, which was written without
reading `install_inner`/`restart_macos_app` from source — that plan's caution was reasonable given
what was known then, but the plugin source settles it more favorably than assumed.

**Conditions, all addressed in the recipe below:**
1. The signed tar must be a single top-level `.app`-shaped directory (any name) containing a valid
   `Contents/` bundle layout — mechanical, satisfied by `tar czf` over electron-builder's normal
   output.
2. Electron's own `Info.plist` must correctly declare `CFBundleExecutable` — automatic, normal
   electron-builder packaging.
3. **Recommend NOT changing the bundle identifier in the same release as the shell swap.** Ship
   this first crossshell release with `CFBundleIdentifier` still `com.operator.app.tauri` (i.e.
   the Electron build's Info.plist keeps the OLD id for this one release only), deferring the
   rename to `com.operator.app` to a later, ordinary Electron-to-Electron update once the fleet is
   already fully switched and can absorb a smaller, isolated TCC/LaunchServices risk in isolation.
   This is my own recommendation on top of the source findings, not something the source dictates
   — it decouples two risky changes (shell + identity) that don't need to happen atomically, given
   §3's TCC uncertainty.
4. S4's electron-builder config must emit a `.zip` target (for Squirrel.Mac / `latest-mac.yml`)
   alongside the `.dmg`, and publish `latest-mac.yml` into the same `juanmnl/operator-releases`
   release used for the swap.

**Exact release recipe** (assuming condition 3's identifier-hold recommendation):
1. Build the Electron `.app` via electron-builder, `CFBundleIdentifier` = `com.operator.app.tauri`
   (unchanged), signed with the same Developer ID (`Juan Cornejo (UJS4C5GUCW)`) and notarized with
   the same App Store Connect API key already in `.github/workflows/build.yml`'s secrets — no new
   Apple-side setup, per the migration plan.
2. `tar czf Operator.app.tar.gz Operator.app` (or whatever build step produces the equivalent
   layout) — verify it untars to a single top-level `Operator.app/Contents/...` tree.
3. Sign `Operator.app.tar.gz` with `~/.operator/updater-private.key` (never regenerate — breaks
   every installed user's trust root) via the same signing tool the current CI pipeline already
   uses (`TAURI_SIGNING_PRIVATE_KEY` path in `tauri-action`, or its underlying `tauri signer sign`
   equivalent).
4. Publish a `latest.json` with `version` strictly greater than `0.16.0`, `platforms.darwin-aarch64`
   pointing the new `url`+`signature` at the signed Electron tar — same schema as the live one
   fetched above, no field changes needed.
5. Also publish `latest-mac.yml` (+ the `.zip` electron-builder produced) into the same
   `juanmnl/operator-releases` release/tag, so `electron-updater` is ready for the *next* update
   the moment users land on Electron.
6. Ship it. Installed Tauri users' existing updater (already polling this exact endpoint) picks up
   the new version, downloads, verifies, swaps `/Applications/Operator.app`'s `Contents/` for the
   Electron one, calls `relaunch()`, and — per §1 — the relaunch logic reads the new `Info.plist`
   and correctly launches the Electron binary regardless of its name.
7. **Only after this release has been live and confirmed stable across a real population**,
   consider a follow-up, Electron-updater-delivered release that changes `CFBundleIdentifier` to
   `com.operator.app` in isolation — a much lower-stakes moment to absorb any TCC re-consent
   friction, since by then it's an ordinary same-shell update.

This *replaces* the migration plan's earlier recommendation of a placeholder "download the new
Operator" notice release — that fallback is no longer the primary path, but keep it as the
**documented fallback** if the throwaway test below finds a real blocker (e.g. TCC fully breaking
folder-access grants in a way that's unacceptable, or the AppleScript admin-privileges path
misbehaving in some environment).

## Throwaway test — recommended, not run here

**What it would look like**: build a minimal signed Tauri app (or reuse a disposable local build of
Operator itself) pointed at a `plugins.updater.endpoints` entry serving a **local** `latest.json`
(e.g. via a `python -m http.server` or similar, pointing `file://`/`http://localhost` at a
hand-built payload) whose payload is a **dummy `.app.tar.gz`** — doesn't need to be real Electron,
just needs a different `CFBundleExecutable`/`Info.plist` than the original, to specifically probe
the relaunch-with-changed-binary-name path in isolation from every other variable. Verify: (1) the
swap completes, (2) `relaunch()` launches the NEW dummy binary and not a crash/no-op, (3) repeat
with a *changed* `CFBundleIdentifier` in the dummy's Info.plist and check whether any TCC-gated
capability the real app depends on survives — this last part needs the real app's actual TCC
grants to be meaningful, so it's best done with an actual disposable Operator-identity build, not
a bare-bones dummy.

**Do not run this myself.** It requires signing the test payload with
`~/.operator/updater-private.key` to produce a signature the updater's `pubkey` will accept — per
this session's standing instruction, that key is never to be touched/regenerated, and producing a
real signed release artifact is a build/release action outside this lane's read-only research
charter regardless. Recommend Code or the user runs this test directly, using the recipe above as
the shape of what to build.
