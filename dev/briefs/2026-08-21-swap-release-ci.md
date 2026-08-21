# Brief — make the one-way swap release a CI act: `electron-v0.17.0` publishes BOTH feeds

**Lane:** Code. **Output:** `dev/briefs/2026-08-21-swap-release-ci-RESULT.md` + `operator__report`.
**Hard rules:** do NOT push any tag. Do NOT touch `juanmnl/operator-releases` from your machine.
Never print, copy or regenerate the signing key (`~/.operator/updater-private.key`; CI has it as
`TAURI_SIGNING_PRIVATE_KEY` / `_PASSWORD`, already used by `build.yml`). No GUI launches.

## Why

The swap release (`dev/HANDOFF.md` open item 2; proven in
`dev/briefs/2026-08-20-electron-s4-packaging-handoff-RESULT.md`) moves EVERY installed Tauri
copy to Electron and cannot be undone from the app. Today it would be a laptop ritual (tar, sign,
hand-write `latest.json`, upload to two repos). It must instead be ONE deliberate act — the user
pushes tag `electron-v0.17.0` — with the payload being the very `.app` CI signed, notarized,
stapled and asserted (`release.mjs`), and a dry run available on a prerelease tag first.

Read first: `.github/workflows/electron.yml`, `.github/workflows/build.yml` lines 80–215 (how the
Tauri job tars, re-signs and publishes `latest.json` to operator-releases via `RELEASE_REPO_TOKEN`
— reuse its shape), `electron/scripts/release.mjs` (what `electron/release/` contains after a run),
`electron/src/main/updater.ts` (the inert electron-updater and its comment about feed order),
`src-tauri/tauri.conf.json` (`plugins.updater.endpoints` = the URL the installed Tauri apps poll).

## Build

1. **Swap assets, every run** (stable AND prerelease tags), after staple/validate, from the
   stapled `.app` in `electron/release/`: stage with `ditto` (never `cp -R`/`cpSync`),
   `COPYFILE_DISABLE=1 tar -czf Operator.app.tar.gz -C <stage> Operator.app` (root entry
   `Operator.app/`; assert with `tar -tzf`), then `npx tauri signer sign` (the root repo's
   `@tauri-apps/cli`; the secrets as env). Assert `.sig` non-empty AND verify it against the
   pubkey in `src-tauri/tauri.conf.json` in CI (key-id match + ed25519/blake2b — a small Node
   script is fine; S4's RESULT describes the check). Write `latest.json` exactly as `build.yml`
   does (`version`, `notes`, `pub_date`, `platforms["darwin-aarch64"].{signature,url}`), with
   `url` = `https://github.com/juanmnl/operator-releases/releases/download/v<VERSION>/Operator.app.tar.gz`.
   Attach `Operator.app.tar.gz`, `Operator.app.tar.gz.sig`, `latest.json` to the juanmnl/operator
   release too (pre-release or not) so a dry run is inspectable.
2. **Publish to operator-releases ONLY on a stable tag** (`electron-vX.Y.Z` with NO prerelease
   suffix — a regex on the tag, asserted in a step with an explicit log line "swap feed: PUBLISH"
   vs "swap feed: dry run (prerelease)"). Release `v<VERSION>` on `juanmnl/operator-releases` with
   `RELEASE_REPO_TOKEN`, assets: DMG, `Operator.app.tar.gz`, `latest.json`, the `.zip`,
   `latest-mac.yml`, `SHA256SUMS.txt`. Mark it `--latest`. Confirm in the RESULT that the Tauri
   endpoint (`…/releases/latest/download/latest.json`) and the Electron feed resolve to this
   release's assets by URL shape (don't publish anything to check — reason from `build.yml`'s
   working URLs and the existing `v0.16.0` release there: `gh release view v0.16.0 -R juanmnl/operator-releases`).
3. **Electron updater default feed.** `updater.ts`: when packaged (`app.isPackaged`) and
   `OPERATOR_UPDATE_FEED` is unset, default to the operator-releases feed. Choose between
   `provider:'generic', url:'https://github.com/juanmnl/operator-releases/releases/latest/download'`
   and `provider:'github', owner:'juanmnl', repo:'operator-releases'` by reading
   `node_modules/electron-updater` source for how each resolves `latest-mac.yml` and follows
   GitHub's redirects — cite file:line; pick the one that works with `releases/latest/download`
   redirects or with the repo's release list, and say why. Keep the env override. Unit-test the
   decision (env set → env; packaged + unset → default; dev + unset → null/inert).
4. **Version.** `electron/package.json` → `0.17.0`. Root `package.json`/`src-tauri` stay `0.16.0`
   (Tauri is frozen; its tree is removed after the release soaks — HANDOFF item 3). The Tauri
   updater compares `latest.json.version` (0.17.0) against the installed 0.16.0 — state the semver
   rule you rely on with a citation into the vendored `tauri-plugin-updater`.
5. **Release notes** (the Tauri toast shows `latest.json.notes`; operator-releases body = the
   same): 3–5 lines, plain: Operator moves to Electron; no hourly renderer restart; WebGL terminal;
   same `~/.operator`; gridterm sessions end; `--mcp-serve` unchanged. Keep the juanmnl/operator
   release notes in `electron.yml` (update "preview" wording for stable tags).
6. **Dry-run path documented** in the RESULT: `git tag electron-v0.17.0-rc.1 && git push origin
   electron-v0.17.0-rc.1` → a juanmnl/operator pre-release carrying the swap assets, operator-releases
   untouched. Then the user may point the swap-check feed (`~/.operator/swap-check/feed/`, from
   `2026-08-21-swap-click-staging`) at THOSE CI-built `tar.gz`+`.sig` for check #4 — write the
   two commands that do that substitution.

## Verify

`actionlint` (or `gh workflow view`/`node -e` YAML parse) on the workflow; the root `npm test`,
`tsc --noEmit`; `electron/` `npm test` + `typecheck`. Walk the stable-tag branch of the workflow
by hand in the RESULT (a table: step → runs on prerelease? → runs on stable?). No tag pushed.
