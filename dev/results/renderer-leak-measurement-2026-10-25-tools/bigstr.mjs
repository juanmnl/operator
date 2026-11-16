import { load, index, nodeName, nodeType, nodeId, selfSize, classKey } from './heap.mjs'
const [f] = process.argv.slice(2)
const s = index(load(f))
// BFS shortest path from root
const par = new Int32Array(s.nodeCount).fill(-1), pe = new Int32Array(s.nodeCount).fill(-1), q = new Int32Array(s.nodeCount)
let h = 0, t = 0; q[t++] = 0; par[0] = 0
while (h < t) { const n = q[h++]; for (let e = s.firstEdge[n]; e < s.firstEdge[n + 1]; e++) { if (!s.essential(s.edges[e * s.EF + s.ef.type])) continue; const to = s.edges[e * s.EF + s.ef.to_node] / s.NF; if (par[to] === -1) { par[to] = n; pe[to] = e; q[t++] = to } } }
const edgeName = (e) => { const ty = s.edgeTypes[s.edges[e * s.EF + s.ef.type]]; const nm = s.edges[e * s.EF + s.ef.name_or_index]; return ty === 'element' || ty === 'hidden' ? `[${nm}] (${ty})` : `${s.strings[nm]} (${ty})` }
const big = []
for (let n = 0; n < s.nodeCount; n++) if (s.post[n] >= 0 && selfSize(s, n) > 500000 && /string/.test(nodeType(s, n))) big.push(n)
for (const n of big) {
  console.log('STRING self', selfSize(s, n), 'retained', s.retained[n], 'head', nodeName(s, n).slice(0, 60))
  let c = n; const path = []
  while (c !== 0 && path.length < 14) { const e = pe[c]; path.push(`${edgeName(e)} <- ${nodeType(s, par[c])} ${nodeName(s, par[c]).slice(0, 50)} (self ${selfSize(s, par[c])})`); c = par[c] }
  console.log(path.join('\n'))
}
