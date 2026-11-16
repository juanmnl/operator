// map original DashboardView variable names to their minified names in a given build
import { readFileSync, readdirSync } from 'node:fs'
import { loadMap } from './sourcemap.mjs'
const dir = process.env.S + '/wt/electron/out/renderer/assets/'
const F = dir + readdirSync(dir).find((f) => /^main-.*\.js$/.test(f))
const src = readFileSync(process.env.S + '/wt/src/renderer/views/DashboardView.tsx', 'utf8').split('\n')
const txt = readFileSync(F, 'utf8'); const m = loadMap(F + '.map')
const want = new Set(['setPanelOpen', 'togglePanel', 'focusTerminal', 'openLaneTerminal', 'projectsSerRef', 'savedSerRef', 'allSidebarSessions', 'localSessions', 'sessions', 'terminals', 'sessionLayouts'])
const re = /[,;\s(]([A-Za-z_$][\w$]*)=/g; let x; const out = {}
while ((x = re.exec(txt))) {
  const idx = x.index + 1; const pre = txt.slice(0, idx); const line = pre.split('\n').length - 1; const col = idx - (pre.lastIndexOf('\n') + 1)
  const loc = String(m.lookup(line, col)); const mm = loc.match(/DashboardView\.tsx:(\d+):(\d+)/); if (!mm) continue
  const sl = src[Number(mm[1]) - 1] ?? ''; const dm = sl.match(/^\s*(?:const|let)\s+(\w+)\s*=/); if (!dm || !want.has(dm[1])) continue
  ;(out[dm[1]] ??= new Set()).add(x[1] + '@' + mm[1])
}
for (const [k, v] of Object.entries(out)) console.log(k, [...v].join(' '))
