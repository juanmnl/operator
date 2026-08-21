# RESULT — node-pty `spawn-helper` unpacked, signed, and smoke-tested at build time

**2026-08-21 · Code lane · one file changed: `electron/scripts/release.mjs`.**
The packaged app can now spawn a pty, and the release script fails the build if it ever can't again.

## The packager option that worked

```js
asar: { unpack: '{**/{.**,**}/**/*.node,**/node-pty/**/spawn-helper}' },
```

`@electron/packager` 20.3.0 accepts `asar` as either `true` or an `@electron/asar` `CreateOptions`
object (`dist/common.js` → `createAsarOpts`). Two things about it that decided the shape above:

1. **An object REPLACES the default, it does not extend it.** `asar: true` means
   `{ unpack: '**/{.**,**}/**/*.node' }`. So packager's own pattern is repeated verbatim inside the
   brace and the helper added beside it — dropping it would have re-sealed every `.node`, including
   `better-sqlite3`'s.
2. **`unpack` is one minimatch pattern with `matchBase: true`, matched against absolute paths**
   (`@electron/asar/lib/asar.js:107`). Minimatch expands nested braces, so the composed pattern
   behaves as the union. Verified against real paths before building:

   | path | `**/{.**,**}/**/*.node` (old) | composed (new) |
   |---|---|---|
   | `…/node-pty/build/Release/spawn-helper` | — | **unpack** |
   | `…/node-pty/prebuilds/darwin-arm64/spawn-helper` | — | **unpack** |
   | `…/node-pty/build/Release/pty.node` | unpack | unpack |
   | `…/better-sqlite3/build/Release/better_sqlite3.node` | unpack | unpack |
   | `…/node_modules/.foo/build/bar.node` (dot-dir) | unpack | unpack |
   | `…/out/main/index.cjs` | — | — |

`unpackDir: '**/node_modules/node-pty'` would also have worked, but it lifts the whole module —
`lib/`, `typings/`, the lot — out of the archive for no gain. The `prebuilds/(?!darwin-arm64)`
ignore is untouched; the build still keeps exactly one prebuild.

## The mode problem the brief didn't mention

`node-pty` 1.1.0 ships its two helpers at **different modes**:

```
-rwxr-xr-x  node_modules/node-pty/build/Release/spawn-helper          ← 0755 (electron-rebuild's)
-rw-r--r--  node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper ← 0644 (as published)
```

asar writes an unpacked file with the mode it had in the staged app (`disk.js`:
`createWriteStream(targetFile, { mode: file.mode })`), so unpacking alone would have left the
prebuilt one **unpacked but not executable** — the same dead end, one step further along.
`build/Release` is what wins at runtime (`lib/utils.js` `loadNativeModule` tries
`build/Release` → `build/Debug` → `prebuilds/<platform>-<arch>`), so this is the fallback path
only, but it is a fallback that would fail exactly like the bug being fixed. Fixed with an
`afterCopy` hook, which runs on the **staged copy** — the user's `node_modules` is never touched —
and before both the asar build and signing:

```js
afterCopy: [
  async ({ buildPath }) => {
    const helpers = execFileSync('find', [join(buildPath, 'node_modules', 'node-pty'), '-name', 'spawn-helper'], { encoding: 'utf8' })
      .split('\n').filter(Boolean)
    for (const h of helpers) chmodSync(h, 0o755)
    console.log(`  spawn-helper: ${helpers.length} made 0755 before asar`)
  },
],
```

## Signing

**`osxSign` picks the helper up on its own — no extra option needed, and this was checked rather
than assumed.** `@electron/osx-sign`'s `walk()` (`dist/util.js:114`) classifies by *content*
(`isbinaryfile`), not extension, so an extensionless Mach-O sitting in `app.asar.unpacked` is in
the list. Run against the real built bundle:

```
$ node -e "import { walk } from './node_modules/@electron/osx-sign/dist/util.js'; …"
files osx-sign would sign: 264
  SIGNS  release/Operator.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper
  SIGNS  release/Operator.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper
```

