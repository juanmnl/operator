// THROWAWAY perf capturer (dev/webgl-terminal-in-wkwebview.md).
//   node scripts/width-audit/dom-perf.mjs [--loops N]
import { spawn } from 'node:child_process'
import { webkit } from 'playwright'
const port = Number(process.env.OPERATOR_DEV_PORT || '1421')
const args = process.argv.slice(2)
const loopsIdx = args.indexOf('--loops')
const loops = loopsIdx >= 0 ? args[loopsIdx + 1] : '200'
const url = `http://localhost:${port}/scripts/width-audit/dom-perf.html?loops=${loops}`
const wait = (t, ms = 30000) => { const s = Date.now(); return new Promise((res, rej) => { const k = async () => { try { const r = await fetch(t); if (r.ok) return res() } catch { /* not up */ } if (Date.now() - s > ms) return rej(new Error('no vite')); setTimeout(k, 250) }; k() }) }
let vite, code = 0
try {
  vite = spawn('npm', ['run', 'dev'], { cwd: '/Users/juanmnl/Developer/operator', env: { ...process.env, OPERATOR_DEV_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] })
  vite.stderr.on('data', d => process.stderr.write(`[vite] ${d}`))
  await wait(`http://localhost:${port}/scripts/width-audit/dom-perf.html`)
  const browser = await webkit.launch()
  const page = await browser.newPage({ deviceScaleFactor: 2, colorScheme: 'dark' })
  page.on('pageerror', e => console.error('[page]', String(e)))
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForFunction('window.__perfReady === true', { timeout: 180000 })
  const R = await page.evaluate('window.__perf')
  await browser.close()
  console.log(`\n── DOM renderer perf (${R.loops} loops of a real captured turn, ${R.totalChars} chars) ──`)
  console.log(`   idle rAF rate:        ${R.idleFps} fps`)
  console.log(`   during heavy write:   ${R.writeFps} fps   (${R.writeMs}ms wall, ${R.charsPerSec} chars/sec)`)
  console.log(`   during scroll-fling:  ${R.flingFps} fps   (${R.flingMs}ms wall, over ${R.scrollbackLines} scrollback lines)`)
} catch (e) { console.error('✗', e?.message || e); code = 1 } finally { if (vite) vite.kill('SIGTERM') }
process.exit(code)
