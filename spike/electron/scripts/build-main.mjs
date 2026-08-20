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
  // `electron` is the runtime's own module; `node-pty` is a native addon that must stay a real
  // require so its .node binary resolves next to it in node_modules.
  external: ['electron', 'node-pty'],
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
