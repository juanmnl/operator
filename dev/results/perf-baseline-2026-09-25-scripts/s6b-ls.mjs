import { chromium, BASE, r } from './lib.mjs'
import fs from 'node:fs'; import os from 'node:os'
const raw = fs.readFileSync(os.homedir() + '/.operator/projects.json', 'utf8')
const b = await chromium.launch(); const p = await (await b.newContext()).newPage(); await p.goto(BASE + '/mock-min/dev/mock.html')
console.log('localStorage.setItem 3.1MB (Chromium, ms):', await p.evaluate((raw) => { const s = JSON.stringify(JSON.parse(raw)); const t = []; for (let i = 0; i < 20; i++) { const t0 = performance.now(); try { localStorage.setItem('operator.projects', s) } catch (e) { return 'THREW ' + e.name } t.push(performance.now() - t0) } return t.sort((a,b)=>a-b)[10].toFixed(2) + ' median, len ' + s.length }, raw))
await b.close()
