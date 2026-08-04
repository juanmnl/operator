// THE LETTER IN THE ORB — the collision rule drawn, and the treatment measured.
//
// Two jobs, because the feature has two halves that fail differently:
//
//   1. THE RULE. `Research` and `Review` adjacent, in all four states, beside the awkward names
//      (leading punctuation, a digit, CJK, two identical lanes). The rule is unit tested in
//      `lib/lane-initial.test.ts`; what this adds is that the resolved letters actually reach the
//      DOM, in a real roster, through the real component — and that at 264 there is NO letter at
//      all, which is the amendment: the row spells the name out there.
//
//      IN BATCHES OF FOUR, because the collapsed strip folds at four orbs and carries the rest in
//      `+N`. A single eleven-lane roster would draw seven of its lanes nowhere, so each batch is
//      small enough that every lane in it is on screen.
//   2. THE TREATMENT. `--fg` on a halo, measured across all six palettes against the worst-case
//      ground — a running dot at its 0.95 peak over every default lane accent.
//
// THE HALO IS THE WHOLE ARGUMENT and this is where the numbers live. Design's first pass scored
// the glyph against the DOT and got 1.39–1.47 on the dark palettes, which reads as a failure; that
// measured the wrong ground. The glyph carries a 3px halo in `--bg-sidebar`, so what it sits on is
// the halo. This driver reports BOTH, plus the knockout that was rejected, so the comparison that
// settled the treatment can be re-run rather than re-argued.
//
// Run: `node dev/drive-orb-initial.mjs` against a vite dev server (MOCK_PORT).
import { webkit } from 'playwright'
import { mkdirSync } from 'node:fs'

const PORT = process.env.MOCK_PORT || 1436
const OUT = '/tmp/operator-shots/rail-d1'
mkdirSync(OUT, { recursive: true })

const THEMES = [
  ['mission-control-dark', 'mc·D'], ['mission-control-light', 'mc·L'],
  ['mr-pink-dark', 'pink·D'], ['mr-pink-light', 'pink·L'],
  ['1984-dark', '1984·D'], ['1984-light', '1984·L'],
]

// Every lane LIVE, because only a live lane draws an orb — and in the four states, so the letter
// can be checked against the twinkle it sits on. `Research` and `Review` are ADJACENT on purpose:
// a collision you have to scroll between is not the case that breaks trust.
const PHASES = ['running', 'compacting', 'waiting', 'idle']
const BATCHES = [
  {
    key: 'collision',
    roster: [
      { id: 'operator', name: 'Operator', accent: '#c98bff' },
      { id: 'research', name: 'Research', accent: '#5ac8fa' },
      { id: 'review', name: 'Review', accent: '#ff9f45' },
      { id: 'design', name: 'Design', accent: '#ff7ac6' },
    ],
    // `Design` stays `D` — untouched by a collision it is not part of, which is the half of the
    // rule that is easiest to break.
    expect: { operator: 'O', research: 'RS', review: 'RV', design: 'D' },
  },
  {
    key: 'awkward',
    roster: [
      { id: 'scratch', name: '_scratch', accent: '#a78bfa' },
      { id: 'twofa', name: '2fa-check', accent: '#38bdf8' },
      { id: 'cjk', name: '研究', accent: '#fb7185' },
      { id: 'code', name: 'Code', accent: '#7ee787' },
    ],
    expect: { scratch: 'S', twofa: '2', cjk: '研', code: 'C' },
  },
  {
    key: 'identical',
    roster: [
      { id: 'dupe1', name: 'Deploy', accent: '#4ade80' },
      { id: 'dupe2', name: 'Deploy', accent: '#c98bff' },
      { id: 'qa', name: 'QA', accent: '#ffd43b' },
    ],
    expect: { dupe1: 'D1', dupe2: 'D2', qa: 'Q' },
  },
]
/** The batch every palette is measured with — the collision, which is the case the rule exists for. */
const MAIN = BATCHES[0]

/** THE SIX DEFAULT LANE ACCENTS (lib/roster.ts's `defaultRoster`), which is the ground Design
 *  measured against — not the fixture's own four, or the contrast columns would move whenever the
 *  fixture did and stop being comparable to the proposal's numbers. */
