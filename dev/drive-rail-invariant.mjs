// THE RAIL'S INVARIANT, asserted over every element — dev/briefs/rail-assert-the-invariant.md
//
// Four passes fixed this strip by eye, each measured something real, each reported success, and
// the user still saw it wrong a fourth time. The common failure is not arithmetic — it is that
// every one of them measured a HANDLE (a border box, a shadow spread, an svg's shape rects)
// rather than the ink. `getBoundingClientRect` on the tile excludes its ring; on an svg it
// excludes the stroke's outer half; on the pip's span it reports reserved space no dot covers.
// So each pass could be correct about its own number and blind to the pixels.
//
// This driver measures PAINTED EXTENT and nothing else, by difference:
//
//     screenshot the rail  →  `visibility: hidden` on ONE element  →  screenshot again
//     the pixels that changed ARE that element's ink, whatever drew them
//
// `visibility: hidden` suppresses painting without reflowing, so nothing else in the strip can
// move between the two frames. The diff catches box-shadow rings, stroke overshoot, round line
// caps, glyph side bearings and antialiasing tails — every channel that made a box lie.
//
// FOUR ASSERTIONS
//   H. every element that is SUPPOSED to be on the axis has its painted centre x at the centre of
//      the VISIBLE column — 17.5 in rail-local coordinates, NOT the rail's own midpoint of 22.
//      See CENTRE for why the difference is the whole defect. Reported as a signed delta, never
//      a pass/fail: the size of the error is the diagnosis.
//   O. the two elements that are deliberately OFF the axis — the corner pip and the rail's own
//      right-edge seam — are held to their own invariant instead. An assertion that flags
//      intentional design as a defect is an assertion nobody will keep running.
//   S. the four foot glyphs carry the same painted INK SIZE. They sit in identical 26×26 boxes,
//      which is exactly why three passes never noticed they don't.
//   V. the painted gaps down the strip follow a stated rhythm (see RHYTHM below). The foot is
//      2 + 2 controls around a seam, so "balanced" there is a claim about four numbers, not one.
//
// Run: `./node_modules/.bin/vite --port 1436 --strictPort` then `node dev/drive-rail-invariant.mjs`.
//      `THEMES=all` sweeps all six palettes (ink extent is palette-dependent: a stroke's
//      antialiasing tail is not the same width on a near-black field as on a white one).
import { webkit } from 'playwright'

const PORT = process.env.MOCK_PORT || 1436
const ALL_THEMES = [
  ['mission-control-dark', 'mc·D'], ['mission-control-light', 'mc·L'],
  ['mr-pink-dark', 'pink·D'], ['mr-pink-light', 'pink·L'],
  ['1984-dark', '1984·D'], ['1984-light', '1984·L'],
]
const THEMES = process.env.THEMES === 'all' ? ALL_THEMES : [ALL_THEMES[0]]
const NAMES = ['fastrack', 'uwazi-app', 'web27', 'el-mirador']

// The rail's own geometry, as declared. Everything is asserted against these, not against
// whatever the DOM happens to report — a driver that derives its expectation from the thing it
// is testing agrees with any bug that is internally consistent.
const RAIL_W = 44
// THE AXIS IS NOT THE RAIL'S MIDPOINT, and that was a fifth way to measure the wrong thing. The
// four passes this driver was built to end each measured a handle instead of the ink; this one
// measured the ink correctly but against the rail's own BOX. The rail has no left edge to be
// centred in: the window root pads 8px and paints it in `--bg-sidebar`, the rail's own
// background, so the strip dissolves into the window on that side. The only edge is the seam —
// and a gap ends where that line starts, not where it ends.
//
// The column a person actually sees therefore runs from the window edge (rail-local −8) to the
// seam's inner edge (rail-local 43): 51px, centred at 17.5. Against the old 22 every element read
// 3.5px right of centre, which is exactly what the user reported and what four passes could not
// see, because all four agreed on the reference.
const WINDOW_PAD = 8   // DashboardView's root padding, painted in the rail's own background
const SEAM_W = 1       // the rail's right border — the boundary, not part of the gap
const CENTRE = (RAIL_W - SEAM_W - WINDOW_PAD) / 2

