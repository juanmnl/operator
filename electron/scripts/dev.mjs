// `npm run dev` — Vite for the renderer, esbuild --watch for main/preload, then Electron.
//
// Electron is started only AFTER the dev server answers: loading the window first shows a
// connection-refused page, and `will-navigate` (correctly) refuses to let it navigate back.
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { rendererPort } from './renderer-port.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
// OPERATOR_ELECTRON_PORT, then the lane's leased OPERATOR_DEV_PORT, then 1610 (scripts/renderer-port.mjs).
const PORT = rendererPort(process.env)
// Which page the window opens on: the app, or the measurement bench (`PAGE=bench.html?...`).
const PAGE = process.env.OPERATOR_ELECTRON_PAGE || 'index.html'
const URL_ = `http://localhost:${PORT}/${PAGE}`

// A dev instance must not share ~/.operator with the installed app while it runs: it would take
// last-run.json from it (or, killed hard, leave its own lanes there for the installed app to resume
// as a crash), and its boot reapers would act on the installed app's lanes and worktrees. With
// OPERATOR_DIR unset and a packaged Operator running, use a scratch dir instead. Setting
// OPERATOR_DIR yourself still wins.
if (!process.env.OPERATOR_DIR && packagedOperatorRunning()) {
  const scratch = join(tmpdir(), 'operator-dev')
  mkdirSync(scratch, { recursive: true })
  process.env.OPERATOR_DIR = scratch
  console.error(`[dev] the installed Operator is running: this instance uses OPERATOR_DIR=${scratch}. Set OPERATOR_DIR to choose another.`)
}

function packagedOperatorRunning() {
  try {
    const out = execFileSync('/bin/ps', ['-axo', 'comm='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
    return out.split('\n').some((l) => /\.app\/Contents\/MacOS\/Operator$/.test(l.trim()))
  } catch {
    return false
  }
}

const children = []
const run = (cmd, args, opts = {}) => {
  const c = spawn(cmd, args, { cwd: root, stdio: 'inherit', ...opts })
  children.push(c)
  return c
}
const shutdown = () => { for (const c of children) { try { c.kill() } catch { /* gone */ } } }
process.on('SIGINT', () => { shutdown(); process.exit(0) })
process.on('SIGTERM', () => { shutdown(); process.exit(0) })

run('node', [resolve(here, 'build-main.mjs'), '--watch'])
const vite = run('npx', ['vite', '--config', resolve(root, 'vite.config.ts')], { env: { ...process.env, OPERATOR_ELECTRON_PORT: String(PORT) } })

// If Vite cannot bind, STOP. It used to fall through to "wait for something on that port",
// and on a machine running several projects that something is somebody else's dev server:
// one measurement run silently loaded an unrelated app and reported a clean, meaningless
// result. `strictPort` is what makes the bind fail rather than drift to PORT+1; this is what
// makes the failure fatal rather than confusing.
let viteDead = false
vite.on('exit', (code) => {
  viteDead = true
  if (code !== 0) console.error(`\n[dev] vite exited with code ${code} — is port ${PORT} taken by another project?`)
})

// Wait for OUR dev server rather than guessing at a delay — and prove it is ours. Anything can
// answer on a port; only this app serves a document containing our renderer entry.
let ready = false
for (let i = 0; i < 100 && !viteDead; i++) {
  try {
    const r = await fetch(URL_)
    if (r.ok && (await r.text()).includes('/src/renderer/')) { ready = true; break }
  } catch { /* not up yet */ }
  await sleep(200)
}
if (!ready) {
  console.error(`[dev] ${URL_} never served this app's renderer — refusing to launch Electron against it.`)
  shutdown()
  process.exit(1)
}

const electron = run('npx', ['electron', resolve(root, 'out/main/index.cjs')], {
  env: { ...process.env, OPERATOR_ELECTRON_URL: URL_ },
})
electron.on('exit', () => { shutdown(); process.exit(0) })