Belt and braces anyway, because the brief asked for it to be handled explicitly rather than hoped
for: the verify step now runs `codesign -dv` on every unpacked helper and **exits 1** if any is
unsigned, so a signer that ever stops walking that directory fails the build instead of failing
notarization ten minutes later. That check takes codesign's own exit status — the obvious
`codesign -dv … | grep Authority` form reports *grep's* status and would score an unsigned helper
as a pass.

> Not verified locally: an actual Developer ID signature. The brief said don't sign, `@electron/osx-sign`
> refuses `identity: '-'` ("No identity found for signing"), so the sign path itself is exercised for
> the first time on the next CI run. The `walk()` evidence above is the strongest check available
> without signing.

## The smoke test

Added at the end of `step('verify what shipped')`, as asked. It runs the **shipped** binary with
`ELECTRON_RUN_AS_NODE=1` — no window, no display needed — and requires node-pty through the
bundle's own `app.asar` path, which is the only way node-pty's `app.asar` → `app.asar.unpacked`
rewrite resolves correctly. `/bin/echo` must exit 0 within 20s; anything else prints `::error::`
and exits 1.

**Before** (`asar: true`, everything else identical, `SKIP_SIGN=1 SKIP_NOTARIZE=1`):

```
=== verify what shipped
  prebuilds kept: darwin-arm64
  bundle id com.operator.app.tauri · version 0.17.0
  app size: 311 MB
::error::no spawn-helper in app.asar.unpacked — node-pty is sealed in the archive and pty.spawn() will fail with `posix_spawnp failed.`
```

…and the brief's own repro run by hand against that same local bundle, confirming it is the real
failure and not just a missing file:

```
$ ls release/Operator.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/
pty.node                       ← spawn-helper absent

$ ELECTRON_RUN_AS_NODE=1 release/Operator.app/Contents/MacOS/Operator -e '…pty.spawn("/bin/echo",…)…' …/app.asar
FAIL: posix_spawnp failed.
```

**After:**

```
=== verify what shipped
  prebuilds kept: darwin-arm64
  bundle id com.operator.app.tauri · version 0.17.0
  icon: 352KB, matches src-tauri/icons/icon.icns
  app size: 311 MB
  spawn-helper Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper · mode 755 · unsigned (SKIP_SIGN=1)
  spawn-helper Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper · mode 755 · unsigned (SKIP_SIGN=1)
  pty smoke test (ELECTRON_RUN_AS_NODE, no window):
    OK: pty spawned, /bin/echo exited 0

=== assert the packaged app serves --mcp-serve
  ok   initialize
  ok   notification is not answered
  ok   tools/list
  ok   tools/call
  ok   unknown method → -32601
  ok   malformed line → -32700 and server survives
  ok   stdout carries ONLY JSON-RPC frames
  startup 122ms
```

App size is unchanged at 311 MB — the two helpers are ~50KB and ~9KB, they moved rather than got added.

## Checks

- `npm run typecheck` (electron) — clean.
- `npm test` (electron) — 13 files, **195 tests, all passing**.
- Both builds above were **`SKIP_SIGN=1 SKIP_NOTARIZE=1`, local**. Nothing was signed, notarized,
  published, installed or opened. `src-tauri/`, the updater key and `~/.operator` were not touched.

## One thing found and deliberately NOT fixed

A `SKIP_SIGN=1` local run **cannot reach the end of the script**, and could not before this change
either. The DMG stage runs an unguarded verify on the staged copy:

```
=== DMG
…/dmg-stage/Operator.app: code has no resources but signature indicates they must be present
Error: Command failed: codesign --verify --deep --strict …
```

That is `release.mjs:297` (was :207), pre-existing and untouched here — an unsigned bundle has no
`_CodeSignature` for `--deep --strict` to check. It fires *after* everything this brief covers, so
it did not affect any result above. The one-line fix is to wrap that verify (and the symlink
assertion beside it) in `if (!SKIP_SIGN)`; left alone because it is outside this brief's scope and
changes what a release run asserts. **Worth a follow-up** — until then the prescribed local path
always ends in a red error that has nothing to do with what is being tested.
