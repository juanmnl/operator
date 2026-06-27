// Visual-verification capturer. Boots the real Vite dev server, loads the xterm
// glyph harness in a headless WebKit (Playwright's WebKit build — the SAME engine
// family as the app's WKWebView, so font fallback / `font-variant-emoji: text`
// behave like production, unlike Chromium), and screenshots the terminal.
//
// This is the GUI-verification path the env otherwise lacks: no AX / input
// simulation needed — it renders a deterministic page and saves a PNG to read.
//
//   node scripts/visual/capture.mjs [--out <path>] [--port <n>]
//
// Default out: scripts/visual/out/terminal.png  (git-ignored)
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
const port = Number(getArg('--port', process.env.OPERATOR_DEV_PORT || '1421'))
const outPath = resolve(repoRoot, getArg('--out', 'scripts/visual/out/terminal.png'))
const url = `http://localhost:${port}/scripts/visual/index.html`

mkdirSync(dirname(outPath), { recursive: true })

function waitForServer(targetUrl, timeoutMs = 30000) {
  const start = Date.now()
  return new Promise((res, rej) => {
    const tick = async () => {
      try {
        const r = await fetch(targetUrl)
        if (r.ok) return res()
      } catch {
        /* not up yet */
      }
      if (Date.now() - start > timeoutMs) return rej(new Error(`Vite not ready at ${targetUrl}`))
      setTimeout(tick, 250)
    }
    tick()
  })
}

let vite
let exitCode = 0
try {
  // Bind Vite to our port via OPERATOR_DEV_PORT (vite.config.ts reads it).
  vite = spawn('npm', ['run', 'dev'], {
    cwd: repoRoot,
    env: { ...process.env, OPERATOR_DEV_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  vite.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`))

  await waitForServer(url)

  const browser = await webkit.launch()
  const page = await browser.newPage({ deviceScaleFactor: 2, colorScheme: 'dark' })
  const consoleErrors = []
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
  page.on('pageerror', (e) => consoleErrors.push(String(e)))

  await page.goto(url, { waitUntil: 'load' })
  await page.waitForFunction('window.__visualReady === true', { timeout: 15000 })

  const term = page.locator('#term')
  await term.screenshot({ path: outPath })
  await browser.close()

  if (consoleErrors.length) {
    console.warn('⚠ page console errors:\n  ' + consoleErrors.join('\n  '))
  }
  console.log(`✓ wrote ${outPath}`)
} catch (err) {
  console.error('✗ visual capture failed:', err?.message || err)
  exitCode = 1
} finally {
  if (vite) vite.kill('SIGTERM')
}
process.exit(exitCode)
