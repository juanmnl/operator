# Brief — staple the notarization ticket into the `.app` that ships inside the updater tarball

**Implement in CI. Output: `dev/briefs/2026-08-20-staple-notarization-ticket-RESULT.md`.**
Second priority after `2026-08-20-fit-starvation-fix.md`.

## Finding (probe result `dev/briefs/2026-08-20-electron-mcp-serve-probe-RESULT.md`, verified)

`/Applications/Operator.app` (0.16.0): `xcrun stapler validate` → "does not have a ticket
stapled"; `spctl -a -t exec` → "rejected, Unnotarized Developer ID". Yet CI run 31955940500
(main, 2026-08-16) logs `Notarizing … Finished with status Accepted`. So Apple holds the ticket
but it was **never stapled into the `.app`** — and the updater payload (`Operator.app.tar.gz`,
built by `tauri-action` via `createUpdaterArtifacts: true`) carries that unstapled `.app`.
Installed users are fine only because the updater's in-place swap never sets quarantine; a
browser-downloaded DMG, or any quarantined copy spawning itself as the MCP server
(`--mcp-serve`), hits Gatekeeper — the probe showed that spawn **hangs silently**.

## Do

1. Establish what `tauri-action` actually staples (the `.dmg`? the `.app`? nothing?) and at what
   point it creates the `.app.tar.gz` relative to notarization — read the action/bundler source
   for the pinned version, don't guess.
2. In `.github/workflows/build.yml`, after the tauri-action step: `xcrun stapler staple` the
   built `.app` (and the `.dmg`), then **re-create `Operator.app.tar.gz` from the stapled `.app`
   and re-sign it with the minisign key** (`TAURI_SIGNING_PRIVATE_KEY` is already a secret; use
   the same signer the bundler uses — `tauri signer sign`), and make sure the `latest.json` step
   at L110-115 picks up the NEW `.sig`. Add `xcrun stapler validate` + `spctl -a -t exec` on the
   `.app` as a CI assertion so this can't silently regress.
3. Do not touch the updater key, the pubkey, or the endpoint. Do not tag a release. Push to your
   branch; if CI on a branch doesn't run the signing job (check `on:`), say so and describe how
   the user verifies on the next tag.
4. Note for the Electron shell (S4): electron-builder + `@electron/notarize` staple by default —
   state in the RESULT what the equivalent assertion is there so the lesson carries over.