const DEFAULT_ACCENTS = ['#c98bff', '#5ac8fa', '#7ee787', '#ff9f45', '#ff7ac6', '#ffd43b']

const fails = []
const notes = []

/** Painted extent of one element, by difference: screenshot, `visibility: hidden` it, screenshot
 *  again — the pixels that changed ARE its ink. The same measurement `drive-rail-invariant.mjs`
 *  makes, and for the same reason: a text span's BOX is centred by `place-items` whatever its ink
 *  does, so measuring the box would assert nothing about the glyph. */
async function ink(p, clip, sel) {
  const shot = async () => (await p.screenshot({ clip, animations: 'disabled' })).toString('base64')
  const before = await shot()
  const ok = await p.evaluate((q) => {
    const el = document.querySelector(q)
    if (!el) return false
    el.style.visibility = 'hidden'
    return true
  }, sel)
  if (!ok) return null
  const after = await shot()
  await p.evaluate((q) => { document.querySelector(q).style.visibility = '' }, sel)
  return p.evaluate(async ([a, b, cssW]) => {
    const load = (s) => new Promise((res, rej) => {
      const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = 'data:image/png;base64,' + s
    })
    const [A, B] = await Promise.all([load(a), load(b)])
    const data = (im) => {
      const cv = document.createElement('canvas'); cv.width = A.width; cv.height = A.height
      const x = cv.getContext('2d', { willReadFrequently: true }); x.drawImage(im, 0, 0)
      return x.getImageData(0, 0, A.width, A.height).data
    }
    const da = data(A), db = data(B)
    let minX = 1e9, maxX = -1e9, n = 0
    for (let y = 0; y < A.height; y++) {
      for (let x = 0; x < A.width; x++) {
        const i = (y * A.width + x) * 4
        const d = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2])
        if (d > 6) { n++; if (x < minX) minX = x; if (x > maxX) maxX = x }
      }
    }
    if (!n) return null
    const s = A.width / cssW
    return { left: minX / s, right: (maxX + 1) / s }
  }, [before, after, clip.width])
}

/** WCAG contrast between two sRGB triples. */
const lum = (c) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
}
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m)
  return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100
}

async function boot(theme, roster) {
  const browser = await webkit.launch()
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    colorScheme: theme.endsWith('light') ? 'light' : 'dark',
    deviceScaleFactor: 2,
  })
  await ctx.addInitScript(([roster, phases, t]) => {
    try {
      localStorage.setItem('operator.theme', t)
      localStorage.setItem('operator.sidebarCollapsed', '1')
      localStorage.setItem('operator.activeProjectId', 'orb-demo')
    } catch { /* quota */ }
    const project = {
      id: 'orb-demo', name: 'orbs', path: '/Users/x/orbs',
      createdAt: '2026-07-01T00:00:00.000Z', lastActiveAt: '2026-07-20T00:00:00.000Z',
      roster,
    }
    // A full AgentSession per lane, in a rotating phase — the shape `onSessionUpdate` pushes, so
    // the app's own status ladder decides how each disc animates.
    const sessions = roster.map((r, i) => ({
      id: `s-${r.id}`, agentId: 'claude-code', terminalId: `t-${r.id}`,
      workingDirectory: project.path, projectName: project.name, projectId: project.id,
      roleId: r.id, status: 'active', phase: phases[i % phases.length],
      activity: [], activeSubagents: 0, lastToolName: null,
      startedAt: '2026-07-20T00:00:00.000Z', lastActivityAt: '2026-07-20T00:00:00.000Z',
    }))
    let real
    Object.defineProperty(window, 'operator', {
      configurable: true, get: () => real,
      set: (v) => {
        real = v
        v.loadProjects = async () => [project]
        v.saveProjects = () => {}
        v.terminalList = async () => sessions.map((s) => ({
          id: s.terminalId, pid: 0, cwd: project.path, command: 'claude', alive: true,
        }))
        v.loadSessions = async () => sessions.map((s) => ({
          key: `key-${s.terminalId}`, cwd: project.path, projectName: project.name,
          projectId: project.id, claudeSessionId: s.id, terminalId: s.terminalId,
          roleId: s.roleId, lastActiveAt: s.lastActivityAt,
        }))
        v.getSessions = async () => sessions
        v.onSessionUpdate = (cb) => { setTimeout(() => cb(sessions), 0); return () => {} }
      },
    })
  }, [roster, PHASES, theme])
  const p = await ctx.newPage()
  p.on('pageerror', (e) => fails.push(`${theme} PAGEERROR ${String(e).slice(0, 160)}`))
  await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
  await p.waitForSelector('[data-rail]')
  await p.waitForTimeout(7000) // outwait the your-turn settle so the discs are steady
  return { browser, p }
}

