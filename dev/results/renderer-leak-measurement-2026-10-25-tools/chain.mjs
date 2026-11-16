import { load, index, nodeName, nodeType, selfSize } from './heap.mjs'
const s = index(load(process.argv[2]))
const par = new Int32Array(s.nodeCount).fill(-1), pe = new Int32Array(s.nodeCount).fill(-1), q = new Int32Array(s.nodeCount)
let h = 0, t = 0; q[t++] = 0; par[0] = 0
while (h < t) { const n = q[h++]; for (let e = s.firstEdge[n]; e < s.firstEdge[n + 1]; e++) { if (!s.essential(s.edges[e * s.EF + s.ef.type])) continue; const to = s.edges[e * s.EF + s.ef.to_node] / s.NF; if (par[to] === -1) { par[to] = n; pe[to] = e; q[t++] = to } } }
const edgeName = (e) => { const ty = s.edgeTypes[s.edges[e * s.EF + s.ef.type]]; const nm = s.edges[e * s.EF + s.ef.name_or_index]; return ty === 'element' || ty === 'hidden' ? `[${nm}]` : `${s.strings[nm]}` }
// pick the session object with the longest path
let best = -1, bl = 0, depthHist = new Map()
for (let n = 0; n < s.nodeCount; n++) {
  if (s.post[n] < 0) continue
  const names = new Set()
  for (let e = s.firstEdge[n]; e < s.firstEdge[n + 1]; e++) { if (s.edgeTypes[s.edges[e * s.EF + s.ef.type]] === 'property') names.add(s.strings[s.edges[e * s.EF + s.ef.name_or_index]]) }
  if (!(names.has('workingDirectory') && names.has('activity') && names.has('messages'))) continue
  let c = n, d = 0; while (c !== 0 && d < 5000) { c = par[c]; d++ }
  depthHist.set(Math.floor(d / 50) * 50, (depthHist.get(Math.floor(d / 50) * 50) || 0) + 1)
  if (d > bl) { bl = d; best = n }
}
console.log('path length hist (bucket of 50 hops):', [...depthHist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join(' '))
console.log('longest path', bl)
let c = best; const p = []
while (c !== 0) { const e = pe[c]; p.push(`${edgeName(e)} <- ${nodeType(s, par[c]).slice(0, 8)} ${nodeName(s, par[c]).slice(0, 40)}`); c = par[c] }
console.log('FIRST 12 hops from the session object:'); console.log(p.slice(0, 12).join('\n'))
console.log('LAST 14 hops (toward GC roots):'); console.log(p.slice(-14).join('\n'))
// find the closure at the chain's top: print the closure node names along the path
const clo = []; c = best; while (c !== 0) { if (nodeType(s, c) === 'closure') clo.push(nodeName(s, c) || '(anon)'); c = par[c] }
const cnt = new Map(); for (const x of clo) cnt.set(x, (cnt.get(x) || 0) + 1)
console.log('closure names on the longest path:', [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8))
