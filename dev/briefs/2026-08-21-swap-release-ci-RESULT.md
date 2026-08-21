# Result — the one-way swap release is now a CI act

**No tag pushed. Nothing published. `juanmnl/operator-releases` untouched. No GUI launched.**
The signing key was never printed, copied or regenerated — CI already holds it as
`TAURI_SIGNING_PRIVATE_KEY`, and the only local use was `tauri signer sign` in a rehearsal, the
same way `build.yml` uses it.

Pushing `electron-v0.17.0` now does the whole thing. Pushing `electron-v0.17.0-rc.1` first does
all of it except the publish, from the same code path, with byte-identical artefacts.

## What changed

| File | Change |
|---|---|
| `.github/workflows/electron.yml` | swap assets built on every tag; a `gate` step; publish to operator-releases only on a stable tag; notes vary by tag |
| `scripts/verify-updater-signature.mjs` | **new** — independent minisign verification of the payload against `tauri.conf.json`'s pubkey |
| `electron/src/main/updater.ts` | packaged default feed + `resolveFeedUrl` as a pure, tested decision |
| `electron/src/main/updater.test.ts` | the three cases the brief asks for, plus the empty-env case |
| `electron/package.json`, `package-lock.json` | `0.17.0-alpha.3` → `0.17.0` |

Root `package.json` and `src-tauri/` stay at `0.16.0`, untouched — Tauri is frozen.

## Walking the stable-tag branch by hand

| Step | `electron-v0.17.0-rc.1` | `electron-v0.17.0` | Why |
|---|---|---|---|
| `test` job (root build, root tests, shell typecheck + tests) | runs | runs | same bar as `build.yml`; a preview that ships what the tests catch is a liability |
| Install deps, native rebuild, cert import, notarization key | runs | runs | unchanged |
| `npm run release` (build → sign → assert `--mcp-serve` → notarize → staple → DMG/zip/yml) | runs | runs | unchanged |
| **`gate`** | `stable=false`, logs `swap feed: dry run (prerelease)` | `stable=true`, logs `swap feed: PUBLISH` | one regex on the tag, and it is the only place the door is decided |
| **Build swap payload** (ditto → tar → shape assert → sign → **verify sig** → staple/spctl on the extracted copy → `latest.json` → SHA256SUMS) | runs | runs | so the dry run produces exactly what the stable tag would publish |
| Release notes | "Electron preview…", "Auto-update is NOT wired for this build" | "the swap release…", "publishes BOTH feeds… one-way door" | `steps.gate.outputs.stable` |
| Release on `juanmnl/operator` | `--prerelease`, title `(Electron preview)` | no `--prerelease`, title `(Electron)` | a stable release marked prerelease is incoherent |
| — its assets | DMG, zip, **tar.gz, .sig, latest.json**, latest-mac.yml, SHA256SUMS | same | the dry run is inspectable, and its assets can drive the local install check |
| **Publish to operator-releases** | **skipped** (`if: steps.gate.outputs.stable == 'true'`) | `gh release create v0.17.0 --latest` with DMG, tar.gz, latest.json, zip, latest-mac.yml, SHA256SUMS | THE DOOR |
| "Swap feed NOT published (dry run)" | runs, logs it | skipped | silence is not evidence; the dry run says so out loud, in the log and the step summary |

Both feeds land on the **same** operator-releases release, in the same minute, on purpose: a copy
that crosses over stops asking for `latest.json` and starts asking for `latest-mac.yml` at
`releases/latest/download/`. If that file were not already there, the app would report a broken
feed on its first launch after the update it just installed.

## The URL shape, confirmed against the live repo (nothing published to check it)

`src-tauri/tauri.conf.json`'s endpoint is
`https://github.com/juanmnl/operator-releases/releases/latest/download/latest.json`. Probed today
against the existing `v0.16.0` release:

```
GET .../releases/latest/download/latest.json?noCache=abc123
  → 302 https://github.com/juanmnl/operator-releases/releases/download/v0.16.0/latest.json
  → 200 {"version":"0.16.0", ...}
GET .../releases/download/v0.16.0/latest.json
  → 302 release-assets.githubusercontent.com/...
```

So `releases/latest/download/<name>` resolves to whichever release is marked **Latest**, and the
`?noCache=` query electron-updater appends is ignored by the redirect. Creating the release with
`--latest` is therefore the act that opens the door — there is no second switch. The same shape
serves the Electron feed: `releases/latest/download/latest-mac.yml` and the `.zip` beside it.

`gh release view v0.16.0 -R juanmnl/operator-releases` shows what is there today: `latest.json`,
`Operator.app.tar.gz`, `Operator_0.16.0_aarch64.dmg` — and **no** `latest-mac.yml` and no `.zip`,
which is exactly why the Electron updater has been inert. The swap release adds both.

## generic vs github, from the electron-updater source

**Chosen: `provider: 'generic'`, url `https://github.com/juanmnl/operator-releases/releases/latest/download`.**

