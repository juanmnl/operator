import { Transcript } from './transcript.bundle.mjs'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import fs from 'node:fs'
const ids = process.argv.slice(2)
const tr = new Transcript()
ids.forEach((id, i) => tr.register('t' + i, { claudeSessionId: id, cwd: '/tmp', projectId: 'x' }))
const h = monitorEventLoopDelay({ resolution: 1 }); h.enable()
const rss0 = process.memoryUsage().rss; let peak = rss0; const iv = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss) }, 5)
let maxBlock = 0; let last = performance.now(); const wd = setInterval(() => { const n = performance.now(); maxBlock = Math.max(maxBlock, n - last - 1); last = n }, 1)
const t0 = performance.now()
await tr.tick({ isAlive: () => true, isActive: () => false })
const dt = performance.now() - t0
clearInterval(iv); clearInterval(wd); h.disable()
let total = 0; for (const t of tr.tracks.values()) total += fs.statSync(t.file).size
const sess = tr.sessions(); const json = JSON.stringify(sess)
let s0 = performance.now(); for (let i = 0; i < 20; i++) structuredClone(sess); const sc = (performance.now() - s0) / 20
s0 = performance.now(); for (let i = 0; i < 20; i++) JSON.stringify(sess); const js = (performance.now() - s0) / 20
const t1 = performance.now(); for (let i = 0; i < 20; i++) await tr.tick({ isAlive: () => true, isActive: () => false }); const idle = (performance.now() - t1) / 20
console.log(JSON.stringify({ lanes: ids.length, totalTranscriptMB: Math.round(total / 1048576), firstTickMs: Math.round(dt), maxEventLoopBlockMs: Math.round(maxBlock), peakRssDeltaMB: Math.round((peak - rss0) / 1048576), sessionsPayloadKB: Math.round(json.length / 1024), structuredCloneMs: +sc.toFixed(2), stringifyMs: +js.toFixed(2), idleTick15LanesMs: +idle.toFixed(2) }))
