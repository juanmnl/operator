// usage: node analyze.mjs <A.heapsnapshot> <B.heapsnapshot> <out.json> [scriptmap.json]
// A = earlier snapshot, B = later. Writes a JSON report; also prints a short text summary.
import { load, index, nodeName, nodeType, nodeId, selfSize, classKey } from './heap.mjs'
import { loadMap } from './sourcemap.mjs'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
const S = '/private/tmp/claude-501/-Users-juanmnl-Developer-operator/b15ab04d-e9c2-43be-bcb2-39a423679c9a/scratchpad'
const [fa, fb, out, sm] = process.argv.slice(2)
const t0 = Date.now(); const lap = (m) => console.error(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)
const A = index(load(fa)); lap(`A loaded: ${A.nodeCount} nodes, reachable ${A.reach}`)
const B = index(load(fb)); lap(`B loaded: ${B.nodeCount} nodes, reachable ${B.reach}`)

function aggregate(s) {
  const m = new Map()
  for (let n = 0; n < s.nodeCount; n++) {
    if (s.post[n] < 0) continue
    const k = classKey(s, n)
    let r = m.get(k); if (!r) m.set(k, (r = { count: 0, self: 0, retained: 0 }))
    r.count++; r.self += selfSize(s, n)
    const d = s.order[s.idom[s.post[n]]]
    if (n === 0 || classKey(s, d) !== k) r.retained += s.retained[n]     // skip objects dominated by one of the same class
  }
  return m
}
const ga = aggregate(A), gb = aggregate(B); lap('aggregated')
const rows = []
for (const [k, b] of gb) { const a = ga.get(k) ?? { count: 0, self: 0, retained: 0 }; rows.push({ key: k, countA: a.count, countB: b.count, dCount: b.count - a.count, selfA: a.self, selfB: b.self, dSelf: b.self - a.self, retA: a.retained, retB: b.retained, dRet: b.retained - a.retained }) }
const topSelf = [...rows].sort((x, y) => y.dSelf - x.dSelf).slice(0, 40)
const topRet = [...rows].sort((x, y) => y.dRet - x.dRet).slice(0, 40)
const topCount = [...rows].sort((x, y) => y.dCount - x.dCount).slice(0, 40)

const newCount = 0, newSelf = 0, topNew = []   // object ids are not stable across snapshots without heap-object tracking; see signature diff below
// Shortest retaining path from the root (BFS over essential edges).
function bfs(s) {
  const par = new Int32Array(s.nodeCount).fill(-1), pe = new Int32Array(s.nodeCount).fill(-1), q = new Int32Array(s.nodeCount)
  let h = 0, t = 0; q[t++] = 0; par[0] = 0
  while (h < t) { const n = q[h++]; for (let e = s.firstEdge[n]; e < s.firstEdge[n + 1]; e++) { if (!s.essential(s.edges[e * s.EF + s.ef.type])) continue; const to = s.edges[e * s.EF + s.ef.to_node] / s.NF; if (par[to] === -1) { par[to] = n; pe[to] = e; q[t++] = to } } }
  return { par, pe }
}
const bf = bfs(B), bfA = bfs(A)
const smaps = sm ? JSON.parse(readFileSync(sm, 'utf8')) : {}
const maps = {}
for (const f of readdirSync(`${S}/wt/electron/out/renderer/assets`)) if (f.endsWith('.js.map')) maps[f.replace('.map', '')] = loadMap(`${S}/wt/electron/out/renderer/assets/${f}`)
function loc(s, n) {                                    // source location of a function-ish node, if the snapshot has one
  if (!s.locIdx) { s.locIdx = new Map(); for (let i = 0; i + 3 < s.locations.length; i += 4) s.locIdx.set(s.locations[i] / s.NF, [s.locations[i + 1], s.locations[i + 2], s.locations[i + 3]]) }
  const l = s.locIdx.get(n); if (!l) return null
  const url = smaps[String(l[0])] ?? ''; const file = url.split('/').pop()
  const m = maps[file]; return { script: file || `script#${l[0]}`, line: l[1] + 1, col: l[2] + 1, src: m ? m.lookup(l[1], l[2]) : null }
}
const edgeLabel = (s, e) => { const et = s.edgeTypes[s.edges[e * s.EF + s.ef.type]]; const v = s.edges[e * s.EF + s.ef.name_or_index]; return (et === 'element' || et === 'hidden') ? `[${v}]` : `${s.strings[v]}` + (et === 'context' ? ' (ctx)' : et === 'internal' ? ' (int)' : '') }
function pathTo(s, n) {
  const hops = []; let cur = n, guard = 0
  while (cur !== 0 && guard++ < 60) { const e = bf.pe[cur]; hops.push({ node: `${nodeType(s, cur)} ${nodeName(s, cur)}`.slice(0, 70), via: edgeLabel(s, e), self: selfSize(s, cur), loc: loc(s, cur) }); cur = bf.par[cur] }
  return hops.reverse()
}
// Where the growth lives: per growing class, group instances by the first hops of their retaining path, in A and in B.
const growerKeys = [...new Set([...topSelf.slice(0, 10).map((r) => r.key), ...topRet.slice(0, 6).map((r) => r.key), ...topCount.slice(0, 4).map((r) => r.key)])].filter((k) => !/^\((compiled code|object shape|number|array)\)$|^\(synthetic\)|^\(hidden\)/.test(k)).slice(0, 12)
const hopLabel = (s, e, p) => `${edgeLabel(s, e)} <- ${classKey(s, p)}`.replace(/\[\d+\]/g, '[]').replace(/ ?@\d+/g, '').replace(/system \/ Context \/ scope/g, 'Context').slice(0, 90)
function signatures(s, b, key) {
  const m = new Map()
  for (let n = 0; n < s.nodeCount; n++) {
    if (s.post[n] < 0 || classKey(s, n) !== key) continue
    const hops = []; let cur = n, g = 0
    while (cur !== 0 && hops.length < 4 && g++ < 40) { const e = b.pe[cur], p = b.par[cur]; const l = hopLabel(s, e, p); if (hops[hops.length - 1] !== l) hops.push(l); cur = p }
    const sig = hops.join('  |  ')
    const r = m.get(sig) ?? { count: 0, self: 0, ex: n, exRet: -1 }
    r.count++; r.self += selfSize(s, n); if (s.retained[n] > r.exRet) { r.exRet = s.retained[n]; r.ex = n }
    m.set(sig, r)
  }
  return m
}
const retainers = []
for (const key of growerKeys) {
  const sa = signatures(A, bfA, key), sb = signatures(B, bf, key)
  const sigRows = [...sb].map(([sig, r]) => { const a = sa.get(sig); return { sig, countA: a?.count ?? 0, countB: r.count, dCount: r.count - (a?.count ?? 0), selfB: r.self, dSelf: r.self - (a?.self ?? 0), exRetained: r.exRet, exLoc: loc(B, r.ex), path: null, _ex: r.ex } }).sort((x, y) => y.dSelf - x.dSelf).slice(0, 4)
  for (const r of sigRows) { r.path = pathTo(B, r._ex); delete r._ex }
  const g = rows.find((x) => x.key === key)
  retainers.push({ key, countA: g.countA, countB: g.countB, dSelf: g.dSelf, dRet: g.dRet, signatures: sigRows })
}
lap('retainer paths')

