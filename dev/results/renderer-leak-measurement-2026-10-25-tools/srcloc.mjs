import { readFileSync } from 'node:fs'
import { loadMap } from './sourcemap.mjs'
const F = process.env.S + '/wt/electron/out/renderer/assets/main-blSWKoDH.js'
const txt = readFileSync(F, 'utf8')
const m = loadMap(F + '.map')
const pats = [/[,; ]ic=d\.useCallback\(/g, /[,; ]fn=d\.useCallback\(/g, /[,; ]Rc=d\.useRef\(/g]
for (const re of pats) { let x; while ((x = re.exec(txt))) { const pre = txt.slice(0, x.index + 1); const line = pre.split('\n').length - 1; const col = x.index + 1 - (pre.lastIndexOf('\n') + 1); console.log(re.source, 'line', line, 'col', col, '->', JSON.stringify(m.lookup(line, col))) } }
