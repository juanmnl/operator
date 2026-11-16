import { load, index, nodeName, nodeType, selfSize } from './heap.mjs'
for (const f of process.argv.slice(2)) {
  const s = index(load(f)); let n_ctx = 0, self = 0; let withRc = 0
  for (let n = 0; n < s.nodeCount; n++) {
    if (s.post[n] < 0 || !/^system \/ Context/.test(nodeName(s, n))) continue
    let hasFn = false, hasIc = false, hasKe = false, hasRc = false
    for (let e = s.firstEdge[n]; e < s.firstEdge[n + 1]; e++) { if (s.edgeTypes[s.edges[e * s.EF + s.ef.type]] !== 'context') continue; const nm = s.strings[s.edges[e * s.EF + s.ef.name_or_index]]; if (nm === 'fn') hasFn = true; if (nm === 'ic') hasIc = true; if (nm === 'Ke') hasKe = true; if (nm === 'Rc') hasRc = true }
    if (hasFn && hasIc && hasKe && hasRc) { n_ctx++; self += selfSize(s, n) }
  }
  console.log(f, 'DashboardView-sized Contexts (fn+ic+Ke+Rc slots):', n_ctx, 'self bytes', self)
}
