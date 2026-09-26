import { createRequire } from 'node:module'
import fs from 'node:fs'
const require = createRequire('/Users/juanmnl/Developer/operator/package.json')
export const { chromium } = require('playwright')
export const BASE = 'http://localhost:1429'
export const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
export const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))] }
export const r = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d
export const chunkSrc = fs.readFileSync('/Users/juanmnl/Developer/operator/scripts/width-audit/claude-stream.bin').toString('utf8')
export async function open(browser, build = 'mock-min', { init } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const p = await ctx.newPage()
  const errs = []
  p.on('pageerror', (e) => errs.push(String(e).slice(0, 80)))
  if (init) await p.addInitScript(init)
  const cdp = await ctx.newCDPSession(p)
  await cdp.send('Performance.enable', { timeDomain: 'timeTicks' })
  return { ctx, p, cdp, errs, url: `${BASE}/${build}/dev/mock.html` }
}
export async function metrics(cdp) {
  const { metrics: m } = await cdp.send('Performance.getMetrics')
  return Object.fromEntries(m.map((x) => [x.name, x.value]))
}
export async function gc(cdp) { await cdp.send('HeapProfiler.enable'); await cdp.send('HeapProfiler.collectGarbage') }
