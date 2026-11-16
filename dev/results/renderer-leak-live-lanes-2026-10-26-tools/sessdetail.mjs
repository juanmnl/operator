import { load, index, nodeName, selfSize } from './heap.mjs'
const s = index(load(process.argv[2]))
const g = new Map()
for (let n = 0; n < s.nodeCount; n++) {
  if (s.post[n] < 0) continue
  const names = new Map()
  for (let e = s.firstEdge[n]; e < s.firstEdge[n + 1]; e++) { if (s.edgeTypes[s.edges[e * s.EF + s.ef.type]] === 'property') names.set(s.strings[s.edges[e * s.EF + s.ef.name_or_index]], s.edges[e * s.EF + s.ef.to_node] / s.NF) }
  if (!(names.has('workingDirectory') && names.has('activity') && names.has('messages'))) continue
  const wd = nodeName(s, names.get('workingDirectory')); const key = /proj-scratch/.test(wd) ? 'real(proj-scratch)' : 'shim(proj-fake)'
  const cnt = (to) => { let c = 0; for (let e = s.firstEdge[to]; e < s.firstEdge[to + 1]; e++) if (s.edgeTypes[s.edges[e * s.EF + s.ef.type]] === 'element') c++; return c }
  const r = g.get(key) ?? { n: 0, ret: 0, self: 0, msgs: 0, acts: 0 }
  r.n++; r.ret += s.retained[n]; r.self += selfSize(s, n); r.msgs += cnt(names.get('messages')); r.acts += cnt(names.get('activity')); g.set(key, r)
}
for (const [k, r] of g) console.log(k, 'objects', r.n, 'meanSelf', Math.round(r.self / r.n), 'meanRetained', Math.round(r.ret / r.n), 'meanMessages', (r.msgs / r.n).toFixed(1), 'meanActivity', (r.acts / r.n).toFixed(1))