// INTENDED VERTICAL RHYTHM, stated up front so the table has something to be measured against.
// The foot is two groups of two around a seam, and the seam's whole job is to out-space what it
// divides — so the claim is not "the gaps are equal", it is:
//
//   tile → tile          equal for every pair, whatever the ring/pip state of either
//   last tile → foot     a group boundary: larger than any gap inside the foot
//   robot → usage        pair A
//   usage → seam    ─┐   equal ABOVE and BELOW the seam — the seam is centred in its own air
//   seam  → grid    ─┘   and both are larger than a pair gap
//   grid  → plus         pair B, equal to pair A
//
// Pair A and pair B being equal is the "2 + 2" reading; the seam being centred is what stops the
// foot reading as five items in a row.
const TOL = 0.75 // px. Below this is antialiasing, not misalignment.

const b64 = (buf) => buf.toString('base64')

async function boot(theme) {
  const browser = await webkit.launch()
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: theme.endsWith('light') ? 'light' : 'dark',
    // The ink is measured in DEVICE pixels and reported in CSS px, so 2x buys half-pixel
    // resolution — which is the scale every one of these defects has lived at.
    deviceScaleFactor: 2,
  })
  await ctx.addInitScript(([names, t]) => {
    try { localStorage.setItem('operator.theme', t) } catch { /* quota */ }
    let real
    Object.defineProperty(window, 'operator', {
      configurable: true, get: () => real,
      set: (v) => {
        real = v
        const oP = v.loadProjects, oS = v.loadSessions, oT = v.terminalList
        const extras = names.map((name, i) => ({
          id: `${name}-id`, name, path: `/Users/x/${name}`,
          createdAt: '2026-07-01T00:00:00.000Z',
          lastActiveAt: `2026-07-${String(10 + i).padStart(2, '0')}T00:00:00.000Z`,
        }))
        // A project reaches the rail only through ACTIVITY, and activity is rolled up from
        // terminals joined to saved sessions — so a synthetic live project needs both.
        v.loadProjects = async () => [...((await oP()) ?? []), ...extras]
        v.saveProjects = () => {}
        v.terminalList = async () => {
          const base = (await oT()) ?? []
          return [...base, ...extras.map((e, i) => ({ id: `tx${i}`, pid: 0, cwd: e.path, command: 'claude', alive: true }))]
        }
        v.loadSessions = async () => {
          const base = (await oS()) ?? []
          return [...base, ...extras.map((e, i) => ({
            key: `key-tx${i}`, cwd: e.path, projectName: e.name, projectId: e.id,
            claudeSessionId: `s-${e.id}`, terminalId: `tx${i}`, lastActiveAt: e.lastActiveAt,
          }))]
        }
      },
    })
  }, [NAMES, theme])
  const p = await ctx.newPage()
  p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))
  await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
  // Long enough for the your-turn pulse to SETTLE (PULSE_SETTLE_MS = 6s). A pip that changes
  // opacity between the two frames of a diff reads as ink appearing out of nowhere.
  await p.waitForTimeout(8000)
  return { browser, p }
}

/** The rail's own rect, found the way the other rail drivers find it. */
const railRect = (p) => p.evaluate(() => {
  const el = document.querySelector('[data-rail-gallery]')?.closest('div[style*="44px"]')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, width: r.width, height: r.height }
})

/** Decode two PNGs in-page and return the bounding box of every pixel that differs, in CSS px
 *  relative to the clip's origin. This is the whole measurement — everything else is bookkeeping. */
