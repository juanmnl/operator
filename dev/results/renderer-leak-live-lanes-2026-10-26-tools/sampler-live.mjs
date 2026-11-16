// Leak-measurement sampler. Talks CDP to the renderer on 9343; reads ps for the process tree.
// usage: node sampler.mjs <startEpochMs>   (snapshots are due at start+1h, +6h, +12h)
import { connect } from './cdp.mjs'
import { execFileSync } from 'node:child_process'
import { appendFileSync, writeFileSync, createWriteStream, existsSync, readFileSync, unlinkSync, statfsSync } from 'node:fs'
const S = '/private/tmp/claude-501/-Users-juanmnl-Developer-operator/b15ab04d-e9c2-43be-bcb2-39a423679c9a/scratchpad'
const start = Number(process.argv[2] || Date.now())
const INTERVAL = 10 * 60 * 1000
const SNAPS = [['live-10m', 10], ['live-1h', 60], ['live-2h', 120]].map(([n, m]) => ({ name: n, due: start + m * 60000, done: existsSync(`${S}/snapshots/${n}.heapsnapshot`) }))
let lastSnapshotAt = 0
const log = (...a) => appendFileSync(`${S}/logs/sampler-live.log`, new Date().toISOString() + ' ' + a.join(' ') + '\n')

function procs() {
  const mainPid = Number(readFileSync(`${S}/app.pid`, 'utf8').trim())
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,command=']).toString().split('\n').filter(Boolean).map((l) => {
    const m = l.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/); return m && { pid: +m[1], ppid: +m[2], rss: +m[3], cmd: m[4] }
  }).filter(Boolean)
  const kids = new Map(); rows.forEach((r) => { (kids.get(r.ppid) ?? kids.set(r.ppid, []).get(r.ppid)).push(r) })
  const out = []; const walk = (pid, depth) => { for (const k of kids.get(pid) ?? []) { out.push({ ...k, depth }); walk(k.pid, depth + 1) } }
  const main = rows.find((r) => r.pid === mainPid)
  if (main) out.push({ ...main, depth: 0 })
  walk(mainPid, 1)
  const label = (r) => {
    if (r.pid === mainPid) return 'main'
    if (/--type=renderer/.test(r.cmd)) return 'renderer'
    if (/--type=gpu-process/.test(r.cmd)) return 'gpu'
    if (/--type=utility/.test(r.cmd)) return 'utility:' + ((r.cmd.match(/--utility-sub-type=(\S+)/) || [])[1] || 'other')
    if (/Electron Helper/.test(r.cmd)) return 'helper'
    return 'lane-child'
  }
  return out.map((r) => ({ pid: r.pid, rssKB: r.rss, label: label(r), cmd: r.cmd.slice(0, 80) }))
}

