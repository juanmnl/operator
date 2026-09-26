import { chromium, BASE, med, pct, r, open, metrics, gc, chunkSrc } from './lib.mjs'
const b = await chromium.launch()
const INIT = `
 window.__cnt = {raf:0, timeout:0, interval:0, byfn:{}};
 const oraf = window.requestAnimationFrame; window.requestAnimationFrame = (cb) => oraf((t) => { __cnt.raf++; cb(t) });
 const ost = window.setTimeout; window.setTimeout = (cb, ms, ...a) => typeof cb !== 'function' ? ost(cb, ms, ...a) : ost(() => { __cnt.timeout++; const k = 'T:'+cb.toString().slice(0,50); __cnt.byfn[k]=(__cnt.byfn[k]||0)+1; cb(...a) }, ms);
 const osi = window.setInterval; window.setInterval = (cb, ms, ...a) => typeof cb !== 'function' ? osi(cb, ms, ...a) : osi(() => { __cnt.interval++; const k = 'I'+ms+':'+cb.toString().slice(0,50); __cnt.byfn[k]=(__cnt.byfn[k]||0)+1; cb(...a) }, ms);
`
async function window_(p, cdp, ms) {
  const m0 = await metrics(cdp); const c0 = await p.evaluate(() => JSON.parse(JSON.stringify(__cnt)))
  const t0 = Date.now(); await p.waitForTimeout(ms); const dt = (Date.now() - t0) / 1000
  const m1 = await metrics(cdp); const c1 = await p.evaluate(() => JSON.parse(JSON.stringify(__cnt)))
  const d = (k) => (m1[k] - m0[k])
  const top = Object.entries(c1.byfn).map(([k, v]) => [k, (v - (c0.byfn[k] || 0)) / dt]).sort((a, b) => b[1] - a[1]).slice(0, 6)
  return { cpuPct: r(100 * d('TaskDuration') / dt), scriptPct: r(100 * d('ScriptDuration') / dt), layoutPct: r(100 * d('LayoutDuration') / dt), stylePct: r(100 * d('RecalcStyleDuration') / dt),
    layouts_s: r(d('LayoutCount') / dt), recalc_s: r(d('RecalcStyleCount') / dt), raf_s: r((c1.raf - c0.raf) / dt), timeouts_s: r((c1.timeout - c0.timeout) / dt), intervals_s: r((c1.interval - c0.interval) / dt), top }
}
const { ctx, p, cdp, errs } = await open(b, 'mock-min', { init: INIT })
await p.goto(`${BASE}/mock-min/dev/mock.html`); await p.waitForTimeout(4000)
console.log('IDLE 20s (4 lanes mounted, 1 visible)', JSON.stringify(await window_(p, cdp, 20000), null, 1))
// streaming: each tick sends ~1 KB chunk to each of 4 lanes
const stream = async (label, perLaneHz, chunkBytes, secs, lanes = ['t0','t1','t2','t3']) => {
  await p.evaluate(({ src, perLaneHz, chunkBytes, lanes }) => {
    let off = 0; window.__sent = 0
    window.__timer = setInterval(() => {
      for (const id of lanes) { const s = src.slice(off % (src.length - chunkBytes), (off % (src.length - chunkBytes)) + chunkBytes); off += chunkBytes; window.__mockTerminalData(id, s); window.__sent += s.length }
    }, 1000 / perLaneHz)
  }, { src: chunkSrc, perLaneHz, chunkBytes, lanes })
  await p.waitForTimeout(1500)
  const w = await window_(p, cdp, secs * 1000)
  const sent = await p.evaluate(() => { clearInterval(__timer); return __sent })
  console.log(label, JSON.stringify({ ...w, sentKB_s: r(sent / 1024 / (secs + 1.5)) }))
  await p.waitForTimeout(1500)
}
await stream('STREAM 4 lanes x 20Hz x 1KB', 20, 1024, 10)
await stream('STREAM 4 lanes x 60Hz x 2KB', 60, 2048, 10)
await stream('STREAM 1 lane (visible only) x 60Hz x 2KB', 60, 2048, 10, ['t0'])
await stream('STREAM 3 hidden lanes only x 60Hz x 2KB', 60, 2048, 10, ['t1','t2','t3'])
console.log('errs', [...new Set(errs)].slice(0,3), 'xterm rows text sample:', (await p.evaluate(() => document.querySelector('.xterm-rows')?.textContent?.slice(0, 80))))
await b.close()
