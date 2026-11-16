import { load, index, selfSize, classKey } from './heap.mjs'
const [fa, fb] = process.argv.slice(2)
const agg = (s) => { const m = new Map(); for (let n = 0; n < s.nodeCount; n++) { if (s.post[n] < 0) continue; const k = classKey(s, n); let r = m.get(k); if (!r) m.set(k, (r = { c: 0, s: 0 })); r.c++; r.s += selfSize(s, n) } return m }
const A = agg(index(load(fa))), B = agg(index(load(fb)))
const rows = []; for (const [k, a] of A) { const b = B.get(k) ?? { c: 0, s: 0 }; rows.push([k, a.c, b.c, b.s - a.s]) }
rows.sort((x, y) => x[3] - y[3])
for (const r of rows.slice(0, 12)) console.log(String(r[3]).padStart(10), r[1], '->', r[2], r[0].slice(0, 90))
