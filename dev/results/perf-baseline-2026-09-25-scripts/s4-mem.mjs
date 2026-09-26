import { execFileSync } from 'node:child_process'
import { chromium, BASE, med, pct, r, open, metrics, gc, chunkSrc } from './lib.mjs'
const b = await chromium.launch()
const bcdp = await b.newBrowserCDPSession()
const rss = async () => { const { processInfo } = await bcdp.send('SystemInfo.getProcessInfo'); const out = execFileSync('ps', ['-eo', 'pid,rss'], { encoding: 'utf8' }).split('\n').map(l => l.trim().split(/\s+/)); const m = Object.fromEntries(out.map(([a, b]) => [a, +b]))
  let ren = 0, all = 0; for (const pi of processInfo) { const k = (m[pi.id] || 0) / 1024; all += k; if (pi.type === 'renderer') ren = Math.max(ren, k) } return { rendererMB: r(ren, 0), allMB: r(all, 0) } }
const { p, cdp } = await open(b, 'mock-min', { init: `window.__lat=[]; window.__lt=[];
 new PerformanceObserver(l => l.getEntries().forEach(e => __lt.push(e.duration))).observe({type:'longtask'});
 addEventListener('keydown', (e) => { const t0 = e.timeStamp; requestAnimationFrame(() => requestAnimationFrame(() => __lat.push(performance.now() - t0))) }, true);` })
await p.goto(`${BASE}/mock-min/dev/mock.html`); await p.waitForTimeout(3500)
const snap = async (label) => { await gc(cdp); await p.waitForTimeout(500); const m = await metrics(cdp); const d = await cdp.send('Memory.getDOMCounters'); console.log(label, JSON.stringify({ heapMB: r(m.JSHeapUsedSize / 1048576), nodes: d.nodes, listeners: d.jsEventListeners, ...(await rss()) })) }
await snap('baseline')
const fill = (lines) => p.evaluate(async ({ lines }) => {
  const pad = 'the quick brown fox jumps over the lazy dog 0123456789 abcdefghijklmnopqrstuvwxyz ok'
  for (let i = 0; i < lines; i += 200) { let s = ''; for (let j = 0; j < 200; j++) s += `\x1b[38;5;${(i + j) % 200}mline ${i + j} ${pad}\x1b[0m\r\n`; for (const id of ['t0','t1','t2','t3']) window.__mockTerminalData(id, s); await new Promise(r => setTimeout(r, 4)) }
}, { lines })
for (const lines of [2000, 12000, 12000]) { const t = Date.now(); await fill(lines); await p.waitForTimeout(1500); await snap(`+${lines} lines x4 lanes (${Date.now() - t}ms to push)`) }
// switch cost with full buffers
await p.evaluate(() => { __lat.length = 0; __lt.length = 0 })
for (let i = 0; i < 12; i++) { await p.keyboard.press('Meta+' + (1 + i % 3)); await p.waitForTimeout(300) }
const lat = await p.evaluate(() => __lat), lt = await p.evaluate(() => __lt)
console.log('lane switch w/ full 10k-line buffers: n', lat.length, 'median', r(med(lat)), 'p95', r(pct(lat, .95)), 'max', r(Math.max(...lat)), 'longtasks', lt.map(x => r(x, 0)).join(','))
// soak: 300 MB of output at max speed across 4 lanes, snapshot every 100MB
const soak = (mb) => p.evaluate(async ({ mb }) => { const line = '\x1b[32m✓\x1b[0m ' + 'x'.repeat(74) + '\r\n'; const blk = line.repeat(50); let sent = 0; while (sent < mb * 1048576) { for (const id of ['t0','t1','t2','t3']) { window.__mockTerminalData(id, blk); sent += blk.length } await new Promise(r => setTimeout(r, 2)) } return sent }, { mb })
for (let i = 1; i <= 3; i++) { const t = Date.now(); await soak(100); await p.waitForTimeout(2000); await snap(`soak +${i * 100}MB total (${Date.now() - t}ms)`) }
await b.close()
