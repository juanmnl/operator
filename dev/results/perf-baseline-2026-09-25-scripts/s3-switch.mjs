import { chromium, BASE, med, pct, r, open, metrics, chunkSrc } from './lib.mjs'
const b = await chromium.launch()
const { p, cdp } = await open(b, 'mock-min', { init: `window.__lat=[]; window.__lt=[];
 new PerformanceObserver(l => l.getEntries().forEach(e => __lt.push(e.duration))).observe({type:'longtask'});
 const hook = (ev) => addEventListener(ev, (e) => { const t0 = e.timeStamp; requestAnimationFrame(() => requestAnimationFrame(() => __lat.push([ev, performance.now() - t0]))) }, true);
 hook('keydown'); hook('click');` })
await p.goto(`${BASE}/mock-min/dev/mock.html`); await p.waitForTimeout(3500)
const startStream = (hz, bytes) => p.evaluate(({ src, hz, bytes }) => { let off = 0; window.__timer = setInterval(() => { for (const id of ['t0','t1','t2','t3']) { window.__mockTerminalData(id, src.slice(off % 5000, off % 5000 + bytes)); off += bytes } }, 1000 / hz) }, { src: chunkSrc, hz, bytes })
const stopStream = () => p.evaluate(() => clearInterval(__timer))
const run = async (label, acts, n = 20) => {
  await p.evaluate(() => { __lat.length = 0; __lt.length = 0 })
  for (let i = 0; i < n; i++) { for (const a of acts) { await a(i); await p.waitForTimeout(250) } }
  const lat = (await p.evaluate(() => __lat.map(x => x[1]))); const lt = await p.evaluate(() => __lt)
  console.log(label, `n=${lat.length} median ${r(med(lat))}ms p95 ${r(pct(lat,.95))}ms max ${r(Math.max(...lat))}ms | longtasks ${lt.length} max ${r(Math.max(0,...lt))}ms`)
}
const key = (k) => () => p.keyboard.press(k)
const clickName = (n) => () => p.getByRole('button', { name: n }).first().click()
const laneKeys = [key('Meta+1'), key('Meta+2'), key('Meta+3')]
for (const stream of [false, true]) {
  if (stream) await startStream(60, 2048)
  const tag = stream ? ' [4 lanes streaming 60Hz x 2KB]' : ' [idle]'
  await run('lane switch Meta+1/2/3' + tag, laneKeys, 20)
  await run('project switch operator<->el-encanto' + tag, [clickName(/el-encanto — /), clickName(/^operator — /)], 15)
  await run('Console <-> Terminal toggle' + tag, [clickName('Console'), clickName('Terminal')], 15)
  if (stream) await stopStream()
}
await p.screenshot({ path: 'shot-switch.png' })
console.log('active xterm count', await p.evaluate(() => document.querySelectorAll('.xterm').length))
await b.close()
