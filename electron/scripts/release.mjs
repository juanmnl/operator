// Build a signed, notarized, stapled Operator.app and the artefacts a pre-release ships:
// a DMG, a zip, `latest-mac.yml` and SHA256SUMS.
//
// ONE SCRIPT FOR CI AND FOR A LAPTOP. The alternative — a workflow that inlines the steps —
// means the thing you can run locally is not the thing that ships, and the difference only
// shows up at release time. Every stage is skippable by env so a local run can stop before
// notarization (which needs the CI-only App Store Connect issuer id).
//
// Stages, in this order and for these reasons:
//   package → prune → sign → ASSERT --mcp-serve → notarize → staple → validate → dmg/zip/yml
//
// The assertion sits after signing and before notarization on purpose: it is the SIGNED binary
// a lane will actually spawn, and notarization takes minutes that are wasted if the artifact
// plane is broken. `dev/briefs/2026-08-20-electron-mcp-serve-probe-RESULT.md` is why it exists
// at all — a lane whose MCP server hangs fails silently, with no output and no exit code.
import { execFileSync, execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, readlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const repo = resolve(root, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const VERSION = pkg.version
const PRODUCT = 'Operator'
// KEEP THE TAURI BUNDLE ID. Dragging this over /Applications/Operator.app should replace the
// installed app cleanly, and TCC/LaunchServices identity is keyed on the id + signing identity —
// changing it would orphan any permission the user has already granted. Rename later, once the
// Electron build is the only one.
const BUNDLE_ID = 'com.operator.app.tauri'
/** The feed baked into `app-update.yml`. Same URL `updater.ts` sets at runtime — kept here so a
 *  bundle is self-describing, and asserted equal to it by `updater.test.ts`. */
const UPDATE_FEED_URL = 'https://github.com/juanmnl/operator-releases/releases/latest/download'
const ARCH = 'arm64'
const OUT = join(root, 'release')
const ICON = join(repo, 'src-tauri', 'icons', 'icon.icns')
const APP = join(OUT, `${PRODUCT}.app`)

const SKIP_SIGN = process.env.SKIP_SIGN === '1'
const SKIP_NOTARIZE = process.env.SKIP_NOTARIZE === '1'

const step = (msg) => console.log(`\n=== ${msg}`)
const sh = (cmd) => execSync(cmd, { stdio: 'inherit', cwd: root })
const shOut = (cmd) => execSync(cmd, { cwd: root, encoding: 'utf8' }).trim()

// ---------------------------------------------------------------- build + package
step(`build ${PRODUCT} ${VERSION} (${ARCH})`)
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
sh('node scripts/build-main.mjs')
// The ROOT's vite, by path, not `npx vite`. This package declares no vite of its own — the
// renderer it builds is the root renderer — and `npx` answers a missing binary by DOWNLOADING
// the latest from the registry. It fetched vite 8 here and silently changed the bundler to
// rolldown; in CI it would fetch whatever is newest that morning.
sh(`${JSON.stringify(join(repo, 'node_modules', '.bin', 'vite'))} build --config vite.config.ts`)

step('package (+ prune, + sign — in that order, and it has to be that order)')
// SIGNING HAPPENS DURING PACKAGING, not after. A signature seals the bundle's contents, so
// anything removed afterwards invalidates it — which is why the prebuilds are dropped by
// `ignore` at copy time rather than deleted from the packaged app.
//
// The JS API rather than the CLI: every option here is a real value instead of a string that
// has to survive a shell. The CLI route silently dropped the icon (it re-derives an extension
// from the argument) and, when signing was called separately, produced an unquoted codesign
// command that choked on the space in `Electron Framework.framework`.
const packaged = join(OUT, 'packager')
const { packager } = await import('@electron/packager')
const [built] = await packager({
  dir: root,
  name: PRODUCT,
  platform: 'darwin',
  arch: ARCH,
  out: packaged,
  overwrite: true,
  // NOT `asar: true`. On macOS node-pty execs a helper binary that sits NEXT TO its `.node`
  // (`lib/unixTerminal.js`: `native.dir + '/spawn-helper'`, with `app.asar` rewritten to
  // `app.asar.unpacked`). Packager's default unpack pattern is `.node` files only, so the helper
  // stayed sealed inside the archive where nothing can exec it and every `pty.spawn()` in the
  // packaged app died with `posix_spawnp failed.` — i.e. not one lane could launch (found in the
  // rc.1 bundle, `dev/briefs/2026-08-21-node-pty-spawn-helper-unpack.md`). Setting `asar` to an
  // object REPLACES the default pattern, so packager's own `**/{.**,**}/**/*.node` is repeated
  // here verbatim and the helper added beside it.
  asar: { unpack: '{**/{.**,**}/**/*.node,**/node-pty/**/spawn-helper}' },
  appBundleId: BUNDLE_ID,
  appVersion: VERSION,
  buildVersion: VERSION,
  icon: ICON,
  // Source, scripts and measurements are not the app; `mcp-probe` is a separate throwaway app.
  // node-pty ships a prebuild per platform and ABI — 58MB, all but one useless here.
  ignore: [
    /^\/src($|\/)/, /^\/scripts($|\/)/, /^\/measurements($|\/)/, /^\/release($|\/)/,
    /^\/dist($|\/)/, /^\/probes($|\/)/, /^\/build($|\/)/,
    /^\/tsconfig.*/, /^\/vite\.config\.ts$/, /^\/vitest\.config\.ts$/,
    /\.map$/, /\.test\.ts$/,
    /node_modules\/node-pty\/prebuilds\/(?!darwin-arm64)/,
  ],
  // asar copies an unpacked file with the mode it had in the staged app, and node-pty ships its
  // PREBUILT helper at 0644 — unpacked but not executable is the same dead end as sealed. Fix the
  // mode on the STAGED COPY (never the user's node_modules), before the asar is built and before
  // signing. `build/Release` wins at runtime and is already 0755; this covers the fallback.
  afterCopy: [
    async ({ buildPath }) => {
      const helpers = execFileSync('find', [join(buildPath, 'node_modules', 'node-pty'), '-name', 'spawn-helper'], { encoding: 'utf8' })
        .split('\n').filter(Boolean)
      for (const h of helpers) chmodSync(h, 0o755)
      console.log(`  spawn-helper: ${helpers.length} made 0755 before asar`)
    },
    // `app-update.yml` — THE FILE WHOSE ABSENCE BROKE EVERY UPDATE.
    //
    // We package with `@electron/packager` and hand-write `latest-mac.yml`, so `electron-builder`
    // — the thing that normally emits this — never runs. But the CLIENT is `electron-updater`,
    // and `AppUpdater.getOrCreateDownloadHelper()` reads
    // `<Resources>/app-update.yml` for `updaterCacheDirName` on the DOWNLOAD path. Missing, that
    // read throws ENOENT and `downloadUpdate()` rejects.
    //
    // `checkForUpdates()` never touches it — we call `setFeedURL()` explicitly, which sets the
    // client without consulting the file. So the check succeeded, the toast appeared, and the
    // download died: exactly "Install & Restart does nothing, with no dialog and no quit".
    // Verified on the shipped 0.17.2 AND on 0.18.0 — neither bundle contains this file.
    //
    // It goes in during `afterCopy` because signing happens DURING packaging (`osxSign` below);
    // a file added afterwards would be outside the sealed resources and fail `codesign --verify`.
    async ({ buildPath }) => {
      const resources = resolve(buildPath, '..')
      const yml = [
        // The one key electron-updater actually requires. Named after the bundle id so two
        // Operator builds cannot share a pending-update cache.
        `updaterCacheDirName: ${BUNDLE_ID}-updater`,
        'provider: generic',
        `url: ${UPDATE_FEED_URL}`,
        '',
      ].join('\n')
      writeFileSync(join(resources, 'app-update.yml'), yml)
      console.log('  app-update.yml written into Resources (before signing)')
    },
  ],
  ...(SKIP_SIGN ? {} : {
    osxSign: {
      identity: process.env.APPLE_SIGNING_IDENTITY || 'Developer ID Application: Juan Cornejo (UJS4C5GUCW)',
      type: 'distribution',
      // `optionsForFile` is what applies the hardened runtime and entitlements to EVERY nested
      // binary — helpers and framework, signed inside-out. Set only at the top level, the
      // helpers stay unhardened and notarization rejects the bundle.
      optionsForFile: () => ({ entitlements: join(root, 'build', 'entitlements.plist'), hardenedRuntime: true }),
    },
  }),
})
// MOVE, never copy. `fs.cpSync` rewrites symlinks relative to the destination, and a macOS
// framework is held together by them (`Versions/Current`, `Resources`) — copying the bundle
// invalidated the signature it had just been given ("Squirrel.framework: bundle format
// unrecognized, invalid, or unsuitable"). A rename touches nothing inside.
execFileSync('mv', [join(built, `${PRODUCT}.app`), APP])
rmSync(packaged, { recursive: true, force: true })

step('verify what shipped')
{
  const prebuilds = join(APP, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds')
  if (existsSync(prebuilds)) console.log(`  prebuilds kept: ${readdirSync(prebuilds).join(', ')}`)
  const plist = shOut(`defaults read ${JSON.stringify(join(APP, 'Contents', 'Info.plist'))} CFBundleIdentifier`)
  const ver = shOut(`defaults read ${JSON.stringify(join(APP, 'Contents', 'Info.plist'))} CFBundleShortVersionString`)
  console.log(`  bundle id ${plist} · version ${ver}`)
  if (plist !== BUNDLE_ID) { console.error(`::error::bundle id is ${plist}, expected ${BUNDLE_ID}`); process.exit(1) }
  if (ver !== VERSION) { console.error(`::error::version is ${ver}, expected ${VERSION}`); process.exit(1) }
  // `electron.icns` is the DESTINATION filename (CFBundleIconFile), not evidence of a default
  // icon — packager copies whatever `--icon` points at into it. So compare the bytes. (The
  // "Could not find icon … with extension '.icon'" warning above is packager looking for
  // Apple's new Icon Composer format, which we do not ship; it is not the .icns path.)
  const shipped = join(APP, 'Contents', 'Resources', 'electron.icns')
  if (!existsSync(shipped) || readFileSync(shipped).length !== readFileSync(ICON).length) {
    console.error('::error::the app icon is not ours — Resources/electron.icns does not match src-tauri/icons/icon.icns')
    process.exit(1)
  }
  console.log(`  icon: ${(readFileSync(shipped).length / 1024).toFixed(0)}KB, matches src-tauri/icons/icon.icns`)
  console.log(`  app size: ${shOut(`du -sm ${JSON.stringify(APP)}`).split('\t')[0]} MB`)
  if (!SKIP_SIGN) {
    sh(`codesign --verify --deep --strict --verbose=1 ${JSON.stringify(APP)}`)
    console.log(`  ${shOut(`codesign -dv ${JSON.stringify(APP)} 2>&1 | grep Authority | head -1`)}`)
  }

  // node-pty's spawn-helper: OUT of the archive, EXECUTABLE, and SIGNED. All three or no lane
  // launches — and the third one is not optional, because an unsigned nested Mach-O inside a
  // hardened-runtime bundle is what notarization rejects.
  const unpackedPty = join(APP, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'node-pty')
  const helpers = existsSync(unpackedPty)
    ? execFileSync('find', [unpackedPty, '-name', 'spawn-helper'], { encoding: 'utf8' }).split('\n').filter(Boolean)
    : []
  if (!helpers.length) {
    console.error('::error::no spawn-helper in app.asar.unpacked — node-pty is sealed in the archive and pty.spawn() will fail with `posix_spawnp failed.`')
    process.exit(1)
  }
  for (const h of helpers) {
    const mode = statSync(h).mode & 0o777
    if (!(mode & 0o111)) {
      console.error(`::error::${h} is not executable (mode ${mode.toString(8)})`)
      process.exit(1)
    }
    let sig = 'unsigned (SKIP_SIGN=1)'
    if (!SKIP_SIGN) {
      // No pipe: a `codesign -dv | grep` pipeline reports GREP's exit code, so an unsigned helper
      // would read as a pass. Take codesign's own status, then pick the line out in JS.
      let info
      try {
        info = execSync(`codesign -dv ${JSON.stringify(h)} 2>&1`, { encoding: 'utf8' })
      } catch {
        console.error(`::error::${h} was NOT signed — osxSign skipped it, and notarization will reject the bundle`)
        process.exit(1)
      }
      sig = info.split('\n').find((l) => /^(Signature|Authority)/.test(l))?.trim() ?? 'signed'
    }
    console.log(`  spawn-helper ${h.slice(APP.length + 1)} · mode ${mode.toString(8)} · ${sig}`)
  }

  // And then actually spawn one. The checks above are what the packager did; this is what a lane
  // does. `ELECTRON_RUN_AS_NODE=1` runs the SHIPPED binary as a plain node with no window, so it
  // is the packaged app's own copy of node-pty being exercised — the path node-pty rewrites
  // (`app.asar` → `app.asar.unpacked`) only resolves correctly from inside the bundle.
  console.log('  pty smoke test (ELECTRON_RUN_AS_NODE, no window):')
  {
    const smoke = `
      const pty = require(process.argv[1] + '/node_modules/node-pty')
      const bail = (m) => { console.log(m); process.exit(1) }
      const timer = setTimeout(() => bail('FAIL: the pty never exited'), 20000)
      try {
        const p = pty.spawn('/bin/echo', ['hi'], { name: 'xterm-256color', cols: 80, rows: 24 })
        p.onExit(({ exitCode }) => {
          clearTimeout(timer)
          if (exitCode !== 0) bail('FAIL: /bin/echo exited ' + exitCode)
          console.log('OK: pty spawned, /bin/echo exited 0')
          process.exit(0)
        })
      } catch (e) { bail('FAIL: ' + e.message) }
    `
    let out
    try {
      out = execFileSync(join(APP, 'Contents', 'MacOS', PRODUCT), ['-e', smoke, join(APP, 'Contents', 'Resources', 'app.asar')], {
        encoding: 'utf8',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
    } catch (e) {
      out = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || `the smoke test produced no output (${e.message})`
    }
    for (const line of out.split('\n')) console.log(`    ${line}`)
    if (!out.startsWith('OK:')) {
      console.error('::error::the packaged app cannot spawn a pty — no lane will launch')
      process.exit(1)
    }
  }
}

// ---------------------------------------------------------------- the assertion that matters
// A lane spawns `process.execPath --mcp-serve`. If the packaged binary cannot answer that, the
// artifact plane is dead and the failure is SILENT — the probe measured a hang with no output,
// no error and no exit code. Cheaper to catch here than after a notarization round trip.
step('assert the packaged app serves --mcp-serve')
{
  const exe = join(APP, 'Contents', 'MacOS', PRODUCT)
  const sandbox = join(OUT, 'mcp-assert-home')
  mkdirSync(sandbox, { recursive: true })
  // The driver exits NON-ZERO whenever any step fails, and `probe/env` is a method only the
  // throwaway probe app implements — so a clean run of the real server still exits 1. Catch it
  // and judge the steps, rather than letting the exit code decide.
  let out
  try {
    out = execFileSync(process.execPath, [join(root, 'probes', 'mcp-probe', 'scripts', 'drive.mjs'), exe, '--mcp-serve'], {
      encoding: 'utf8',
      // A SANDBOXED HOME: `operator__report` really inserts a row, and pointing it at the real
      // ~/.operator would leave a probe report in the user's artifact store on every build.
      env: { ...process.env, OPERATOR_DIR: sandbox, OPERATOR_TERMINAL_ID: 't-release-assert' },
      stdio: ['ignore', 'pipe', 'inherit'],
    }).toString()
  } catch (e) {
    out = e.stdout?.toString() ?? ''
    if (!out) { console.error('::error::the --mcp-serve driver produced no output at all'); process.exit(1) }
  }
  const result = JSON.parse(out)
  const required = result.steps.filter((s) => s.name !== 'probe/env')
  const failed = required.filter((s) => !s.ok)
  for (const s of required) console.log(`  ${s.ok ? 'ok  ' : 'FAIL'} ${s.name}`)
  if (failed.length) {
    console.error(`\n::error::the packaged app failed the --mcp-serve contract: ${failed.map((s) => s.name).join(', ')}`)
    process.exit(1)
  }
  console.log(`  startup ${result.startupMs}ms`)
  rmSync(sandbox, { recursive: true, force: true })
}

// ---------------------------------------------------------------- notarize + staple
if (SKIP_NOTARIZE) {
  step('SKIPPING notarization (SKIP_NOTARIZE=1) — the artefacts will NOT pass Gatekeeper')
} else {
  step('notarize')
  const { notarize } = await import('@electron/notarize')
  await notarize({
    appPath: APP,
    // The API-key form. `notarytool` needs all three; the issuer id is the one that only exists
    // as a CI secret, which is why a local run stops at SKIP_NOTARIZE.
    appleApiKey: process.env.APPLE_API_KEY_PATH,
    appleApiKeyId: process.env.APPLE_API_KEY,
    appleApiIssuer: process.env.APPLE_API_ISSUER,
  })

  step('staple the .app')
  sh(`xcrun stapler staple -v ${JSON.stringify(APP)}`)
  sh(`xcrun stapler validate ${JSON.stringify(APP)}`)
  // The check that actually matters: an unstapled quarantined bundle hangs when spawned as the
  // MCP server, so Gatekeeper accepting this bundle offline is a precondition of the artifact
  // plane working for anyone who downloads it.
  sh(`spctl -a -vvv -t exec ${JSON.stringify(APP)}`)
}

// ---------------------------------------------------------------- DMG
step('DMG')
const DMG = join(OUT, `Operator_${VERSION}_aarch64.dmg`)
{
  const stage = join(OUT, 'dmg-stage')
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  // `ditto`, NOT fs.cpSync: cpSync rewrites every symlink to its RESOLVED absolute target
  // (verbatimSymlinks defaults to false), so the frameworks' `Versions/Current` links inside the
  // DMG pointed at /Users/runner/... on the CI box and the installed app failed codesign with
  // "bundle format unrecognized" (alpha.1's DMG, 2026-08-21). The zip was made with ditto and
  // was fine — do the same here, and prove it before the image is built.
  execFileSync('ditto', [APP, join(stage, `${PRODUCT}.app`)])
  sh(`codesign --verify --deep --strict ${JSON.stringify(join(stage, `${PRODUCT}.app`))}`)
  {
    const cur = join(stage, `${PRODUCT}.app`, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'Current')
    const target = readlinkSync(cur)
    if (target.startsWith('/')) throw new Error(`DMG stage has an absolute symlink: ${cur} -> ${target}`)
  }
  // The /Applications symlink is what makes the window a drag-and-drop install rather than a
  // folder the user has to know what to do with.
  execFileSync('ln', ['-s', '/Applications', join(stage, 'Applications')])
  sh(`hdiutil create -volname ${JSON.stringify(`${PRODUCT} ${VERSION}`)} -srcfolder ${JSON.stringify(stage)} -ov -format UDZO ${JSON.stringify(DMG)}`)
  rmSync(stage, { recursive: true, force: true })
  if (!SKIP_NOTARIZE) {
    // The DMG has to be NOTARIZED before it can be stapled — a ticket exists only for hashes
    // Apple has seen, and only the .app was submitted above. Run 32445562659 failed exactly
    // here ("stapler staple" on the DMG → error 65), the same way build.yml's first staple run
    // did for the Tauri DMG. Submit the image itself (this also covers its contents), then
    // staple it so the first open of a download is clean offline. Advisory: a DMG without a
    // ticket is still Gatekeeper-valid online because the .app inside is notarized+stapled,
    // which is the half that actually matters (and the half the updater zip ships).
    try {
      step('notarize the DMG')
      const { notarize } = await import('@electron/notarize')
      await notarize({
        appPath: DMG,
        appleApiKey: process.env.APPLE_API_KEY_PATH,
        appleApiKeyId: process.env.APPLE_API_KEY,
        appleApiIssuer: process.env.APPLE_API_ISSUER,
      })
      sh(`xcrun stapler staple -v ${JSON.stringify(DMG)}`)
      sh(`xcrun stapler validate ${JSON.stringify(DMG)}`)
    } catch (e) {
      console.warn(`::warning::DMG notarization/staple did not complete (${e?.message ?? e}); the DMG ships without a stapled ticket — the .app inside is notarized and stapled`)
    }
  }
}

// ---------------------------------------------------------------- zip + latest-mac.yml
step('zip + latest-mac.yml')
const ZIP = join(OUT, `Operator-${VERSION}-arm64-mac.zip`)
// `ditto` rather than `zip`: it preserves symlinks and extended attributes, and a bundle zipped
// with plain `zip` loses the framework symlinks and fails its own signature check on extract.
sh(`ditto -c -k --sequesterRsrc --keepParent ${JSON.stringify(APP)} ${JSON.stringify(ZIP)}`)

const sha512b64 = (p) => createHash('sha512').update(readFileSync(p)).digest('base64')
const yml = [
  `version: ${VERSION}`,
  'files:',
  `  - url: ${basename(ZIP)}`,
  `    sha512: ${sha512b64(ZIP)}`,
  `    size: ${statSync(ZIP).size}`,
  `path: ${basename(ZIP)}`,
  `sha512: ${sha512b64(ZIP)}`,
  `releaseDate: '${new Date().toISOString()}'`,
  '',
].join('\n')
writeFileSync(join(OUT, 'latest-mac.yml'), yml)

function basename(p) { return p.split('/').pop() }

// SHA256SUMS so a download can be checked without trusting the page.
const sums = [DMG, ZIP].map((p) => `${createHash('sha256').update(readFileSync(p)).digest('hex')}  ${basename(p)}`).join('\n') + '\n'
writeFileSync(join(OUT, 'SHA256SUMS.txt'), sums)

step('artefacts')
for (const f of readdirSync(OUT)) {
  const p = join(OUT, f)
  if (statSync(p).isFile()) console.log(`  ${(statSync(p).size / 1048576).toFixed(1).padStart(7)} MB  ${f}`)
}
console.log(`\nversion ${VERSION} · bundle id ${BUNDLE_ID}`)
