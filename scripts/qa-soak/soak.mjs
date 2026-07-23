// THROWAWAY soak driver (not committed) — boots its own Vite dev server, loads
// scripts/qa-soak/harness.ts (TerminalPane.tsx's repaint/heal logic copied
// around a real xterm, driven by continuous ticking output) in headless
// WebKit, and screenshot-loops the STATIC reference region at high frequency
// for the whole soak window. Frames are saved to disk for pixel-diffing via
// ImageMagick `compare` (no new npm deps) to check whether the 1Hz heal
// interval's translate3d(0, 0.02px, 0) nudge ever produces a visible change in
// content that never legitimately changes.
//
//   node scripts/qa-soak/soak.mjs [--port <n>] [--soakMs <n>] [--out <dir>]
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { webkit } from 'playwright'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..')

const args = process.argv.slice(2)
const getArg = (flag, def) => {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
const port = Number(getArg('--port', '5799'))
const soakMs = Number(getArg('--soakMs', '14000'))
const variant = getArg('--variant', 'new')
const outDir = resolve(repoRoot, getArg('--out', 'scripts/qa-soak/out'))
const url = `http://localhost:${port}/scripts/qa-soak/index.html?soakMs=${soakMs}&variant=${variant}`

mkdirSync(outDir, { recursive: true })

function waitForServer(targetUrl, timeoutMs = 30000) {
  const start = Date.now()
  return new Promise((res, rej) => {
    const tick = async () => {
      try {
        const r = await fetch(targetUrl)
        if (r.ok) return res()
      } catch { /* not up yet */ }
      if (Date.now() - start > timeoutMs) return rej(new Error(`Vite not ready at ${targetUrl}`))
      setTimeout(tick, 250)
    }
    tick()
  })
}

let vite
let exitCode = 0
try {
  vite = spawn('npm', ['run', 'dev'], {
    cwd: repoRoot,
    env: { ...process.env, OPERATOR_DEV_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  vite.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`))

  await waitForServer(`http://localhost:${port}/scripts/qa-soak/index.html`)

  const browser = await webkit.launch()
  const page = await browser.newPage({ deviceScaleFactor: 2, colorScheme: 'dark' })
  const consoleErrors = []
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
  page.on('pageerror', (e) => consoleErrors.push(String(e)))

  await page.goto(url, { waitUntil: 'load' })
  await page.waitForFunction('window.__visualReady === true', { timeout: 15000 })

  // Static reference region only (the box + static text rows), deliberately
  // excluding the ticking status row below it — any diff here can only come
  // from the repaint/heal mechanism, never from legitimate new output. (140
  // originally bled into the tick row below the box — verified via screenshot
  // that 82 stays clear of it.)
  const clip = { x: 16, y: 16, width: 620, height: 82 }

  const frames = []
  const captureUntil = Date.now() + soakMs + 2000
  let i = 0
  while (Date.now() < captureUntil) {
    const path = resolve(outDir, `frame-${String(i).padStart(4, '0')}.png`)
    await page.screenshot({ path, clip })
    frames.push({ i, t: Date.now(), path })
    i++
    await page.waitForTimeout(120)
  }

  await browser.close()

  if (consoleErrors.length) {
    console.warn('⚠ page console errors:\n  ' + consoleErrors.join('\n  '))
  }
  console.log(`✓ captured ${frames.length} frames over ${soakMs}ms+ to ${outDir}`)
  console.log(`FRAME_COUNT=${frames.length}`)
} catch (err) {
  console.error('✗ soak capture failed:', err?.message || err)
  exitCode = 1
} finally {
  if (vite) vite.kill('SIGTERM')
}
process.exit(exitCode)