async function sample() {
  if (Date.now() - lastSnapshotAt < 5 * 60000) await new Promise((r) => setTimeout(r, 5 * 60000 - (Date.now() - lastSnapshotAt)))
  const t = new Date().toISOString()
  const rec = { t, elapsedMin: Math.round((Date.now() - start) / 60000), procs: procs(), afterSnapshot: Date.now() - lastSnapshotAt < 5 * 60000 }
  const rend = rec.procs.find((p) => p.label === 'renderer')
  if (rend) { try { rec.renderer_footprint = execFileSync('footprint', ['-p', String(rend.pid), '--noCategories'], { timeout: 20000 }).toString().split('\n').filter((l) => /Footprint|phys_footprint/i.test(l)).join(' | ') } catch (e) { rec.renderer_footprint = 'n/a' } }
  try {
    const c = await connect()
    try {
      await c.send('Performance.enable')
      const hu = await c.send('Runtime.getHeapUsage')
      const pm = await c.evaluate('JSON.stringify(performance.memory ? {used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize, limit: performance.memory.jsHeapSizeLimit} : null)')
      const metrics = Object.fromEntries((await c.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]))
      const app = JSON.parse(await c.evaluate(`JSON.stringify({dom: document.getElementsByTagName('*').length, xterm: document.querySelectorAll('.xterm').length, xtermRows: document.querySelectorAll('.xterm-rows > div').length, lsKeys: (()=>{try{return Object.keys(localStorage).length}catch{return -1}})(), lsBytes: (()=>{try{let n=0;for(const k of Object.keys(localStorage))n+=k.length+(localStorage.getItem(k)||'').length;return n}catch{return -1}})()})`))
      await c.send('HeapProfiler.enable'); await c.send('HeapProfiler.collectGarbage')
      const hg = await c.send('Runtime.getHeapUsage')
      rec.postGC = { usedSize: hg.usedSize, totalSize: hg.totalSize }
      const lanes = await c.evaluate(`window.operator.terminalList().then(l=>l.filter(x=>x.alive).length)`).catch(() => -1)
      rec.heap = { lanes, usedSize: hu.usedSize, totalSize: hu.totalSize, perfMemory: JSON.parse(pm), jsEventListeners: metrics.JSEventListeners, nodes: metrics.Nodes, documents: metrics.Documents, layoutCount: metrics.LayoutCount, ...app }
    } finally { c.close() }
  } catch (e) { rec.cdpError = String(e.message || e).slice(0, 200) }
  appendFileSync(`${S}/samples/live-samples.jsonl`, JSON.stringify(rec) + '\n')
  const h = rec.heap
  log('sample', `elapsed=${rec.elapsedMin}m`, h ? `heapUsed=${(h.usedSize / 1048576).toFixed(1)}MB total=${(h.totalSize / 1048576).toFixed(1)}MB dom=${h.dom}` : rec.cdpError, rend ? `rendererRSS=${(rend.rssKB / 1024).toFixed(0)}MB` : 'no renderer')
}

async function snapshot(name) {
  const free = statfsSync(S).bavail * statfsSync(S).bsize
  if (free < 4e9) { log('snapshot', name, 'SKIPPED: free disk', free); return }
  const file = `${S}/snapshots/${name}.heapsnapshot`
  const c = await connect()
  try {
    await c.send('HeapProfiler.enable')
    await c.send('HeapProfiler.collectGarbage')
    const out = createWriteStream(file + '.part')
    c.on((d) => { if (d.method === 'HeapProfiler.addHeapSnapshotChunk') out.write(d.params.chunk) })
    const t0 = Date.now()
    await c.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: false })
    await new Promise((r) => out.end(r))
    const { renameSync, statSync } = await import('node:fs')
    renameSync(file + '.part', file)
    lastSnapshotAt = Date.now()
    log('snapshot', name, 'ok', `${(statSync(file).size / 1048576).toFixed(0)}MB in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
  } finally { c.close() }
}

log('sampler start; t0=', new Date(start).toISOString())
let next = Date.now()
for (;;) {
  try { await sample() } catch (e) { log('sample error', e.message) }
  for (const s of SNAPS) {
    if (!s.done && Date.now() >= s.due) { try { await snapshot(s.name); s.done = true } catch (e) { log('snapshot error', s.name, e.message) } }
  }
  if (existsSync(`${S}/snap-now`)) { const n = readFileSync(`${S}/snap-now`, 'utf8').trim() || 'extra'; unlinkSync(`${S}/snap-now`); try { await snapshot(n) } catch (e) { log('snapshot error', n, e.message) } }
  if (existsSync(`${S}/sampler.stop`)) { log('stop file seen'); break }
  next += INTERVAL
  // take a due snapshot on time even between samples
  while (Date.now() < next) {
    await new Promise((r) => setTimeout(r, 15000))
    for (const s of SNAPS) if (!s.done && Date.now() >= s.due) { try { await snapshot(s.name); s.done = true } catch (e) { log('snapshot error', s.name, e.message) } }
    if (existsSync(`${S}/snap-now`)) { const n = readFileSync(`${S}/snap-now`, 'utf8').trim() || 'extra'; unlinkSync(`${S}/snap-now`); try { await snapshot(n) } catch (e) { log('snapshot error', n, e.message) } }
    if (existsSync(`${S}/sampler.stop`)) break
  }
}
