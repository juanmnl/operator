// usage: node sessdom.mjs <snapshot> <slots>  — which real-lane message arrays are dominated by the link chain
import { load, index, nodeName, nodeType } from './heap.mjs'
const [f, slotArg] = process.argv.slice(2); const slots = slotArg.split(',')
const s = index(load(f))
const link = new Set()
for (let n = 0; n < s.nodeCount; n++) {
  if (s.post[n] < 0 || !/^system \/ Context/.test(nodeName(s, n))) continue
  const have = new Set()
  for (let e = s.firstEdge[n]; e < s.firstEdge[n + 1]; e++) { if (s.edgeTypes[s.edges[e * s.EF + s.ef.type]] !== 'context') continue; have.add(s.strings[s.edges[e * s.EF + s.ef.name_or_index]]) }
  if (slots.every((x) => have.has(x))) link.add(n)
}
const dom = (n) => s.order[s.idom[s.post[n]]]
const arrs = new Map()
for (let n = 0; n < s.nodeCount; n++) {
  if (s.post[n] < 0) continue
  const names = new Map()
  for (let e = s.firstEdge[n]; e < s.firstEdge[n + 1]; e++) { if (s.edgeTypes[s.edges[e * s.EF + s.ef.type]] === 'property') names.set(s.strings[s.edges[e * s.EF + s.ef.name_or_index]], s.edges[e * s.EF + s.ef.to_node] / s.NF) }
  if (!(names.has('workingDirectory') && names.has('activity') && names.has('messages'))) continue
  if (!/proj-scratch/.test(nodeName(s, names.get('workingDirectory')))) continue
  arrs.set(names.get('messages'), n)
}
let inChain = 0, inChainBytes = 0, other = 0, otherBytes = 0; const otherKinds = new Map()
for (const [m, sess] of arrs) {
  const len = s.nodes[m * s.NF + s.f.edge_count]; if (!len) continue
  let c = sess, hit = false, d = 0
  while (c !== 0 && d < 100000) { if (link.has(c)) { hit = true; break } c = dom(c); d++ }
  // bytes of this messages array subtree if dominated by session obj chain
  const b = s.retained[m]
  if (hit) { inChain++; inChainBytes += b } else { other++; otherBytes += b
    let k = sess, kinds = []; for (let i = 0; i < 4 && k !== 0; i++) { k = dom(k); kinds.push(nodeType(s, k).slice(0, 4) + ':' + (nodeName(s, k) || '').slice(0, 24)) }
    const key = kinds.join(' < '); otherKinds.set(key, (otherKinds.get(key) || 0) + 1) }
}
console.log({ nonEmptyMessageArrays: inChain + other, dominatedByLinkChain: inChain, chainBytes: Math.round(inChainBytes), notInChain: other, notInChainBytes: Math.round(otherBytes), linkContexts: link.size })
console.log([...otherKinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8))
