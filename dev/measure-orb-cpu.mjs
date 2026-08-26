// WHAT THE TWINKLE COSTS, measured rather than reasoned about.
//
// Opens `dev/perf-orbs.html` in Chromium — the engine the Electron shell actually renders in —
// and samples the RENDERER and GPU process CPU with `top`, the same instrument and cadence
// Research used: 1s samples over 12s, discarding the first two while the page settles.
//
// Chromium is launched with the default compositor/raster path (no --disable-gpu and no
// --disable-frame-rate-limit): a measurement taken with the GPU turned off cannot say anything
// about a change whose whole claim is about GPU re-raster.
//
// Run: `./node_modules/.bin/vite --port <p> --strictPort` then
//      `MOCK_PORT=<p> node dev/measure-orb-cpu.mjs [label]`
import { chromium } from 'playwright'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const PORT = process.env.MOCK_PORT || 1461
const N = process.env.N || 7
const STATUS = process.env.STATUS || 'running'
const SIZE = process.env.SIZE || 24
const SAMPLES = Number(process.env.SAMPLES || 14)
const WARMUP = Number(process.env.WARMUP || 2)
const label = process.argv[2] ?? 'run'

const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 1200, height: 200 }, colorScheme: 'dark' })
await p.goto(`http://localhost:${PORT}/dev/perf-orbs.html?n=${N}&status=${STATUS}&size=${SIZE}`, { waitUntil: 'load' })
// Prove the thing being measured is actually on screen before measuring it.
const circles = await p.locator('circle').count()
// `getAnimations()`, not a computed `animation-name`: a name whose @keyframes rule is missing
// still computes, so the property test says "animated" for a page that is perfectly still. That
// is not hypothetical — a stale dev-server cache served exactly that here, and it measured 1.1%,
// which is the number a broken run gives you and the number you would ship in a report.
const animated = await p.evaluate(() => document.getAnimations().length)
if (!circles) { console.error('no circles rendered — the bench never mounted'); await b.close(); process.exit(1) }
if (!animated) { console.error('NOTHING IS ANIMATING — refusing to report a number for a still page'); await b.close(); process.exit(1) }

// The browser's OWN accounting of what it repainted, alongside the OS's. `top` says how much
// CPU; this says where it went, and the two disagreeing is itself a finding.
const client = await p.context().newCDPSession(p)
await client.send('Performance.enable')
const metricsAt = async () => Object.fromEntries((await client.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]))

// Chromium's own processes, found by command line rather than by name: the helper binaries are
// all called the same thing and only `--type=` tells them apart.
async function pidsByType(type) {
  const { stdout } = await run('/bin/sh', ['-c', `ps -eo pid,command | grep -- '--type=${type}' | grep -i chromium | grep -v grep`])
  return stdout.trim().split('\n').filter(Boolean).map((l) => Number(l.trim().split(/\s+/)[0]))
}
const renderers = await pidsByType('renderer')
const gpus = await pidsByType('gpu-process')
if (!renderers.length) { console.error('no renderer process found'); await b.close(); process.exit(1) }

const before = await metricsAt()
// `top -l` on macOS reports the FIRST sample as an average since boot, which is meaningless
// here; -l N with -s 1 and dropping the settling samples is the shape Research used.
const pidArgs = [...renderers, ...gpus].flatMap((pid) => ['-pid', String(pid)])
const { stdout } = await run('/usr/bin/top', ['-l', String(SAMPLES), '-s', '1', '-stats', 'pid,cpu', ...pidArgs])
const after = await metricsAt()

// One block per sample; each block has a line per pid.
const perPid = new Map()
let sample = -1
for (const line of stdout.split('\n')) {
  if (/^Processes:/.test(line)) { sample++; continue }
  const m = line.trim().match(/^(\d+)\s+([\d.]+)\s*$/)
  if (!m || sample < WARMUP) continue
  const pid = Number(m[1])
  if (!perPid.has(pid)) perPid.set(pid, [])
  perPid.get(pid).push(Number(m[2]))
}
const mean = (xs) => (xs.length ? xs.reduce((a, c) => a + c, 0) / xs.length : 0)
const sumOf = (pids) => mean(pids.flatMap((pid) => perPid.get(pid) ?? []).length
  ? pids.map((pid) => mean(perPid.get(pid) ?? [0])) : [0])
const rendererCpu = pids => pids.reduce((a, pid) => a + mean(perPid.get(pid) ?? [0]), 0)

const secs = (after.Timestamp - before.Timestamp) || 1
const out = {
  label,
  orbs: Number(N), status: STATUS, size: Number(SIZE), circles, animated,
  samples: (perPid.get(renderers[0]) ?? []).length,
  rendererCpuPct: Number(rendererCpu(renderers).toFixed(1)),
  gpuCpuPct: Number(rendererCpu(gpus).toFixed(1)),
  // Blink's own totals, as a rate per wall second — the mechanism behind the CPU number.
  layoutMsPerSec: Number((((after.LayoutDuration - before.LayoutDuration) / secs) * 1000).toFixed(1)),
  recalcStyleMsPerSec: Number((((after.RecalcStyleDuration - before.RecalcStyleDuration) / secs) * 1000).toFixed(1)),
  scriptMsPerSec: Number((((after.ScriptDuration - before.ScriptDuration) / secs) * 1000).toFixed(1)),
  taskMsPerSec: Number((((after.TaskDuration - before.TaskDuration) / secs) * 1000).toFixed(1)),
}
void sumOf
console.log(JSON.stringify(out))
await b.close()
