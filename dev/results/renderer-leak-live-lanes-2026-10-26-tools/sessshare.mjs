import { load, index, nodeName, selfSize } from './heap.mjs'
const s = index(load(process.argv[2]))
const msgArrs = new Set(), actArrs = new Set(), msgItems = new Set(); let objs = 0, withMsgs = 0
const bySess = new Map()
for (let n = 0; n < s.nodeCount; n++) {
  if (s.post[n] < 0) continue
  const names = new Map()
  for (let e = s.firstEdge[n]; e < s.firstEdge[n + 1]; e++) { if (s.edgeTypes[s.edges[e * s.EF + s.ef.type]] === 'property') names.set(s.strings[s.edges[e * s.EF + s.ef.name_or_index]], s.edges[e * s.EF + s.ef.to_node] / s.NF) }
  if (!(names.has('workingDirectory') && names.has('activity') && names.has('messages'))) continue
  if (!/proj-scratch/.test(nodeName(s, names.get('workingDirectory')))) continue
  objs++
  const m = names.get('messages'); msgArrs.add(m)
  let c = 0; for (let e = s.firstEdge[m]; e < s.firstEdge[m + 1]; e++) if (s.edgeTypes[s.edges[e * s.EF + s.ef.type]] === 'element') { c++; msgItems.add(s.edges[e * s.EF + s.ef.to_node] / s.NF) }
  if (c) withMsgs++
  const id = names.has('id') ? nodeName(s, names.get('id')) : '?'; bySess.set(id, (bySess.get(id) || 0) + 1)
}
let itemBytes = 0; for (const i of msgItems) itemBytes += s.retained[i]
console.log({ realSessionObjects: objs, withMessages: withMsgs, distinctMessageArrays: msgArrs.size, distinctMessageItems: msgItems.size, messageItemRetainedBytes: Math.round(itemBytes), perSession: [...bySess.entries()].map(([k, v]) => k.slice(0, 24) + ':' + v) })