async function diffBox(p, before, after, w) {
  return p.evaluate(async ([a, c, cssW]) => {
    const load = (s) => new Promise((res, rej) => {
      const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = 'data:image/png;base64,' + s
    })
    const [A, B] = await Promise.all([load(a), load(c)])
    const cw = A.width, ch = A.height
    const data = (im) => {
      const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch
      const x = cv.getContext('2d', { willReadFrequently: true })
      x.drawImage(im, 0, 0)
      return x.getImageData(0, 0, cw, ch).data
    }
    const da = data(A), db = data(B)
    const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, n = 0, sumL = 0, sumC = 0
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const i = (y * cw + x) * 4
        // PNG is lossless and WebKit's raster is deterministic, so an unchanged pixel differs by
        // exactly 0. The threshold only discards the very faintest antialiasing tail, where a
        // 1/255 difference is not ink anybody can see.
        const d = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2])
        if (d > 6) {
          n++
          if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y
          // WEIGHT and CHROMA of the ink itself, not just where it is. "Balanced" is a claim
          // about how loud each control reads, and four glyphs can be identical in size and
          // still not read as a set — which is a thing a geometry table cannot see.
          sumL += Math.abs(lum(da, i) - lum(db, i))
          sumC += Math.max(da[i], da[i + 1], da[i + 2]) - Math.min(da[i], da[i + 1], da[i + 2])
        }
      }
    }
    if (!n) return null
    const s = cw / cssW
    return {
      left: minX / s, right: (maxX + 1) / s, top: minY / s, bottom: (maxY + 1) / s,
      // Total ink energy, normalised to CSS px² so it is comparable across device scales.
      px: n / (s * s), weight: (sumL / n), chroma: (sumC / n),
    }
  }, [before, after, w])
}

/** Painted extent of one element: hide it, diff, put it back. `mute` lets a non-hideable painter
 *  (the rail's own inset seam shadow) be silenced the same way.
 *
 *  THE BASE IS RE-TAKEN FOR EVERY ELEMENT, immediately before hiding it, and that is not
 *  belt-and-braces. Against one base captured at the top of the scene, ANY later repaint in the
 *  strip — a settle timer firing, a focus ring, a hover tint — lands in the diff of every element
 *  measured after it and is indistinguishable from ink. It showed up as one palette reporting six
 *  different elements with byte-identical bounds of 8.00–44.00, which is the tell: real ink from
 *  six different glyphs cannot agree to the pixel. Four passes over this strip trusted numbers
 *  they could not tell had drifted; a driver that can drift silently is worth less than none. */
async function ink(p, clip, sel, mute) {
  const base = await p.screenshot({ clip, animations: 'disabled' })
  const ok = await p.evaluate(([s, m]) => {
    const el = document.querySelector(s)
    if (!el) return false
    el.dataset.inkPrev = m ? el.style.boxShadow : el.style.visibility
    if (m) el.style.boxShadow = 'none'; else el.style.visibility = 'hidden'
    return true
  }, [sel, !!mute])
  if (!ok) return null
  const after = await p.screenshot({ clip, animations: 'disabled' })
  await p.evaluate(([s, m]) => {
    const el = document.querySelector(s)
    if (m) el.style.boxShadow = el.dataset.inkPrev || ''
    else el.style.visibility = el.dataset.inkPrev || ''
    delete el.dataset.inkPrev
  }, [sel, !!mute])
  const box = await diffBox(p, b64(base), b64(after), clip.width)
  return box
}

const f = (n, w = 6, d = 2) => (n === null || n === undefined ? '—'.padStart(w) : n.toFixed(d).padStart(w))
const pad = (s, w) => String(s).padEnd(w)