// Strings: biggest, and duplicates (identical content share one strings-table index).
const strSizes = new Map()
for (let n = 0; n < B.nodeCount; n++) { if (B.post[n] < 0) continue; const t = nodeType(B, n); if (t !== 'string' && t !== 'concatenated string') continue; const idx = B.nodes[n * B.NF + B.f.name]; const r = strSizes.get(idx) ?? { count: 0, bytes: 0, maxRet: 0 }; r.count++; r.bytes += selfSize(B, n); r.maxRet = Math.max(r.maxRet, B.retained[n]); strSizes.set(idx, r) }
const strRows = [...strSizes].map(([idx, r]) => ({ len: B.strings[idx].length, head: B.strings[idx].slice(0, 90).replace(/\s+/g, ' '), ...r })).sort((x, y) => y.bytes - x.bytes)
const bigStrings = strRows.slice(0, 25)
const dupStrings = [...strRows].filter((r) => r.count > 1).sort((x, y) => (y.count - 1) * y.len - (x.count - 1) * x.len).slice(0, 15)
const persisted = strRows.filter((r) => /^\s*[\[{]\s*\{?\s*"(id|sessions?|claudeSessionId|projects?|roster|key)"/.test(r.head) || /claudeSessionId|"roster"/.test(r.head)).slice(0, 15)
const sumByType = (s) => { const m = {}; for (let n = 0; n < s.nodeCount; n++) { if (s.post[n] < 0) continue; const t = nodeType(s, n); m[t] = (m[t] ?? 0) + selfSize(s, n) } return m }
const summary = { A: { file: fa, nodes: A.nodeCount, reachable: A.reach, totalSelf: Object.values(sumByType(A)).reduce((x, y) => x + y, 0), byType: sumByType(A) }, B: { file: fb, nodes: B.nodeCount, reachable: B.reach, totalSelf: Object.values(sumByType(B)).reduce((x, y) => x + y, 0), byType: sumByType(B) }, newObjects: { count: newCount, selfBytes: newSelf } }
writeFileSync(out, JSON.stringify({ summary, topSelf, topRet, topCount, topNew, retainers, bigStrings, dupStrings, persisted }, null, 1))
const MB = (x) => (x / 1048576).toFixed(2)
console.log(`A ${MB(summary.A.totalSelf)} MB (${A.reach} reachable) -> B ${MB(summary.B.totalSelf)} MB (${B.reach}); new objects ${newCount} = ${MB(newSelf)} MB`)
console.log('top growth by self size:'); for (const r of topSelf.slice(0, 12)) console.log(`  ${r.key.padEnd(44)} ${String(r.countA).padStart(8)} -> ${String(r.countB).padStart(8)}  self ${MB(r.dSelf).padStart(8)} MB  retained ${MB(r.dRet).padStart(8)} MB`)
console.log('persisted-state-looking strings in B:', persisted.length, persisted.slice(0, 3).map((p) => `${p.len} chars x${p.count} "${p.head.slice(0, 50)}"`))
