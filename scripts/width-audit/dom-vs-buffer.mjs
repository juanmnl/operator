// Diff xterm's rendered DOM against its buffer after INCREMENTAL writes (see
// dom-vs-buffer.ts for why). A mismatch means the DOM renderer left stale text —
// a bug reproducible and fixable headlessly. Zero mismatches means the DOM is
// correct and the app's garble is pixel-level compositing (live-only).
// PREREQ: scripts/width-audit/claude-turn.bin (a captured Claude turn). Then: node this file.
import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { webkit } from 'playwright'
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..')
const port = Number(process.env.OPERATOR_DEV_PORT || '1421')
const url = `http://localhost:${port}/scripts/width-audit/dom-vs-buffer.html`
const wait = (t, ms = 30000) => { const s = Date.now(); return new Promise((res, rej) => { const k = async () => { try { const r = await fetch(t); if (r.ok) return res() } catch { /* not up */ } if (Date.now() - s > ms) return rej(new Error('no vite')); setTimeout(k, 250) }; k() }) }
let vite, code = 0
try {
  vite = spawn('npm', ['run', 'dev'], { cwd: repoRoot, env: { ...process.env, OPERATOR_DEV_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] })
  vite.stderr.on('data', d => process.stderr.write(`[vite] ${d}`))
  await wait(url)
  const browser = await webkit.launch()
  const page = await browser.newPage({ deviceScaleFactor: 2, colorScheme: 'dark' })
  page.on('pageerror', e => console.error('[page]', String(e)))
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForFunction('window.__domCheckReady === true', { timeout: 30000 })
  const R = await page.evaluate('window.__domCheck')
  await page.locator('#term').screenshot({ path: resolve(__dirname, 'out', 'dom-vs-buffer.png') })
  await browser.close()
  console.log(`\n── DOM vs BUFFER after incremental writes (cols=${R.cols}) ──`)
  console.log(`   rows checked: ${R.rowsChecked}   row elements found: ${R.rowElsFound}`)
  console.log(`   MISMATCHED rows (DOM text ≠ buffer text): ${R.mismatches.length}\n`)
  for (const m of R.mismatches) {
    console.log(`   ✗ row ${m.row}`)
    console.log(`       buffer |${m.buffer}|`)
    console.log(`       dom    |${m.dom}|`)
  }
  if (!R.mismatches.length) {
    console.log('   ✓ every rendered row matches the buffer → the DOM renderer is NOT leaving')
    console.log('     stale text. Any garble in the app is pixel compositing (live-only).\n')
  }
} catch (e) { console.error('✗', e?.message || e); code = 1 } finally { if (vite) vite.kill('SIGTERM') }
process.exit(code)