const rows = []

/** The letters the strip drew, keyed by session id. */
const drawnBy = (p) => p.evaluate(() => Object.fromEntries(
  [...document.querySelectorAll('[data-rail-orb]')].map((o) => [
    o.getAttribute('data-rail-orb'),
    o.querySelector('[data-orb-initial]')?.getAttribute('data-orb-initial') ?? null,
  ]),
))

for (const [theme, short] of THEMES) {
  const { browser, p } = await boot(theme, MAIN.roster)

  // ---- 1. the rule reaches the DOM, COLLAPSED ------------------------------------------------
  const drawn = await drawnBy(p)
  if (short === 'mc·D') {
    for (const [id, want] of Object.entries(MAIN.expect)) {
      const got = drawn[`s-${id}`]
      if (got !== want) fails.push(`${MAIN.key}/${id}: drew "${got}", expected "${want}"`)
    }
    notes.push(`${MAIN.key} @60: ${Object.entries(drawn).map(([k, v]) => `${k.replace('s-', '')}=${v}`).join(' ')}`)
    const seen = Object.values(drawn)
    if (new Set(seen).size !== seen.length) fails.push(`two orbs drew the SAME letter: ${seen.join(' / ')}`)
  }
  await p.screenshot({ path: `${OUT}/orb-rule-${short.replace('·', '-')}-collapsed.png`, clip: { x: 0, y: 40, width: 120, height: 320 } })

  // ---- 1b. THE LETTER IS ON THE AXIS --------------------------------------------------------
  // A centred TWO-character mono string carries its trailing letter-space on the right and nowhere
  // else, which pushes the ink ~0.3px off the column the whole strip is aligned to. The component
  // cancels it with a negative right margin; this measures the cancel rather than trusting it, and
  // `RS` / `RV` are in the fixture precisely so the two-character case is the one measured.
  if (short === 'mc·D') {
    const rr = await p.evaluate(() => {
      const r = document.querySelector('[data-rail]').getBoundingClientRect()
      return { x: r.left, y: r.top, width: r.width, height: r.height }
    })
    for (const id of Object.keys(drawn)) {
      const sel = `[data-rail-orb="${id}"] [data-orb-initial]`
      const letter = drawn[id]
      const box = await ink(p, rr, sel)
      if (!box) { fails.push(`${id}: the glyph "${letter}" painted nothing`); continue }
      const centre = (box.left + box.right) / 2
      const delta = centre - 30 // the strip's optical axis, element-local
      notes.push(`glyph "${letter}" ink ${box.left.toFixed(2)}–${box.right.toFixed(2)}  centre ${centre.toFixed(2)}  Δaxis ${delta.toFixed(2)}`)
      if (Math.abs(delta) > 0.75) fails.push(`the glyph "${letter}" paints ${delta.toFixed(2)}px off the axis`)
    }
  }

  // ---- 2. AT 264 THERE IS NO LETTER ----------------------------------------------------------
  // The amendment, asserted from the other side: the row spells the lane's name out there, so the
  // letter would be repeating it. Absent — not faded, not shrunk.
  await p.keyboard.press('Meta+b')
  await p.waitForTimeout(900)
  const wide = await drawnBy(p)
  const stray = Object.entries(wide).filter(([, v]) => v !== null)
  if (stray.length) fails.push(`${short}: ${stray.length} orb(s) still carry a letter at 264 — ${stray.map(([k, v]) => `${k}=${v}`).join(' ')}`)
  if (Object.keys(wide).length !== Object.keys(drawn).length) {
    fails.push(`${short}: ${Object.keys(drawn).length} orbs at 60 but ${Object.keys(wide).length} at 264`)
  }
  await p.screenshot({ path: `${OUT}/orb-rule-${short.replace('·', '-')}-expanded.png`, clip: { x: 0, y: 40, width: 300, height: 320 } })

  // ---- 3. THE TREATMENT, measured -----------------------------------------------------------
  // Three grounds: the halo the glyph actually sits on, the dot it would sit on without one, and
  // the knockout that was rejected. Only the first is the shipped claim; the others are the
  // receipts for why it is the shipped one.
  const m = await p.evaluate((accents) => {
    const css = getComputedStyle(document.documentElement)
    const probe = document.createElement('span')
    document.body.appendChild(probe)
    const rgb = (v) => {
      probe.style.color = v
      const c = getComputedStyle(probe).color.match(/[\d.]+/g).map(Number)
      return [c[0], c[1], c[2]]
    }
    const fg = rgb(css.getPropertyValue('--fg'))
    const halo = rgb(css.getPropertyValue('--bg-sidebar'))
    // A running dot peaks at 0.95 opacity in its accent, over the strip's own background.
    const peak = (a) => rgb(a).map((v, i) => v * 0.95 + halo[i] * 0.05)
    const out = accents.map((a) => ({ a, dot: peak(a) }))
    probe.remove()
    return { fg, halo, dots: out }
  }, DEFAULT_ACCENTS)

  const vsHalo = ratio(m.fg, m.halo)
  const vsDots = m.dots.map((d) => ratio(m.fg, d.dot))
  const knockout = m.dots.map((d) => ratio(m.halo, d.dot))
  rows.push({
    short, vsHalo,
    dotMin: Math.min(...vsDots), dotMax: Math.max(...vsDots),
    koMin: Math.min(...knockout), koMax: Math.max(...knockout),
  })
  if (vsHalo < 4.5) fails.push(`${short}: glyph on its halo measures ${vsHalo}:1 — below the 4.5 floor`)

  await browser.close()
}

