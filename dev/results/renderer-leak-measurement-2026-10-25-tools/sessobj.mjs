import { load, index, nodeName, selfSize } from './heap.mjs'
for (const f of process.argv.slice(2)) {
  const s = index(load(f))
  const want = ['workingDirectory', 'activity', 'messages', 'startedAt']
  const cnt = {}; let both = 0, self = 0, ret = 0; const byProj = new Map()
  for (let n = 0; n < s.nodeCount; n++) {
    if (s.post[n] < 0) continue
    const seen = new Set()
    for (let e = s.firstEdge[n]; e < s.firstEdge[n + 1]; e++) {
      const ty = s.edgeTypes[s.edges[e * s.EF + s.ef.type]]; if (ty !== 'property') continue
      const nm = s.strings[s.edges[e * s.EF + s.ef.name_or_index]]; if (want.includes(nm)) seen.add(nm)
    }
    if (seen.has('workingDirectory') && seen.has('activity') && seen.has('messages')) { both++; self += selfSize(s, n); ret += s.retained[n]
      for (let e = s.firstEdge[n]; e < s.firstEdge[n + 1]; e++) { const nm = s.strings[s.edges[e * s.EF + s.ef.name_or_index]]; if (nm === 'workingDirectory') { const to = s.edges[e * s.EF + s.ef.to_node] / s.NF; const v = nodeName(s, to); byProj.set(v, (byProj.get(v) || 0) + 1) } } }
  }
  console.log(f, 'AgentSession-shaped objects:', both, 'self', self, 'dominated-retained', ret)
  console.log([...byProj.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${v} x ${k.slice(-50)}`).join('\n'))
}