- **Generic makes ONE metadata request.** `GenericProvider.getLatestVersion` fetches
  `<url>/latest-mac.yml` (`GenericProvider.js:18-23`); the `-mac` suffix comes from
  `Provider.getChannelFilePrefix` (`Provider.js:30-38`), and the `.zip` resolves against the same
  base (`GenericProvider.js:46-48` → `Provider.resolveFiles`, `Provider.js:124-134`). Both URLs
  are `releases/latest/download/<name>` — the shape proven above.
- **GitHub makes THREE, and one is undocumented.** `GitHubProvider.getLatestVersion` fetches
  `releases.atom` (`GitHubProvider.js:43`), then — with `allowPrerelease` false, the default —
  `getLatestTagName` does `GET /<owner>/<repo>/releases/latest` with `Accept: application/json`
  (`GitHubProvider.js:158-171`), and only then the `latest-mac.yml` under the resolved tag
  (`GitHubProvider.js:116-118`, `getBaseDownloadPath` at `:183-185`).

  I probed that middle request rather than assuming: it is a **302 to the tag page**, and the JSON
  only arrives because the `Accept` header survives the hop —
  `HttpExecutor.prepareRedirectUrlOptions` keeps headers on a same-origin redirect and strips only
  sensitive ones (`builder-util-runtime/out/httpExecutor.js:286-305`). It works today. It is an
  HTML route that answers JSON for one header, and GitHub never promised it.

**What GitHub would buy** is a tag-pinned download, so a release published mid-check cannot be
raced. Generic's window is closed differently: `resolveFiles` refuses any file entry without a
`sha512`/`sha256` (`Provider.js:127-129`), so a mismatch fails verification rather than installing
the wrong build. One request against a URL shape already in production beats three against a route
that is not part of any contract — and `generic` is already the code path the
`OPERATOR_UPDATE_FEED` override uses, so there is one provider to keep working, not two.

The env override still wins, and an **unpackaged** build stays inert: `npm run dev` carries the
same version as whatever is published, so a default feed that applied there would offer every
developer an update to the build they are sitting on.

## The semver rule the swap relies on

`latest.json` will say `0.17.0`; installed copies say `0.16.0`. The gate is one line:

```rust
// tauri-plugin-updater-2.10.1/src/updater.rs:530-533
let should_update = match self.version_comparator.as_ref() {
    Some(comparator) => comparator(self.current_version.clone(), release.clone()),
    None => release.version > self.current_version,
};
```

Operator sets no `version_comparator`, so it is plain `semver::Version` ordering (`updater.rs:27`,
`semver 1.0.28` per `src-tauri/Cargo.lock`) — `0.17.0 > 0.16.0`. Two related facts from the same
read, both now enforced by the workflow: the platform key is `darwin-aarch64` (`get_urls` searches
`["darwin-aarch64-app", "darwin-aarch64"]`, `updater.rs:568-598` — ours is the fallback and that is
fine), and `pub_date` must be strict RFC3339 or the **whole feed** fails to deserialize
(`updater.rs:1404`). The workflow's `date -u +%Y-%m-%dT%H:%M:%SZ` satisfies it.

## One thing in the brief that is not true, and what I did about it

**The Tauri toast does not show `latest.json.notes`. Nothing in the installed 0.16.0 app does.**
`operator-bridge.ts:387-392` returns `{ version }` and nothing else; the toast is built from that
alone (`DashboardView.tsx:3238-3241`, text `Update <v> available`, detail a fixed string), and
Preferences → Updates shows only the version too. So the release notes reach the user through the
**operator-releases release body** and the GitHub release page — not through the update prompt.

I wrote them anyway and wired them to both places (`notes` in `latest.json`, `--notes-file` on the
operator-releases release), because the field costs nothing and is where anyone reading the feed
looks. But nobody should expect the swap prompt to explain itself: **the user gets "Update 0.17.0
available / Install and restart Operator" and no warning that it is one-way.** If that matters —
and for the release that cannot be taken back, it might — the place to fix it is the 0.16.0 app,
which is frozen and already installed. It cannot be fixed from this release.

## The dry run, and how to point the local install check at CI's assets

```sh
# 1. rehearse: builds everything, publishes nothing
git tag electron-v0.17.0-rc.1
git push origin electron-v0.17.0-rc.1
```

That produces a pre-release on `juanmnl/operator` carrying `Operator.app.tar.gz`, its `.sig` and
`latest.json`, with the workflow log reading `swap feed: dry run (prerelease)`. operator-releases
is untouched.

Then, to run check #4 (`2026-08-21-swap-click-staging`) against **CI's** payload rather than the
locally-built one — two commands:

