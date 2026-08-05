// THROWAWAY spike (2026-08-04 terminal-research-v2) — captures renderer-spike.html under
// Playwright WebKit for dom/webgl/canvas, to see if today's WebGL/canvas addons render
// Claude's in-place status-redraw pattern cleanly. NOT product code; delete after the
// research brief is answered.
import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { webkit } from 'playwright'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..')
const port = Number(process.env.OPERATOR_DEV_PORT || '1438')
const outDir = resolve(__dirname, 'out')
mkdirSync(outDir, { recursive: true })

const wait = (t, ms = 30000) => {
  const s = Date.now()
  return new Promise((res, rej) => {
    const k = async () => {
      try { const r = await fetch(t); if (r.ok) return res() } catch { /* not up */ }
      if (Date.now() - s > ms) return rej(new Error('no vite'))
      setTimeout(k, 250)
    }
    k()
  })
}

let vite
let code = 0
try {
  vite = spawn('npm', ['run', 'dev'], { cwd: repoRoot, env: { ...process.env, OPERATOR_DEV_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] })
  vite.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`))
  const baseUrl = `http://localhost:${port}/scripts/width-audit/renderer-spike.html`
  await wait(baseUrl + '?renderer=dom')

  const browser = await webkit.launch()
  for (const renderer of ['dom', 'webgl', 'canvas']) {
    const page = await browser.newPage({ deviceScaleFactor: 2, colorScheme: 'dark' })
    const consoleMsgs = []
    page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`))
    page.on('pageerror', (e) => consoleMsgs.push(`[pageerror] ${String(e)}`))
    await page.goto(`${baseUrl}?renderer=${renderer}`, { waitUntil: 'load' })
    try {
      await page.waitForFunction('window.__rendererSpikeReady === true', { timeout: 10000 })
      const mode = await page.evaluate('window.__rendererSpikeMode')
      await page.locator('#term').screenshot({ path: resolve(outDir, `renderer-spike-${renderer}.png`) })
      console.log(`\n== ${renderer} == mode reported: ${mode}`)
    } catch (e) {
      console.log(`\n== ${renderer} == FAILED TO SETTLE: ${e.message}`)
    }
    if (consoleMsgs.length) console.log('   console:\n   ' + consoleMsgs.join('\n   '))
    await page.close()
  }
  await browser.close()
  console.log(`\n✓ screenshots in ${outDir}/renderer-spike-{dom,webgl,canvas}.png`)
} catch (err) {
  console.error('✗ renderer spike failed:', err?.message || err)
  code = 1
} finally {
  if (vite) vite.kill('SIGTERM')
}
process.exit(code)
