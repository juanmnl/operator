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
const IMPL = process.env.IMPL || 'svg'
const DPR = Number(process.env.DPR || 1)
const SAMPLES = Number(process.env.SAMPLES || 14)
const WARMUP = Number(process.env.WARMUP || 2)
const label = process.argv[2] ?? 'run'

const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 1200, height: 200 }, colorScheme: 'dark', deviceScaleFactor: DPR })
await p.goto(`http://localhost:${PORT}/dev/perf-orbs.html?n=${N}&status=${STATUS}&size=${SIZE}&impl=${IMPL}`, { waitUntil: 'load' })
// PROVE IT IS MOVING, BY LOOKING AT IT. `getAnimations()` was the pass-1 guard and it only
// covers CSS animations — a canvas orb driven by rAF has none, and would be waved through as
// "still" while a broken CSS orb with a missing @keyframes rule computes an `animation-name` and
// is waved through as "animated" (that one measured a beautiful 1.1%). Two screenshots a third of
// a second apart is the guard that works for every candidate, because it asks the only question
// that matters: did the pixels change.
const shotA = await p.screenshot()
await p.waitForTimeout(320)
const shotB = await p.screenshot()
if (shotA.equals(shotB)) {
  console.error('NOTHING IS MOVING — refusing to report a number for a still page')
  await b.close(); process.exit(1)
}
// What is on screen, generically: SVG circles, HTML dots, or canvases.
const shape = await p.evaluate(() => ({
  circles: document.querySelectorAll('circle').length,
  dots: document.querySelectorAll('[data-dot]').length,
  canvases: document.querySelectorAll('canvas').length,
  cssAnimations: document.getAnimations().length,
}))

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
// `mem` alongside `cpu`, because the cheapest CPU here is bought with compositor layers and a
// layer is a texture. A candidate that halves the CPU and doubles the GPU process's resident
// memory has not won, it has moved the cost somewhere this bench would not have shown.
const { stdout } = await run('/usr/bin/top', ['-l', String(SAMPLES), '-s', '1', '-stats', 'pid,cpu,mem', ...pidArgs])
const after = await metricsAt()

// One block per sample; each block has a line per pid.
const perPid = new Map()
const memPid = new Map()
let sample = -1
for (const line of stdout.split('\n')) {
  if (/^Processes:/.test(line)) { sample++; continue }
  // `pid cpu mem` — mem carries a unit suffix (K/M/G/+/-), so it is parsed, not trusted.
  const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+([\d.]+)([KMG])?[+-]?\s*$/)
  if (!m || sample < WARMUP) continue
  const pid = Number(m[1])
  if (!perPid.has(pid)) { perPid.set(pid, []); memPid.set(pid, []) }
  perPid.get(pid).push(Number(m[2]))
  const scale = m[4] === 'G' ? 1024 : m[4] === 'K' ? 1 / 1024 : 1
  memPid.get(pid).push(Number(m[3]) * scale)
}
const mean = (xs) => (xs.length ? xs.reduce((a, c) => a + c, 0) / xs.length : 0)
const sumOf = (pids) => mean(pids.flatMap((pid) => perPid.get(pid) ?? []).length
  ? pids.map((pid) => mean(perPid.get(pid) ?? [0])) : [0])
const rendererCpu = pids => pids.reduce((a, pid) => a + mean(perPid.get(pid) ?? [0]), 0)
/** Peak resident MB across the counted samples — the layer-explosion tripwire. */
const peakMem = pids => pids.reduce((a, pid) => a + Math.max(0, ...(memPid.get(pid) ?? [0])), 0)

const secs = (after.Timestamp - before.Timestamp) || 1
// COMPOSITED LAYERS, counted rather than assumed. The whole premise of the HTML candidate is
// that Blink promotes each dot; the whole risk of it is that Blink promotes each dot.
let layers = null
try {
  const lt = await p.context().newCDPSession(p)
  await lt.send('DOM.enable'); await lt.send('LayerTree.enable')
  layers = await new Promise((res) => {
    const t = setTimeout(() => res(null), 2500)
    lt.on('LayerTree.layerTreeDidChange', (e) => { clearTimeout(t); res(e.layers?.length ?? null) })
  })
} catch { /* the count is diagnostic; its absence must not lose the run */ }

const out = {
  label,
  orbs: Number(N), impl: IMPL, dpr: DPR, status: STATUS, size: Number(SIZE), ...shape, layers,
  samples: (perPid.get(renderers[0]) ?? []).length,
  rendererCpuPct: Number(rendererCpu(renderers).toFixed(1)),
  gpuCpuPct: Number(rendererCpu(gpus).toFixed(1)),
  rendererMemMB: Number(peakMem(renderers).toFixed(0)),
  gpuMemMB: Number(peakMem(gpus).toFixed(0)),
  // Blink's own totals, as a rate per wall second — the mechanism behind the CPU number.
  layoutMsPerSec: Number((((after.LayoutDuration - before.LayoutDuration) / secs) * 1000).toFixed(1)),
  recalcStyleMsPerSec: Number((((after.RecalcStyleDuration - before.RecalcStyleDuration) / secs) * 1000).toFixed(1)),
  scriptMsPerSec: Number((((after.ScriptDuration - before.ScriptDuration) / secs) * 1000).toFixed(1)),
  taskMsPerSec: Number((((after.TaskDuration - before.TaskDuration) / secs) * 1000).toFixed(1)),
}
void sumOf
console.log(JSON.stringify(out))
await b.close()
