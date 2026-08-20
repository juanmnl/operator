// Bundle main + preload with esbuild.
//
// Two outputs, both CJS: the main entry because `node-pty` is a native CJS addon and Electron's
// ESM loader would need a `createRequire` dance for no gain, and the preload because a sandboxed
// preload has no ESM loader at all. `electron` is external in both — it is provided by the
// runtime, not bundled.
import { build, context } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const watch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outExtension: { '.js': '.cjs' },
  sourcemap: true,
  // `electron` is the runtime's own module. The others are NATIVE ADDONS and must stay real
  // requires: bundling one rewrites the require into the output directory, and its `.node`
  // binary is then looked for next to the BUNDLE instead of next to the package —
  // "Cannot find module out/build/Release/better_sqlite3.node".
  external: ['electron', 'node-pty', 'better-sqlite3'],
  logLevel: 'info',
}

const targets = [
  { entryPoints: [resolve(root, 'src/main/index.ts')], outfile: resolve(root, 'out/main/index.cjs') },
  { entryPoints: [resolve(root, 'src/preload/index.ts')], outfile: resolve(root, 'out/preload/index.cjs') },
]

if (watch) {
  for (const t of targets) {
    const ctx = await context({ ...common, ...t })
    await ctx.watch()
  }
} else {
  await Promise.all(targets.map((t) => build({ ...common, ...t })))
}
