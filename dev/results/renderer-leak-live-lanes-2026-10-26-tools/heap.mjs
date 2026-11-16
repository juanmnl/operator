// Heap snapshot loader + analysis helpers (no dependencies).
import { readFileSync } from 'node:fs'

export function load(file) {
  const buf = readFileSync(file)
  const find = (needle, from = 0) => buf.indexOf(needle, from)
  const iNodes = find('"nodes":[')
  const head = JSON.parse(buf.toString('utf8', 0, iNodes).trim().replace(/,\s*$/, '') + '}')
  const meta = head.snapshot.meta
  const NF = meta.node_fields.length, EF = meta.edge_fields.length
  const nodeCount = head.snapshot.node_count, edgeCount = head.snapshot.edge_count
  const nodeTypes = meta.node_types[0], edgeTypes = meta.edge_types[0]
  const readNums = (start, out) => {            // start = index just after '['
    let i = start, n = 0, cur = 0, inNum = false
    for (;;) {
      const c = buf[i++]
      if (c >= 48 && c <= 57) { cur = cur * 10 + (c - 48); inNum = true }
      else { if (inNum) { out[n++] = cur; cur = 0; inNum = false } if (c === 93) break }
    }
    return n
  }
  const nodes = new Uint32Array(nodeCount * NF)
  const nn = readNums(iNodes + 9, nodes)
  const iEdges = find('"edges":[', iNodes)
  const edges = new Uint32Array(edgeCount * EF)
  readNums(iEdges + 9, edges)
  const iLoc = find('"locations":[', iEdges), iStr = find('"strings":[', iLoc > 0 ? iLoc : iEdges)
  let locations = new Uint32Array(0)
  if (iLoc > 0) { const tmp = new Uint32Array((head.snapshot.location_count || 0) * 4 || 8_000_000); const n = readNums(iLoc + 13, tmp); locations = tmp.subarray(0, n) }
  const strings = JSON.parse(buf.toString('utf8', iStr + 10, buf.lastIndexOf(']') + 1))
  return { meta, NF, EF, nodeCount, edgeCount, nodeTypes, edgeTypes, nodes, edges, strings, locations,
    f: Object.fromEntries(meta.node_fields.map((k, i) => [k, i])), ef: Object.fromEntries(meta.edge_fields.map((k, i) => [k, i])) }
}

export function index(s) {
  const { nodes, edges, NF, EF, nodeCount, f, ef, edgeTypes } = s
  const firstEdge = new Uint32Array(nodeCount + 1)
  for (let i = 0, e = 0; i < nodeCount; i++) { firstEdge[i] = e; e += nodes[i * NF + f.edge_count] }
  firstEdge[nodeCount] = s.edgeCount
  s.firstEdge = firstEdge
  const weak = edgeTypes.indexOf('weak'), shortcut = edgeTypes.indexOf('shortcut')
  s.essential = (et) => et !== weak && et !== shortcut
  // DFS postorder from root (node 0), iterative.
  const post = new Int32Array(nodeCount).fill(-1), order = new Int32Array(nodeCount)
  const visited = new Uint8Array(nodeCount), stackN = new Int32Array(nodeCount), stackE = new Uint32Array(nodeCount)
  let sp = 0, pc = 0
  stackN[0] = 0; stackE[0] = firstEdge[0]; visited[0] = 1; sp = 1
  while (sp) {
    const n = stackN[sp - 1]
    if (stackE[sp - 1] < firstEdge[n + 1]) {
      const e = stackE[sp - 1]++
      if (!s.essential(edges[e * EF + ef.type])) continue
      const to = edges[e * EF + ef.to_node] / NF
      if (!visited[to]) { visited[to] = 1; stackN[sp] = to; stackE[sp] = firstEdge[to]; sp++ }
    } else { post[n] = pc; order[pc++] = n; sp-- }
  }
  s.post = post; s.order = order; s.reach = pc
  // Retaining (reverse) edges among reachable nodes for the dominator pass.
  const inCount = new Uint32Array(nodeCount + 1)
  for (let n = 0; n < nodeCount; n++) { if (post[n] < 0) continue; for (let e = firstEdge[n]; e < firstEdge[n + 1]; e++) { if (!s.essential(edges[e * EF + ef.type])) continue; const to = edges[e * EF + ef.to_node] / NF; if (post[to] >= 0) inCount[to + 1]++ } }
  for (let i = 0; i < nodeCount; i++) inCount[i + 1] += inCount[i]
  const inFrom = new Int32Array(inCount[nodeCount]), fill = inCount.slice(0, nodeCount)
  for (let n = 0; n < nodeCount; n++) { if (post[n] < 0) continue; for (let e = firstEdge[n]; e < firstEdge[n + 1]; e++) { if (!s.essential(edges[e * EF + ef.type])) continue; const to = edges[e * EF + ef.to_node] / NF; if (post[to] >= 0) inFrom[fill[to]++] = n } }
  // Cooper-Harvey-Kennedy dominators over postorder numbers.
  const idom = new Int32Array(pc).fill(-1), root = post[0]
  idom[root] = root
  let changed = true
  while (changed) {
    changed = false
    for (let p = pc - 2; p >= 0; p--) {
      const n = order[p]; let nd = -1
      for (let k = inCount[n]; k < inCount[n + 1]; k++) {
        const pp = post[inFrom[k]]
        if (idom[pp] === -1) continue
        if (nd === -1) { nd = pp; continue }
        let a = pp, b = nd
        while (a !== b) { while (a < b) a = idom[a]; while (b < a) b = idom[b] }
        nd = a
      }
      if (nd !== -1 && idom[p] !== nd) { idom[p] = nd; changed = true }
    }
  }
  s.idom = idom
  const retained = new Float64Array(nodeCount)
  for (let p = 0; p < pc; p++) retained[order[p]] = nodes[order[p] * NF + f.self_size]
  for (let p = 0; p < pc - 1; p++) retained[order[idom[p]]] += retained[order[p]]
  s.retained = retained
  return s
}

export const nodeName = (s, n) => s.strings[s.nodes[n * s.NF + s.f.name]]
export const nodeType = (s, n) => s.nodeTypes[s.nodes[n * s.NF + s.f.type]]
export const nodeId = (s, n) => s.nodes[n * s.NF + s.f.id]
export const selfSize = (s, n) => s.nodes[n * s.NF + s.f.self_size]

/** Group key as DevTools' Summary view does, roughly: constructor name for objects, type-level group for strings/code. */
export function classKey(s, n) {
  const t = nodeType(s, n), name = nodeName(s, n)
  if (t === 'string' || t === 'concatenated string' || t === 'sliced string') return '(string)'
  if (t === 'code') return '(compiled code)'
  if (t === 'closure') return `(closure) ${name}`
  if (t === 'array') return '(array)'
  if (t === 'hidden' || t === 'synthetic') return `(${t}) ${name}`.slice(0, 80)
  if (t === 'number') return '(number)'
  if (t === 'object shape') return '(object shape)'
  if (t === 'native') return `(native) ${name}`.slice(0, 80)
  return name
}
