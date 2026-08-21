// The probes import the shell's modules as CJS bundles. They are NOT part of the app build —
// `scripts/build-main.mjs` deliberately ships only main/preload — so they are built here, on
// demand, into the same `out/` (gitignored).
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const common = { bundle: true, platform: 'node', format: 'cjs', logLevel: 'error', external: ['electron', 'better-sqlite3', 'node-pty'] }
await Promise.all([
  build({ ...common, entryPoints: [resolve(root, 'src/main/transcript.ts')], outfile: resolve(root, 'out/main/transcript.cjs') }),
  build({ ...common, entryPoints: [resolve(root, 'src/main/chat-store.ts')], outfile: resolve(root, 'out/main/chat-store.cjs') }),
  build({ ...common, entryPoints: [resolve(root, 'src/shared/operator-api.ts')], outfile: resolve(root, 'out/main/event-channel.cjs') }),
  build({ ...common, entryPoints: [resolve(root, 'src/main/store.ts')], outfile: resolve(root, 'out/main/store.cjs') }),
  build({ ...common, entryPoints: [resolve(root, 'src/main/agents.ts')], outfile: resolve(root, 'out/main/agents.cjs') }),
  build({ ...common, entryPoints: [resolve(root, 'src/main/usage.ts')], outfile: resolve(root, 'out/main/usage.cjs') }),
])
console.log('probe bundles built into out/')