async function measure(p, label) {
  const rr = await railRect(p)
  const clip = { x: rr.left, y: rr.top, width: rr.width, height: rr.height }

  const tiles = await p.evaluate(() => [...document.querySelectorAll('[data-rail-tile]')].map((t) => ({
    id: t.getAttribute('data-rail-tile'),
    ring: getComputedStyle(t).boxShadow !== 'none',
    pip: !!t.querySelector('[data-rail-pip]'),
  })))

  const targets = []
  for (const t of tiles) {
    const s = `[data-rail-tile="${t.id}"]`
    const name = t.id.replace(/-[0-9a-f]{8}$/, '').replace(/-id$/, '').slice(0, 14)
    targets.push({ key: `tile ${name}`, state: (t.ring ? 'ringed' : 'plain') + (t.pip ? '+pipped' : ''), sel: s, stack: true, tile: name })
    targets.push({ key: '  └ acronym', state: 'text ink', sel: `${s} [data-rail-initials]`, within: name })
    // Deliberately off-axis: it is a CORNER pip. Held to "does not widen its tile" instead.
    if (t.pip) targets.push({ key: '  └ pip', state: 'corner', sel: `${s} [data-rail-pip]`, offAxis: true, within: name })
  }
  targets.push({ key: 'foot robot', state: 'glyph', sel: '[data-rail-agents] svg', stack: true, glyph: true })
  targets.push({ key: 'foot usage ring', state: 'glyph', sel: '[data-rail-usage] svg', stack: true, glyph: true })
  targets.push({ key: 'foot seam', state: 'rule', sel: '[data-rail-seam]', stack: true })
  targets.push({ key: 'foot grid', state: 'glyph', sel: '[data-rail-gallery] svg', stack: true, glyph: true })
  targets.push({ key: 'foot plus', state: 'glyph', sel: '[data-rail-open-folder] svg', stack: true, glyph: true })
  // Deliberately off-axis: it is the rail's own right EDGE. Held to "paints inside the 44".
  targets.push({ key: 'rail seam (vertical)', state: 'right edge', sel: '[data-rail-gallery]', mute: true, vertical: true, offAxis: true })

  const rows = []
  for (const t of targets) {
    // The vertical seam is painted by the rail CONTAINER, not by the element the selector names.
    const sel = t.vertical ? 'div[style*="44px"]:has([data-rail-gallery])' : t.sel
    const box = await ink(p, clip, sel, t.mute)
    rows.push({ ...t, box })
  }
  return { label, rr, rows }
}

