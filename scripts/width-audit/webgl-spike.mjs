// THROWAWAY spike capturer (dev/webgl-terminal-in-wkwebview.md). Boots webgl-spike.html
// (real captured stream, looped, through xterm's WebGL renderer) in Playwright WebKit
// and screenshots the result for visual inspection — WebGL has no accessible DOM text,
// so a screenshot (not a text diff) is the only way to check for corruption here.
//   node scripts/width-audit/webgl-spike.mjs [--loops N]
import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { webkit } from 'playwright'
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..')
const port = Number(process.env.OPERATOR_DEV_PORT || '1421')
const args = process.argv.slice(2)
const loopsIdx = args.indexOf('--loops')
const loops = loopsIdx >= 0 ? args[loopsIdx + 1] : '40'
const renderer = args.includes('--dom') ? 'dom' : 'webgl'
const url = `http://localhost:${port}/scripts/width-audit/webgl-spike.html?loops=${loops}${renderer === 'dom' ? '&renderer=dom' : ''}`
const outBase = renderer === 'dom' ? 'dom-control' : 'webgl-spike'
const wait = (t, ms = 30000) => { const s = Date.now(); return new Promise((res, rej) => { const k = async () => { try { const r = await fetch(t); if (r.ok) return res() } catch { /* not up */ } if (Date.now() - s > ms) return rej(new Error('no vite')); setTimeout(k, 250) }; k() }) }
let vite, code = 0
try {
  vite = spawn('npm', ['run', 'dev'], { cwd: repoRoot, env: { ...process.env, OPERATOR_DEV_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] })
  vite.stderr.on('data', d => process.stderr.write(`[vite] ${d}`))
  await wait(`http://localhost:${port}/scripts/width-audit/webgl-spike.html`)
  const browser = await webkit.launch()
  const page = await browser.newPage({ deviceScaleFactor: 2, colorScheme: 'dark' })
  const consoleErrors = []
  page.on('console', m => m.type() === 'error' && consoleErrors.push(m.text()))
  page.on('pageerror', e => consoleErrors.push(String(e)))
  await page.goto(url, { waitUntil: 'load' })
  const glInfo = await page.evaluate('window.__glInfo')
  await page.waitForFunction('window.__loop1Ready === true', { timeout: 30000 })
  await page.locator('#term').screenshot({ path: resolve(__dirname, 'out', `${outBase}-loop1.png`) })
  await page.waitForFunction('window.__webglSpikeReady === true', { timeout: 120000 })
  const ok = await page.evaluate('window.__webglOk')
  const err = await page.evaluate('window.__webglError')
  const loopsDone = await page.evaluate('window.__loopsDone')
  const atlasInfo = await page.evaluate('window.__atlasInfo()')
  await page.locator('#term').screenshot({ path: resolve(__dirname, 'out', `${outBase}.png`) })
  await browser.close()
  console.log(`\n── WebGL spike (${loops} loops requested, ${loopsDone} completed) ──`)
  console.log(`   WebGL context available in this WebKit: webgl2=${glInfo.webgl2} webgl1=${glInfo.webgl1}`)
  console.log(`   webglOk: ${ok}   error: ${err || '(none)'}`)
  console.log(`   atlas: ${JSON.stringify(atlasInfo)}`)
  console.log(`   screenshot after 1 loop:   scripts/width-audit/out/${outBase}-loop1.png`)
  console.log(`   screenshot after ${loopsDone} loops: scripts/width-audit/out/${outBase}.png`)
  if (consoleErrors.length) console.log(`   console errors:\n     ` + consoleErrors.join('\n     '))
} catch (e) { console.error('✗', e?.message || e); code = 1 } finally { if (vite) vite.kill('SIGTERM') }
process.exit(code)
