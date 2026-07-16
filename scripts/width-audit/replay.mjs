// Replay a captured real Claude byte stream through the production xterm and dump the
// resulting BUFFER + a screenshot — the decisive buffer-vs-WKWebView-compositing test.
// PREREQ: run `python3 scripts/width-audit/capture-claude.py` first to produce
// claude-stream.bin (spawns one tiny Claude prompt under a pty). Then: node this file.
import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { webkit } from 'playwright'
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..')
const port = Number(process.env.OPERATOR_DEV_PORT || '1421')
const url = `http://localhost:${port}/scripts/width-audit/replay.html`
const wait = (t, ms=30000) => { const s=Date.now(); return new Promise((res,rej)=>{const k=async()=>{try{const r=await fetch(t);if(r.ok)return res()}catch{}; if(Date.now()-s>ms)return rej(new Error('no vite')); setTimeout(k,250)}; k()}) }
let vite, code=0
try {
  vite = spawn('npm',['run','dev'],{cwd:repoRoot,env:{...process.env,OPERATOR_DEV_PORT:String(port)},stdio:['ignore','pipe','pipe']})
  vite.stderr.on('data',d=>process.stderr.write(`[vite] ${d}`))
  await wait(url)
  const browser = await webkit.launch()
  const page = await browser.newPage({ deviceScaleFactor: 2, colorScheme: 'dark' })
  page.on('pageerror', e => console.error('[page]', String(e)))
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForFunction('window.__replayReady === true', { timeout: 20000 })
  const R = await page.evaluate('window.__replay')
  await page.locator('#term').screenshot({ path: resolve(__dirname, 'out', 'replay.png') })
  await browser.close()
  console.log(`\n── Replay: real Claude stream → production xterm buffer (cols=${R.cols}, ${R.totalRows} rows) ──`)
  console.log(`   GARBLED rows (letter flanking a ─): ${R.garbledCount}\n`)
  for (const r of R.rows) console.log(`   ${String(r.i).padStart(3)}${r.garbled?' ✗':'  '} |${r.text}|`)
  console.log('')
} catch (e) { console.error('✗', e?.message||e); code=1 } finally { if (vite) vite.kill('SIGTERM') }
process.exit(code)
