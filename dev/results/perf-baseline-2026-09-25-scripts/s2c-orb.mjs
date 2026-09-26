import { chromium, BASE, r, metrics } from './lib.mjs'
const b = await chromium.launch()
for (const rm of ['no-preference', 'reduce', 'no-preference', 'reduce']) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: rm }); const p = await ctx.newPage(); const cdp = await ctx.newCDPSession(p); await cdp.send('Performance.enable', { timeDomain: 'timeTicks' })
  await p.goto(`${BASE}/mock-min/dev/mock.html`); await p.waitForTimeout(4000)
  const m0 = await metrics(cdp); await p.waitForTimeout(20000); const m1 = await metrics(cdp)
  const d = (k) => m1[k] - m0[k]
  console.log(rm.padEnd(14), 'main-thread CPU', r(100 * d('TaskDuration') / 20), '%  script', r(100 * d('ScriptDuration') / 20), '%  style recalcs/s', r(d('RecalcStyleCount') / 20), ' layouts/s', r(d('LayoutCount') / 20))
  await ctx.close()
}
await b.close()
