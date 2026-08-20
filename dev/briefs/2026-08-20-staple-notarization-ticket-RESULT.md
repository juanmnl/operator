# Result — staple the notarization ticket into the `.app` that ships in the updater tarball

**Done in `.github/workflows/build.yml`.** One new step, after `tauri-action` and before the
upload/publish steps: staple the `.app` and the `.dmg`, **rebuild `Operator.app.tar.gz` from the
stapled `.app`, re-sign it with the same minisign key**, and assert. No tag, no release, and the
updater key / pubkey / endpoint are untouched.

## 1. What `tauri-action` actually staples

Read from the pinned CLI rather than from upstream docs: `@tauri-apps/cli` **2.11.2**, whose macOS
binary (`cli.darwin-arm64.node`) is what the action runs. Strings extracted from that exact build:

| Evidence in the binary | What it tells us |
|---|---|
| `staple="$(xcrun stapler staple "${DMG_DIR}/${DMG_NAME}")"` | the **DMG** is stapled, from inside the bundler's dmg shell script |
| `SKIP_STAPLING` / `skip-stapling` — *"Whether to wait for notarization to finish and `staple` the ticket onto the app"* | app stapling exists and is on by default |
| *"When it's done you can optionally staple your app via `xcrun stapler staple …"* | the message shown when stapling was skipped |
| *"Gatekeeper will look for stapled tickets … without reaching out to Apple's servers"* | the bundler's own statement of why it matters |
| `do not know how to staple `, `StapleUnsupportedBundleType`, `DmgStapleNoSignature` | the staple paths and their failure modes |

So the bundler *does* staple. The shipped 0.16.0 is nevertheless unstapled, and there are two
mechanisms that produce that outcome — the fix covers both because it does not depend on which
one it was:

1. **Stapling a `.dmg` attaches the ticket to the disk image, not to the app inside it.** An app
   dragged out of a stapled DMG is a copy, and carries no ticket of its own.
2. **`createUpdaterArtifacts` builds `Operator.app.tar.gz` from the `.app` as it stands when the
   bundler reaches that step.** Anything stapled afterwards is not in the tarball — so the payload
   the updater installs can be unstapled even when the `.app` left on disk is fine.

I could not pin down the bundler's exact internal ordering from strings alone, and did not want to
guess at it in a way the fix would depend on. The step is therefore written to be correct either
way, and `xcrun stapler staple` is idempotent, so it is safe if the bundler already stapled.

## 2. The change

One step in the `macos` job, gated on notarization having been configured
(`env.APPLE_API_KEY_PATH != ''`, set by the existing "Prepare notarization key" step), so a run
without the secrets skips it rather than failing on a missing ticket:

```
xcrun stapler staple -v "$APP"      # the one that matters
xcrun stapler staple -v "$DMG"      # so an offline first-open of the download is clean too

rm -f "$TARGZ" "$TARGZ.sig"
COPYFILE_DISABLE=1 tar -czf "$TARGZ" -C "$(dirname "$APP")" "$(basename "$APP")"
npx tauri signer sign "$TARGZ"      # same key, from TAURI_SIGNING_PRIVATE_KEY
```

`-C` so the archive root is `Operator.app` and not the build path. `COPYFILE_DISABLE=1` stops
bsdtar writing AppleDouble `._` entries, which the bundler's Rust-written tar does not contain and
which would land as junk inside the app on extract.

The existing publish step reads `SIG=$(cat "$BUNDLE"/macos/*.app.tar.gz.sig)`, and the new step
runs before it and overwrites in place, so `latest.json` picks up the new signature with no change
to that step. `*.app.tar.gz` and `*.app.tar.gz.sig` were added to the uploaded artifacts so a run
can be inspected without cutting a tag.

### The assertions

```
xcrun stapler validate "$APP"        &&  spctl -a -vvv -t exec "$APP"
xcrun stapler validate "$DMG"
# then, the one that actually covers the reported bug:
tar -xzf "$TARGZ" -C "$VERIFY"  &&  xcrun stapler validate "$VERIFY/Operator.app"
                                &&  spctl -a -vvv -t exec "$VERIFY/Operator.app"
```

**Validating only the `.app` on disk would have passed while still shipping an unstapled tarball
— which is exactly the bug.** So the payload is unpacked and the ticket checked in *that* copy.
The step runs under `set -euo pipefail`, so any of these failing fails the build.

## 3. What I verified locally, and what I could not

Verified end-to-end on this machine, using the signed `.app` from the MCP probe as a real bundle
(129 MB, 14 internal symlinks) and a **throwaway** minisign key generated into `/tmp` — the real
key was never touched:

| Check | Result |
|---|---|
| archive root entry | `Operator.app/` — correct, not a build path |
| AppleDouble `._` entries in the archive | **0** |
| symlinks preserved through tar → extract | 14 → **14** |
| `tauri signer sign <tar.gz>` | produced a 408-byte minisign `.sig` |
| Developer ID signature after the tar round-trip | `codesign --verify --deep --strict` → **valid** |

That last row is the one worth having: re-tarring the bundle does not break its code signature.

**Not verified: the `xcrun stapler staple` call itself.** It needs a real notarization ticket from
Apple, which needs the App Store Connect issuer ID — a CI-only secret (`APPLE_API_ISSUER`), not
present locally. The commands are the documented ones and the assertions will catch it if they are
wrong, but they have not executed against a real ticket.

## 4. CI does not run on my branch — how to verify this

`on:` is `push: branches: [main]`, `tags: ['v*']`, and `workflow_dispatch`. **A push to
`operator/c25838` does not trigger it**, so this change is unexercised as it stands.

The clean way to verify without tagging: `workflow_dispatch` already exists on `main`, so in
**Actions → build → Run workflow**, pick branch `operator/c25838`. That runs the full `macos` job —
build, sign, notarize, and the new step — while the "Publish public release" step stays skipped
(`if: startsWith(github.ref, 'refs/tags/')`). Nothing is released. The step's own output is the
verification: `stapler validate` and `spctl` on the `.app`, the `.dmg`, and the unpacked updater
payload, plus the artifacts to download and re-check by hand.

Expected `spctl` output once this works, replacing today's `rejected / Unnotarized Developer ID`:

```
…/Operator.app: accepted
source=Notarized Developer ID
```

## 5. Carrying the lesson into the Electron shell (S4)

`electron-builder` calls `@electron/notarize`, which staples the `.app` by default — so the
*default* is right where Tauri's effective behaviour was not. The trap does not disappear, it
moves: `electron-updater`'s macOS payload is a **zip built from the app directory**, and if that
zip is produced before stapling it carries an unstapled app exactly as the Tauri tarball does.

The assertion carries over unchanged, and it is the one to keep: **unpack the artifact the updater
will actually install and `stapler validate` the app inside it.** Checking the `.app` in
`dist/mac-arm64/` is not the same check. Concretely, for the Electron shell:

```
xcrun stapler validate "dist/mac-arm64/Operator.app"
unzip -q dist/Operator-<ver>-arm64-mac.zip -d "$V" && xcrun stapler validate "$V/Operator.app"
spctl -a -vvv -t exec "$V/Operator.app"
```

This matters more under Electron than it did under Tauri, because the artifact plane spawns the
app as its own MCP server (`<execPath> --mcp-serve`), and a quarantined unstapled bundle does not
refuse loudly — **it hangs with no output, no error and no exit code**
(`dev/briefs/2026-08-20-electron-mcp-serve-probe-RESULT.md`).
