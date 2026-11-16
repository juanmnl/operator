import { readFileSync } from 'node:fs'
import { loadMap } from './sourcemap.mjs'
const F = process.env.S + '/wt/electron/out/renderer/assets/main-blSWKoDH.js'
const txt = readFileSync(F, 'utf8'); const m = loadMap(F + '.map')
for (const nm of process.argv.slice(2)) { const re = new RegExp('[,; ]' + nm + '=', 'g'); let x; let k = 0
  while ((x = re.exec(txt)) && k < 12) { const pre = txt.slice(0, x.index + 1); const line = pre.split('\n').length - 1; const col = x.index + 1 - (pre.lastIndexOf('\n') + 1); const loc = m.lookup(line, col); if (/DashboardView/.test(String(loc))) { console.log(nm, loc, JSON.stringify(txt.slice(x.index, x.index + 70))); k++ } } }
