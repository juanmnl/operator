import { chromium, med, pct, r, open } from './lib.mjs'
const b = await chromium.launch()
const HOOK = `
 window.__rd = []; window.__on = false;
 window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, renderers: new Map(), inject(rn) { this.renderers.set(1, rn); return 1 }, onCommitFiberRoot(id, root) { if (__on) __rd.push(root.current.actualDuration) }, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {}, isDisabled: false };
 let op; Object.defineProperty(window, 'operator', { configurable: true, get() { return op }, set(v) { op = new Proxy(v, { get(t, k) { if (k === 'onSessionUpdate') return (cb) => { window.__sessCb = cb; return t.onSessionUpdate(cb) } ; return t[k] } }) } });`
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } }); const p = await ctx.newPage(); await p.addInitScript(HOOK)
await p.goto('http://localhost:1428/dev/mock.html'); await p.waitForTimeout(6000)
const go = async (label, secs, setup) => { await p.evaluate(() => { __rd.length = 0; __on = true }); if (setup) await setup(); await p.waitForTimeout(secs * 1000); await p.evaluate(() => { __on = false; clearInterval(window.__t) }); const d = await p.evaluate(() => __rd.filter(x => x != null)); console.log(label, `commits ${d.length} (${r(d.length / secs)}/s) render ms per commit: median ${r(med(d), 2)} p95 ${r(pct(d, .95), 2)} max ${r(Math.max(0, ...d), 2)} ; total ${r(d.reduce((a, b) => a + b, 0) / secs, 1)} ms/s`) }
await go('[DEV BUILD] idle', 12)
await p.evaluate(async () => { const base = await window.operator.getSessions(); const msgs = Array.from({ length: 80 }, (_, i) => ({ kind: 'text', text: 'narration entry ' + i + ' ' + 'lorem ipsum dolor sit amet '.repeat(24), timestamp: new Date().toISOString() })); const all = []; for (let i = 0; i < 15; i++) { const s = JSON.parse(JSON.stringify(base[i % base.length])); if (i >= base.length) { s.id = 'clone-' + i; s.terminalId = null } s.messages = msgs; all.push(s) } window.__all = all })
await go('[DEV BUILD] sessions push 1Hz, 15 sessions fresh identities', 12, () => p.evaluate(() => { window.__t = setInterval(() => __sessCb(JSON.parse(JSON.stringify(__all))), 1000) }))
await b.close()
