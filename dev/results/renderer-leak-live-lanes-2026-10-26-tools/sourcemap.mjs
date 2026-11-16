import { readFileSync } from 'node:fs'
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
export function loadMap(file) {
  const m = JSON.parse(readFileSync(file, 'utf8'))
  const lines = []
  let src = 0, sl = 0, sc = 0, nm = 0
  for (const line of m.mappings.split(';')) {
    const segs = []; let gc = 0
    if (line) for (const seg of line.split(',')) {
      const v = []; let shift = 0, val = 0
      for (const ch of seg) { const d = B64.indexOf(ch); val += (d & 31) << shift; if (d & 32) shift += 5; else { v.push(val & 1 ? -(val >> 1) : val >> 1); val = 0; shift = 0 } }
      gc += v[0]
      if (v.length >= 4) { src += v[1]; sl += v[2]; sc += v[3]; if (v.length >= 5) nm += v[4]; segs.push([gc, src, sl, sc]) }
    }
    lines.push(segs)
  }
  return { sources: m.sources, lines, lookup(line, col) {      // line/col 0-based, as in V8 locations
    const segs = lines[line]; if (!segs || !segs.length) return null
    let lo = 0, hi = segs.length - 1, best = segs[0]
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (segs[mid][0] <= col) { best = segs[mid]; lo = mid + 1 } else hi = mid - 1 }
    return `${m.sources[best[1]].replace(/^(\.\.\/)+/, '')}:${best[2] + 1}:${best[3] + 1}`
  } }
}
