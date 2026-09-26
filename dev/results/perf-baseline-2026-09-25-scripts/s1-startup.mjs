import { chromium, BASE, med, r, open, metrics } from './lib.mjs'
const b = await chromium.launch()
const rows = []
for (let i = 0; i < 8; i++) {
  const { ctx, p, cdp } = await open(b, 'mock-min', { init: `
    window.__lt = []; try { new PerformanceObserver(l => l.getEntries().forEach(e => __lt.push([e.startTime|0, e.duration|0]))).observe({type:'longtask', buffered:true}) } catch {}
    window.__firstXterm = 0; new MutationObserver(() => { if (!__firstXterm && document.querySelector('.xterm-screen')) __firstXterm = performance.now() }).observe(document, {childList:true, subtree:true})
  ` })
  await p.goto(`${BASE}/mock-min/dev/mock.html`, { waitUntil: 'load' })
  await p.waitForTimeout(3500)
  const m = await metrics(cdp)
  const t = await p.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0]
    const fcp = performance.getEntriesByName('first-contentful-paint')[0]
    const res = performance.getEntriesByType('resource')
    return { dcl: nav.domContentLoadedEventEnd, load: nav.loadEventEnd, fcp: fcp?.startTime, firstXterm: __firstXterm,
      lt: __lt, bytes: res.reduce((a, e) => a + e.encodedBodySize, 0), nres: res.length, nodes: document.getElementsByTagName('*').length }
  })
  rows.push({ ...t, script: m.ScriptDuration * 1000, task: m.TaskDuration * 1000, layout: m.LayoutDuration * 1000, style: m.RecalcStyleDuration * 1000, heap: m.JSHeapUsedSize / 1048576 })
  await ctx.close()
}
const k = (f) => r(med(rows.map(f)))
console.log('runs', rows.length)
console.log('FCP ms', k(x => x.fcp), 'firstXterm ms', k(x => x.firstXterm), 'DCL', k(x => x.dcl), 'load', k(x => x.load))
console.log('script ms (to 3.5s)', k(x => x.script), 'task', k(x => x.task), 'layout', k(x => x.layout), 'style', k(x => x.style))
console.log('heap MB', k(x => x.heap), 'nodes', k(x => x.nodes), 'bytes', rows[0].bytes, 'resources', rows[0].nres)
console.log('longtasks run0', JSON.stringify(rows[0].lt), 'max longtask across runs', Math.max(...rows.flatMap(x => x.lt.map(l => l[1]))), 'count/run', med(rows.map(x => x.lt.length)))
console.log('all fcp', rows.map(x => r(x.fcp)).join(','), 'xterm', rows.map(x => r(x.firstXterm)).join(','))
await b.close()