function report(m) {
  console.log(`\n${'='.repeat(98)}\n  ${m.label}   rail x=${m.rr.left.toFixed(2)} w=${m.rr.width.toFixed(2)} h=${m.rr.height.toFixed(0)}  → column centre ${CENTRE}\n${'='.repeat(98)}`)
  console.log('H · PAINTED CENTRE — every element that belongs on the axis')
  console.log(pad('ELEMENT', 24) + pad('STATE', 15) + '  INK L    INK R   WIDTH   CENTRE   Δaxis    INK T     INK B')
  console.log('-'.repeat(98))
  let worst = 0
  for (const r of m.rows) {
    if (r.offAxis) continue
    if (!r.box) { console.log(pad(r.key, 24) + pad(r.state, 15) + '   (paints nothing)'); continue }
    const c = (r.box.left + r.box.right) / 2
    const d = c - CENTRE
    if (Math.abs(d) > Math.abs(worst)) worst = d
    console.log(
      pad(r.key, 24) + pad(r.state, 15) +
      f(r.box.left) + f(r.box.right) + f(r.box.right - r.box.left) + f(c, 8) +
      f(d, 7) + (Math.abs(d) > TOL ? ' ◀' : '  ') +
      f(r.box.top, 8, 1) + f(r.box.bottom, 9, 1),
    )
  }
  console.log('-'.repeat(98))
  console.log(`H: worst painted-centre delta ${worst >= 0 ? '+' : ''}${worst.toFixed(2)}px  (tolerance ±${TOL})`)

  // ---- O. the two elements that are off the axis ON PURPOSE ---------------------------------
  console.log('\nO · OFF-AXIS BY DESIGN — held to their own invariant, not to the centre line')
  const tileBox = (name) => m.rows.find((r) => r.tile === name)?.box
  for (const r of m.rows.filter((x) => x.offAxis && x.box)) {
    if (r.within) {
      const t = tileBox(r.within)
      const over = Math.max(r.box.right - t.right, r.box.bottom - t.bottom)
      console.log(`  pip on ${pad(r.within, 14)} ink ${f(r.box.left)} ..${f(r.box.right)}   widens its tile by ${f(over, 6)}px` +
        (over > 0.01 ? '  ◀ OFF — a pip that paints past the box moves the tile off the axis' : '  ok'))
    } else {
      const inside = r.box.right <= RAIL_W + 0.01
      console.log(`  rail seam        ink ${f(r.box.left)} ..${f(r.box.right)}   inside the ${RAIL_W}px footprint: ${inside ? 'yes  ok' : 'NO  ◀ OFF'}`)
    }
  }

  // ---- S. the foot's four glyphs, by painted ink size ---------------------------------------
  console.log('\nS · FOOT GLYPH INK — identical 26×26 boxes, which is why this went unseen')
  console.log('  ' + pad('GLYPH', 14) + '  SIZE            AREA    WEIGHT   CHROMA')
  const glyphs = m.rows.filter((r) => r.glyph && r.box)
  for (const r of glyphs) {
    console.log('  ' + pad(r.key.replace('foot ', ''), 14) +
      `${f(r.box.right - r.box.left, 6, 2)} × ${f(r.box.bottom - r.box.top, 5, 2)}` +
      f(r.box.px, 9, 1) + f(r.box.weight, 9, 1) + f(r.box.chroma, 9, 1))
  }
  const ws = glyphs.map((r) => r.box.right - r.box.left), hs = glyphs.map((r) => r.box.bottom - r.box.top)
  const sizeSpread = Math.max(Math.max(...ws) - Math.min(...ws), Math.max(...hs) - Math.min(...hs))
  console.log(`  spread ${sizeSpread.toFixed(2)}px across four controls in a column` + (sizeSpread > 1 ? '  ◀ OFF' : '  ok'))

  // ---- V. the rhythm -----------------------------------------------------------------------
  const stack = m.rows.filter((r) => r.stack && r.box)
  console.log('\nVERTICAL RHYTHM — painted ink gaps down the strip')
  console.log(pad('  FROM → TO', 46) + '   GAP')
  const gaps = []
  for (let i = 1; i < stack.length; i++) {
    const g = stack[i].box.top - stack[i - 1].box.bottom
    gaps.push({ from: stack[i - 1].key.trim(), to: stack[i].key.trim(), gap: g })
    console.log(pad(`  ${stack[i - 1].key.trim()} → ${stack[i].key.trim()}`, 46) + f(g, 7, 2))
  }
  const g = (from, to) => gaps.find((x) => x.from.startsWith(from) && x.to.startsWith(to))?.gap
  // Tile gaps, PARTITIONED by whether the ring is one of the two neighbours. The ring is 2px of
  // ink outside the box, so a pair beside the current tile necessarily clears 2 less — that is
  // the marker being a marker, not the stack being irregular, and PITCH is the invariant that
  // proves it (constant 40 regardless of state). Asserting one flat number here would leave a
  // permanently-failing row, and a table with a known-failing row is a table nobody rereads.
  const ringed = new Set(m.rows.filter((r) => r.tile && r.state.startsWith('ringed')).map((r) => r.tile))
  const isRingPair = (x) => [...ringed].some((n) => x.from.endsWith(n) || x.to.endsWith(n))
  const allTileGaps = gaps.filter((x) => x.from.startsWith('tile') && x.to.startsWith('tile'))
  const tileGaps = allTileGaps.filter((x) => !isRingPair(x)).map((x) => x.gap)
  const ringGaps = allTileGaps.filter(isRingPair).map((x) => x.gap)
  const pairA = g('foot robot', 'foot usage')
  const seamAbove = g('foot usage', 'foot seam')
  const seamBelow = g('foot seam', 'foot grid')
  const pairB = g('foot grid', 'foot plus')
  const spread = (xs) => (xs.length ? Math.max(...xs) - Math.min(...xs) : 0)
  // PITCH, alongside the gap. A ring is 2px of ink OUTSIDE the tile, so it necessarily narrows
  // the visible gap either side of the current tile — but it must not move the tile. Pitch is
  // what separates "the marker is bigger" (fine) from "the stack is irregular" (not).
  const tileRows = m.rows.filter((r) => r.tile && r.box)
  const pitches = []
  for (let i = 1; i < tileRows.length; i++) {
    const a = tileRows[i - 1].box, c = tileRows[i].box
    pitches.push(((c.top + c.bottom) / 2) - ((a.top + a.bottom) / 2))
  }
  console.log(`\n  tile pitch (painted centre → centre): ${pitches.map((x) => x.toFixed(1)).join(' / ')}   spread ${spread(pitches).toFixed(2)}`)
  console.log('\n  CLAIM                                        MEASURED                     Δ')
  const claim = (name, val, expect, note) => {
    const bad = Math.abs(val - expect) > TOL
    console.log('  ' + pad(name, 43) + pad(note, 29) + f(val - expect, 6) + (bad ? '  ◀ OFF' : '  ok'))
    return !bad
  }
  const okTiles = claim('tile pitch constant', spread(pitches), 0, pitches.map((x) => x.toFixed(1)).join(' / '))
  const okGaps = claim('plain pairs: ink gap constant', spread(tileGaps), 0, tileGaps.map((x) => x.toFixed(1)).join(' / '))
    && claim('ring pairs: exactly 2px tighter', spread(ringGaps.map((g) => g + 2).concat(tileGaps)), 0,
      ringGaps.map((x) => x.toFixed(1)).join(' / ') + ' (ring ink)')
  const okPairs = claim('pair A == pair B', pairA ?? 0, pairB ?? 0, `A ${f(pairA, 5, 1)}   B ${f(pairB, 5, 1)}`)
  const okSeam = claim('seam centred in its own air', seamAbove ?? 0, seamBelow ?? 0, `above ${f(seamAbove, 5, 1)}  below ${f(seamBelow, 5, 1)}`)
  const okOut = (seamAbove ?? 0) > (pairA ?? 0) && (seamBelow ?? 0) > (pairB ?? 0)
  console.log('  ' + pad('seam out-spaces the pairs it divides', 43) + pad(okOut ? 'yes' : 'NO', 29) + '      ' + (okOut ? '  ok' : '  ◀ OFF'))
  return { worst, okTiles: okTiles && okGaps, okPairs, okSeam, okOut, sizeSpread }
}

