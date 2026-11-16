// usage: node chaintotal.mjs <snapshot> <slots> — total bytes dominated by the union of link contexts
import { load, index, nodeName } from './heap.mjs'
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
const tops = []
for (const c of link) { let p = dom(c), d = 0, nested = false; while (p !== 0 && d < 100000) { if (link.has(p)) { nested = true; break } p = dom(p); d++ } if (!nested) tops.push(c) }
tops.sort((a, b) => s.retained[b] - s.retained[a])
console.log(JSON.stringify({ snapshot: f.split('/').pop(), links: link.size, topLevel: tops.length, totalDominatedMB: +(tops.reduce((a, c) => a + s.retained[c], 0) / 1048576).toFixed(3), topRetainedKB: tops.slice(0, 6).map((c) => Math.round(s.retained[c] / 1024)) }))
