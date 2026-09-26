import fs from 'node:fs'
import os from 'node:os'
const raw = fs.readFileSync(os.homedir() + '/.operator/projects.json', 'utf8')
const projects = JSON.parse(raw)
const time = (label, fn, n = 30) => { fn(); const t = performance.now(); for (let i = 0; i < n; i++) fn(); const ms = (performance.now() - t) / n; console.log(label.padEnd(58), ms.toFixed(2), 'ms'); return ms }
console.log('projects.json', (raw.length / 1e6).toFixed(2), 'MB,', projects.length, 'projects, tasks total', projects.reduce((a, p) => a + (p.tasks?.length || 0), 0))
time('renderer: JSON.stringify(map w/o lastActiveAt) [dedupe key]', () => JSON.stringify(projects.map(({ lastActiveAt, ...rest }) => rest)))
time('renderer: JSON.stringify(projects) [localStorage payload]', () => JSON.stringify(projects))
time('IPC: structuredClone(projects) [approx serialize]', () => structuredClone(projects))
function stable(value) { return JSON.stringify(value, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v), 2) }
time('main: stableStringify (sorted keys, indent 2)', () => stable(projects), 10)
time('main: plain JSON.stringify(projects, null, 2)', () => JSON.stringify(projects, null, 2))
const tmp = os.tmpdir() + '/bench-projects.tmp'
time('main: writeFileSync 3MB + rename', () => { fs.writeFileSync(tmp, raw); fs.renameSync(tmp, tmp + '2') })
fs.rmSync(tmp + '2', { force: true })
