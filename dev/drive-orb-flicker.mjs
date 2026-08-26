// THE RAIL ORB'S DOT COUNT, measured. See dev/results/orb-dot-count.md.
//
// Three models, all transcribing StatusWave.tsx's dot generation 1:1 (rather than importing it,
// so this runs without the app or a build step):
//
//   1. INK per dot over a cycle — the constraint the file's comment block fixes ("a busy orb
//      should carry at least TWICE the ink of a quiet one"). It comes out INVARIANT to dot
//      count, which is the finding: the ink rule does not decide this question either way.
//   2. AGGREGATE FLICKER — what the eye gets at sizes where individual dots stop being
//      resolvable. Gets STRONGER as the count falls, because 37 desynced sinusoids average each
//      other out and 9 do not. The counter-intuitive half.
//   3. SILHOUETTE STABILITY — what actually decides it. How much of the disc sits below the
//      RESTING level at a given instant, and how many dots are near peak. Below ~7 simultaneous
//      peaks the orb stops reading as a surface with moving texture and starts reading as a
//      handful of lights blinking — which is the retired unison pulse's register, not "thinking".
//
// Run: `node dev/drive-orb-flicker.mjs`

const rand = (s) => { const x = Math.sin(s * 12.9898) * 43758.5453; return x - Math.floor(x) }
const hashSeed = (s) => { if (typeof s === 'number') return s; let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1000003; return h }

function gridPointsInDisc(cells, radius) {
  const out = [], center = (cells - 1) / 2 + 0.5, max = radius * radius * 1.04
  for (let c = 0; c < cells; c++) for (let r = 0; r < cells; r++) {
    const cx = c + 0.5, cy = r + 0.5, dx = cx - center, dy = cy - center
    if (dx * dx + dy * dy <= max) out.push({ cx, cy })
  }
  return out
}

// CSS `ease-in-out` = cubic-bezier(.42, 0, .58, 1). Newton-solve x for the eased y.
function easeInOut(t) {
  const p1 = 0.42, p2 = 0.58
  const cx = 3 * p1, bx = 3 * (p2 - p1) - cx, ax = 1 - cx - bx
  const fx = (u) => ((ax * u + bx) * u + cx) * u
  let u = t
  for (let i = 0; i < 12; i++) {
    const e = fx(u) - t, d = (3 * ax * u + 2 * bx) * u + cx
    if (Math.abs(d) < 1e-9) break
    u -= e / d
  }
  return ((1 - 3) * u + 3) * u * u // p1y = 0, p2y = 1
}

// @keyframes twinkle: 0%/100% → opacity .3, scale .5; 50% → opacity .95, scale 1.
// Ink is weighted by AREA (opacity · scale²) — the file's ≈0.51 figure uses opacity · scale.
const REST_OP = 0.25, durMin = 1.4, durMax = 2.6
function dotInk(p) {
  const e = easeInOut(p < 0.5 ? p * 2 : (1 - p) * 2)
  const op = 0.3 + 0.65 * e, sc = 0.5 + 0.5 * e
  return op * sc * sc
}

// Same disc diameter in every candidate — only the grid pitch, and so the dot count, changes.
const CANDIDATES = [
  ['7×7 r3.4 (SHIPPED)', 7, 3.4],
  ['7×7 r3.0', 7, 3.0],
  ['5×5 r2.4', 5, 2.4],
  ['5×5 r2.0', 5, 2.0],
  ['3×3 r1.4', 3, 1.4],
]
const SEEDS = ['operator', 'research', 'review', 'design', 'code', 'qa']

/** One session's animation params, exactly as the component's useMemo builds them. */
function anim(dots, seed) {
  const s = hashSeed(seed)
  const tempo = 0.82 + rand(s + 0.5) * 0.42
  return dots.map((_, i) => {
    const dur = (durMin + rand(i + 1 + s) * (durMax - durMin)) * tempo
    return { dur, delay: -rand(i + 7 + s * 1.7) * dur }
  })
}
const phaseAt = (a, t) => { let p = ((t - a.delay) / a.dur) % 1; return p < 0 ? p + 1 : p }

const rows = CANDIDATES.map(([label, cells, radius]) => {
  const dots = gridPointsInDisc(cells, radius), N = dots.length
  const per = SEEDS.map((seed) => {
    const an = anim(dots, seed)
    const total = [], below = [], peaks = [], invis = []
    for (let f = 0; f < 1800; f++) { // 30 s at 60 fps
      const t = f / 60
      let sum = 0, b = 0, pk = 0, iv = 0
      for (const a of an) {
        const v = dotInk(phaseAt(a, t))
        sum += v
        if (v < REST_OP) b++
        if (v >= 0.6) pk++
        if (v < 0.08) iv++
      }
      total.push(sum / N); below.push(b / N); peaks.push(pk); invis.push(iv / N)
    }
    const mean = total.reduce((x, y) => x + y, 0) / total.length
    const sd = Math.sqrt(total.reduce((x, y) => x + (y - mean) ** 2, 0) / total.length)
    const min = Math.min(...total), max = Math.max(...total)
    return {
      mean, cv: sd / mean, mich: (max - min) / (max + min), ratio: mean / REST_OP,
      below: below.reduce((x, y) => x + y, 0) / below.length,
      belowMin: Math.min(...below), belowMax: Math.max(...below),
      peaks: peaks.reduce((x, y) => x + y, 0) / peaks.length,
      invisWorst: Math.max(...invis),
    }
  })
  const avg = (k) => per.reduce((a, r) => a + r[k], 0) / per.length
  return { label, N, mean: avg('mean'), cv: avg('cv'), mich: avg('mich'), ratio: avg('ratio'),
           below: avg('below'), belowMin: avg('belowMin'), belowMax: avg('belowMax'),
           peaks: avg('peaks'), invisWorst: avg('invisWorst') }
})

const pad = (v, n, d = 3) => (typeof v === 'number' ? v.toFixed(d) : String(v)).padStart(n)

console.log('\n1. INK — invariant to count, so the file\'s "twice the ink" rule does not decide this.\n')
console.log('layout                 N   mean ink/dot   ink vs rest')
for (const r of rows) console.log(r.label.padEnd(21), pad(r.N, 2, 0), pad(r.mean, 14), pad(r.ratio, 12, 2) + '×')

console.log('\n2. AGGREGATE FLICKER — stronger as the count falls. 37 is already ~25–50× over the')
console.log('   temporal-contrast detection threshold at ~0.5 Hz, so this is not the binding axis.\n')
console.log('layout                 N   flicker CV   Michelson')
for (const r of rows) console.log(r.label.padEnd(21), pad(r.N, 2, 0), pad(r.cv, 12), pad(r.mich, 11))

console.log('\n3. SILHOUETTE STABILITY — the axis that decides it. At 9 dots the ~44% that vanishes at')
console.log('   once IS a corner of the mark, so the orb changes shape frame to frame.\n')
console.log('layout                 N   below rest   swing (min..max)   dots near peak   worst invisible')
for (const r of rows) console.log(
  r.label.padEnd(21), pad(r.N, 2, 0),
  pad(r.below * 100, 10, 0) + '%',
  (pad(r.belowMin * 100, 13, 0) + ' .. ' + (r.belowMax * 100).toFixed(0) + '%'),
  pad(r.peaks, 14, 1),
  pad(r.invisWorst * 100, 15, 0) + '%',
)
console.log()
