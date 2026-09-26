import { chromium, BASE, med, r, open, metrics, chunkSrc } from './lib.mjs'
const b = await chromium.launch()
const HOOK = `
 window.__rc = { commits: 0, comps: {}, on: false };
 const T = { 0:1, 11:1, 14:1, 15:1 };
 const nameOf = (f) => { const t = f.type; return t && (t.displayName || t.name || (t.type && (t.type.displayName || t.type.name)) || (t.render && t.render.name)) || 'anon' };
 const walk = (f) => { while (f) { if (T[f.tag] && (f.alternate === null || (f.flags & 1))) { const n = nameOf(f); __rc.comps[n] = (__rc.comps[n] || 0) + 1 } if (f.child) walk(f.child); f = f.sibling } };
 window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, renderers: new Map(), inject(rn) { this.renderers.set(1, rn); return 1 }, onCommitFiberRoot(id, root) { if (!__rc.on) return; __rc.commits++; walk(root.current) }, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {}, isDisabled: false };
 // capture the session subscription so we can push fresh-identity payloads like main does
 let op; Object.defineProperty(window, 'operator', { configurable: true, get() { return op }, set(v) { op = new Proxy(v, { get(t, k) { if (k === 'onSessionUpdate') return (cb) => { window.__sessCb = cb; return t.onSessionUpdate(cb) } ; return t[k] } }) } });
`
const { p } = await open(b, 'mock-nomin', { init: HOOK })
await p.goto(`${BASE}/mock-nomin/dev/mock.html`); await p.waitForTimeout(4000)
const measure = async (label, secs, setup) => {
  await p.evaluate(() => { __rc.commits = 0; __rc.comps = {}; __rc.on = true })
  const stop = setup ? await setup() : null
  await p.waitForTimeout(secs * 1000)
  if (stop) await p.evaluate(stop)
  const res = await p.evaluate(() => { __rc.on = false; return { c: __rc.commits, comps: Object.entries(__rc.comps).sort((a, b) => b[1] - a[1]).slice(0, 14), total: Object.values(__rc.comps).reduce((a, b) => a + b, 0) } })
  console.log(`\n${label}: ${r(res.c / secs)} commits/s, ${r(res.total / secs)} component renders/s`)
  console.log(res.comps.map(([n, v]) => `  ${n}: ${r(v / secs)}/s`).join('\n'))
}
await measure('IDLE (mock: 4 lanes, 2 running/compacting)', 10)
await measure('STREAM 4 lanes 20Hz x 1KB', 10, async () => { await p.evaluate(({ src }) => { let off = 0; window.__t = setInterval(() => { for (const id of ['t0','t1','t2','t3']) { window.__mockTerminalData(id, src.slice(off % 5000, off % 5000 + 1024)); off += 1024 } }, 50) }, { src: chunkSrc }); return '() => clearInterval(__t)' })
// sessions push: 15 sessions x 80 narration, fresh identities every second (what main does)
await p.evaluate(async () => {
  const base = await window.operator.getSessions()
  const msgs = Array.from({ length: 80 }, (_, i) => ({ kind: 'text', text: 'narration entry ' + i + ' ' + 'lorem ipsum dolor sit amet '.repeat(24), timestamp: new Date().toISOString() }))
  const all = []; for (let i = 0; i < 15; i++) { const s = JSON.parse(JSON.stringify(base[i % base.length])); if (i >= base.length) { s.id = 'clone-' + i; s.terminalId = null }; s.messages = msgs; all.push(s) }
  window.__all = all; window.__bytes = JSON.stringify(all).length
})
console.log('\nsessions payload bytes', await p.evaluate(() => __bytes))
await measure('SESSIONS PUSH 1 Hz, 15 sessions x 80 narration, fresh object identities, nothing changed', 10, async () => { await p.evaluate(() => { window.__t = setInterval(() => __sessCb(JSON.parse(JSON.stringify(__all))), 1000) }); return '() => clearInterval(__t)' })
await b.close()