```sh
gh release download electron-v0.17.0-rc.1 -R juanmnl/operator \
  -p 'Operator.app.tar.gz' -p 'Operator.app.tar.gz.sig' -p 'latest.json' \
  -D ~/.operator/swap-check/feed --clobber

node -e 'const fs=require("fs"),p=require("os").homedir()+"/.operator/swap-check/feed/latest.json";
  const j=JSON.parse(fs.readFileSync(p,"utf8"));
  j.platforms["darwin-aarch64"].url="http://127.0.0.1:1462/Operator.app.tar.gz";
  fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n");
  console.log("feed now serves",j.version,"from",j.platforms["darwin-aarch64"].url)'
```

The second is only rewriting the url — CI's `latest.json` points at operator-releases, and the
local server does not. Version and signature come straight from CI. `0.17.0 > 0.16.0`, so
`Operator-swapcheck.app` will offer it. Then `serve.sh`, `open -n`, **Install & Restart**.

**When the check passes, the release is one command:** `git tag electron-v0.17.0 && git push
origin electron-v0.17.0`.

## Verification

| What | Result |
|---|---|
| Workflow YAML parses | `js-yaml`: 2 jobs, 7 + 14 steps, ids and `if:` as intended |
| Every `run:` block, `bash -n` | 17/17 parse |
| `gate` executed against every tag shape | `electron-v0.17.0` → PUBLISH; `-rc.1` / `-alpha.4` / `-beta` / `main` → dry run; `electron-v0.18.0` → exit 1 (tag/package mismatch); stable tag with a prerelease `package.json` → exit 1 |
| **Swap-payload step rehearsed end to end** | extracted verbatim from the YAML and run against the real notarized alpha.3 `.app`: ditto → codesign ok → tar (root entry `Operator.app/`) → `tauri signer sign` → **`ed25519 VERIFIED`, key id `41cf080bf6484afd`** → extracted copy `stapler validate` + `spctl accepted / Notarized Developer ID` → `latest.json` (`0.17.0`, RFC3339 `pub_date`, 408-char signature) → SHA256SUMS appended |
| `verify-updater-signature.mjs`, negative cases | truncated payload → `ed25519 FAILED`, exit 1; flipped pubkey byte → `key id mismatch`, exit 1 |
| Both release-note variants rendered | stable: "the swap release" + "publishes BOTH feeds… one-way door"; prerelease: "Electron preview" + "Auto-update is NOT wired" |
| Root `tsc --noEmit` | clean |
| Root `npm run build` | built |
| Root `npm test` | **61 files / 786 tests pass** — see the Node note below |
| `electron` `npm run typecheck` | clean |
| `electron` `npm test` | 13 files / 195 tests pass |

**The Node note, because a bare `npm test` here looks broken.** On this machine's Node v26.7.0 the
root suite reports 33 failures across 5 files, all `Cannot read properties of undefined (reading
'clear')`. Node 26 defines `localStorage` on `globalThis` as an accessor that returns `undefined`
without `--localstorage-file`, and it shadows the one vitest's jsdom environment provides. With
`NODE_OPTIONS=--localstorage-file=<fresh file>` the same suite is **786/786, exit 0**. The affected
test files are byte-identical to `ef791b3` (`git diff --quiet` against it), and CI runs Node 22
(`electron.yml:37`), where this does not arise. Nothing to fix in this change — but a developer on
Node 26 will see it, and it is worth a line in the README before someone chases it.

## Things I decided, that the brief left open

- **`--prerelease` on the juanmnl/operator release is now conditional.** The brief said to update
  the "preview" wording for stable tags; marking a stable release as a prerelease as well would
  contradict it. Stable tags get title `Operator 0.17.0 (Electron)` and no `--prerelease`.
- **`SHA256SUMS.txt` now covers `Operator.app.tar.gz`.** `release.mjs` writes it for the DMG and
  the zip, before the tarball exists. A checksum file that silently omits an asset is worse than
  none.
- **The tarball is asserted to still be stapled after a round-trip**, by extracting it and running
  `stapler validate` + `spctl` on that copy. `build.yml` does the same for the Tauri payload
  because 0.16.0 shipped an unstapled tarball while its `.app` validated fine. The same trap is
  open here and now closed.
- **The gate compares base versions, not whole versions.** My first cut required tag == package
  exactly, which rejected `electron-v0.17.0-rc.1` against `0.17.0` — i.e. it broke the dry run the
  brief asks for. Caught by running the step; the rule is now: base versions must match always,
  and a *stable* tag additionally requires an exact match so the feed cannot advertise
  `0.17.0-rc.1` at the url `v0.17.0`.

## What is still not proven

- **The click.** Everything up to it is CI's now; pressing **Install & Restart** in a live window
  is still the user's, and `2026-08-21-swap-click-staging-RESULT.md` is where that stands.
- **The workflow has not run.** Every step was parsed, syntax-checked, and the two that carry real
  logic (`gate`, the swap payload) were executed locally against real artefacts — but the job
  itself has not executed on a runner, and the `gh release create` calls have not been exercised
  at all. The `-rc.1` dry run is what closes that, and it is deliberately the next act.
