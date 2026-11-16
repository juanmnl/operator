// usage: node linkstats.mjs <snapshot> <slotA,slotB,...>   (minified slot names of the DashboardView scope in that build)
import { load, index, nodeName, nodeType, selfSize } from './heap.mjs'
const [f, slotArg] = process.argv.slice(2); const slots = slotArg.split(',')
const s = index(load(f))
const rows = []
for (let n = 0; n < s.nodeCount; n++) {
  if (s.post[n] < 0 || !/^system \/ Context/.test(nodeName(s, n))) continue
  const have = new Set()
  for (let e = s.firstEdge[n]; e < s.firstEdge[n + 1]; e++) { if (s.edgeTypes[s.edges[e * s.EF + s.ef.type]] !== 'context') continue; have.add(s.strings[s.edges[e * s.EF + s.ef.name_or_index]]) }
  if (slots.every((x) => have.has(x))) rows.push({ n, self: selfSize(s, n), ret: s.retained[n], slots: have.size })
}
rows.sort((a, b) => b.ret - a.ret)
const marg = []; for (let i = 0; i < rows.length - 1; i++) marg.push(rows[i].ret - rows[i + 1].ret)
marg.sort((a, b) => a - b)
const mean = marg.length ? marg.reduce((a, b) => a + b, 0) / marg.length : 0
// AgentSession-shaped objects
let sess = 0, sessSelf = 0, msgLen = 0, actLen = 0
for (let n = 0; n < s.nodeCount; n++) {
  if (s.post[n] < 0) continue
  const names = new Map()
  for (let e = s.firstEdge[n]; e < s.firstEdge[n + 1]; e++) { if (s.edgeTypes[s.edges[e * s.EF + s.ef.type]] === 'property') names.set(s.strings[s.edges[e * s.EF + s.ef.name_or_index]], s.edges[e * s.EF + s.ef.to_node] / s.NF) }
  if (names.has('workingDirectory') && names.has('activity') && names.has('messages')) {
    sess++; sessSelf += selfSize(s, n)
    for (const [k, acc] of [['messages', 'm'], ['activity', 'a']]) { const to = names.get(k); const len = (s.nodes[to * s.NF + s.f.edge_count] ?? 0); if (acc === 'm') msgLen += len; else actLen += len }
  }
}
console.log(JSON.stringify({ snapshot: f.split('/').pop(), contexts: rows.length, ctxSelfBytes: rows.reduce((a, r) => a + r.self, 0), headRetainedMB: rows[0] ? +(rows[0].ret / 1048576).toFixed(3) : 0,
  perLinkMarginalBytes: { mean: Math.round(mean), median: marg[marg.length >> 1] ?? 0, p90: marg[Math.floor(marg.length * 0.9)] ?? 0, max: marg[marg.length - 1] ?? 0 },
  agentSessionObjects: sess, agentSessionSelfBytes: sessSelf, messagesEdgesTotal: msgLen, activityEdgesTotal: actLen, reachableMB: +(s.retained[0] / 1048576).toFixed(2) }))