// ---- 4. the other two batches, drawn and asserted on one palette ------------------------------
// The awkward names and the identical pair. One palette is enough: the RULE is palette-independent
// and its contrast is covered by the sweep above; what these add is that each of these names is
// actually on screen somewhere rather than folded into `+N`.
for (const batch of BATCHES.slice(1)) {
  const { browser, p } = await boot('mission-control-dark', batch.roster)
  const drawn = await drawnBy(p)
  for (const [id, want] of Object.entries(batch.expect)) {
    const got = drawn[`s-${id}`]
    if (got !== want) fails.push(`${batch.key}/${id}: drew "${got}", expected "${want}"`)
  }
  notes.push(`${batch.key} @60: ${Object.entries(drawn).map(([k, v]) => `${k.replace('s-', '')}=${v}`).join(' ')}`)
  await p.screenshot({ path: `${OUT}/orb-rule-${batch.key}-collapsed.png`, clip: { x: 0, y: 40, width: 120, height: 320 } })
  await browser.close()
}

console.log('\nTHE TREATMENT — `--fg` glyph, 3px halo in --bg-sidebar, over a running dot at 0.95 peak')
console.log('  ' + 'PALETTE'.padEnd(10) + 'ON ITS HALO'.padEnd(14) + 'on the dot alone'.padEnd(20) + 'knockout (rejected)')
console.log('  ' + '-'.repeat(70))
for (const r of rows) {
  console.log('  ' + r.short.padEnd(10) +
    `${String(r.vsHalo).padStart(6)}:1`.padEnd(14) +
    `${r.dotMin}–${r.dotMax}:1`.padEnd(20) +
    `${r.koMin}–${r.koMax}:1`)
}
console.log('\n  ON ITS HALO is the shipped treatment and the only column that gates (floor 4.5:1).')
console.log('  The other two are the receipts: the halo-less glyph is what Design first measured and')
console.log('  nearly rejected T1 over, and the knockout is T2, dead on the light palettes.')

console.log('\nNOTES')
for (const n of notes) console.log(`  · ${n}`)
console.log(`\nShots → ${OUT}/orb-rule-*.png`)
if (fails.length) {
  console.log(`\n${fails.length} FAILURE(S)`)
  for (const f of fails) console.log(`  ✗ ${f}`)
  process.exit(1)
}
console.log('\nAll orb checks passed.')