// ---------------------------------------------------------------------------------------------
const summary = []
for (const [theme, short] of THEMES) {
  const { browser, p } = await boot(theme)

  // Scene 1 — as it comes up: the current project is ringed AND pipped, one neighbour is pipped
  // only, the seeded four are plain. Three of the four tile states in one frame.
  const m1 = await measure(p, `${short} · at rest`)
  const r1 = report(m1)

  // Scene 2 — click a PLAIN tile so it becomes current: ringed WITHOUT a pip, the fourth state
  // and the one no scene produces on its own.
  await p.locator('[data-rail-tile]').nth(2).click()
  // Park the cursor and the focus OFF the strip, then outwait the your-turn settle timer
  // (PULSE_SETTLE_MS = 6s), which a click re-arms. Both are repaints that would otherwise land
  // in the middle of a measurement.
  await p.mouse.move(700, 450)
  await p.evaluate(() => document.activeElement?.blur?.())
  await p.waitForTimeout(7000)
  const m2 = await measure(p, `${short} · after selecting a plain tile (ringed, no pip)`)
  const r2 = report(m2)

  await p.screenshot({ path: `/tmp/operator-shots/rail-invariant-${short.replace('·', '-')}.png`, clip: { x: m2.rr.left, y: 0, width: 60, height: 900 } })
  summary.push({
    short, worst: Math.max(Math.abs(r1.worst), Math.abs(r2.worst)),
    rhythm: r1.okTiles && r1.okPairs && r1.okSeam && r1.okOut,
    size: Math.max(r1.sizeSpread, r2.sizeSpread),
  })
  await browser.close()
}

console.log('\n' + '='.repeat(60))
console.log(pad('PALETTE', 12) + pad('WORST |Δaxis|', 14) + pad('GLYPH SPREAD', 15) + 'RHYTHM')
for (const s of summary) console.log(pad(s.short, 12) + pad(s.worst.toFixed(2) + 'px', 14) + pad(s.size.toFixed(2) + 'px', 15) + (s.rhythm ? 'ok' : 'OFF'))
const bad = summary.filter((s) => s.worst > TOL || !s.rhythm || s.size > 1)
console.log(bad.length ? `\nNOT CLEAN on ${bad.length}/${summary.length} palettes` : '\nCLEAN on every palette measured')
