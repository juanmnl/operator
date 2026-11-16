import { load, index, nodeName } from './heap.mjs'
const s = index(load(process.argv[2]))
const items = new Set()
for (let n = 0; n < s.nodeCount; n++) {
  if (s.post[n] < 0) continue
  const names = new Map()
  for (let e = s.firstEdge[n]; e < s.firstEdge[n + 1]; e++) { if (s.edgeTypes[s.edges[e * s.EF + s.ef.type]] === 'property') names.set(s.strings[s.edges[e * s.EF + s.ef.name_or_index]], s.edges[e * s.EF + s.ef.to_node] / s.NF) }
  if (!(names.has('workingDirectory') && names.has('activity') && names.has('messages'))) continue
  if (!/proj-scratch/.test(nodeName(s, names.get('workingDirectory')))) continue
  const m = names.get('messages')
  for (let e = s.firstEdge[m]; e < s.firstEdge[m + 1]; e++) if (s.edgeTypes[s.edges[e * s.EF + s.ef.type]] === 'element') items.add(s.edges[e * s.EF + s.ef.to_node] / s.NF)
}
const sz = [...items].map((i) => s.retained[i]).sort((a, b) => a - b)
const q = (p) => sz[Math.floor(sz.length * p)]
console.log({ items: sz.length, mean: Math.round(sz.reduce((a, b) => a + b, 0) / sz.length), p10: q(0.1), median: q(0.5), p90: q(0.9), max: sz[sz.length - 1] })
const big = [...items].find((i) => s.retained[i] === sz[sz.length - 1])
const props = []; for (let e = s.firstEdge[big]; e < s.firstEdge[big + 1]; e++) { const to = s.edges[e * s.EF + s.ef.to_node] / s.NF; props.push(s.strings[s.edges[e * s.EF + s.ef.name_or_index]] + ':' + s.nodes[to * s.NF + s.f.self_size]) }
console.log('largest item props (name:selfSize)', props.join(' '))
