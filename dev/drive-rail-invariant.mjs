// THE LEFT STRIP'S INVARIANTS, asserted over every element — dev/briefs/rail-assert-the-invariant.md
//
// Four passes fixed this strip by eye, each measured something real, each reported success, and
// the user still saw it wrong a fourth time. The common failure is not arithmetic — it is that
// every one of them measured a HANDLE (a border box, a shadow spread, an svg's shape rects)
// rather than the ink. `getBoundingClientRect` on a row excludes its ring; on an svg it excludes
// the stroke's outer half; on a spacer it reports space no pixel covers. So each pass could be
// correct about its own number and blind to the pixels.
//
// This driver measures PAINTED EXTENT and nothing else, by difference:
//
//     screenshot the strip  →  `visibility: hidden` on ONE element  →  screenshot again
//     the pixels that changed ARE that element's ink, whatever drew them
//
// `visibility: hidden` suppresses painting without reflowing, so nothing else can move between
// the two frames. The diff catches box-shadow rings, stroke overshoot, round line caps, glyph
// side bearings and antialiasing tails — every channel that made a box lie.
//
// WHAT CHANGED WITH D1 (the joined surface), and why this file changed with it. The harness's own
// header has recorded this failure once already — `RAIL_W = 44` hardcoded while the rail grew to
// 52 — and its own rule is that *"a harness that fails on a correct change teaches you to ignore
// it, which is worse than not having it."* So, in the same commit as the change:
//   • `data-rail-tile` / `data-rail-initials` are gone. A project is a NAME now
//     (`data-rail-project-header`), not an acronym in a square, and it still carries
//     `data-rail-accent` so the identity colour can be asserted never to move.
//   • the foot is EIGHT glyphs in four pairs around THREE hairlines, not four around one.
//   • the element is 60 (the visible strip is 68 — see ProjectRail's own note), not 44.
//   • `NAMES` carries two ADJACENT groups whose ids hash to the SAME accent. Colour now does
//     grouping work, so "two adjacent groups the same colour must not read as one group" needs a
//     fixture rather than a hope.
//
// SIX ASSERTIONS
//   H. every element in the MEMBER COLUMN has its painted centre x on the optical axis — 26 in
//      rail-local coordinates, the centre of the visible 68px strip. Reported as a signed delta,
//      never a pass/fail: the size of the error is the diagnosis.
//   X. THE ORB DOES NOT RESIZE between states, and the COLLAPSED axis stays at 30 element-local /
//      38 from the window edge. This assertion used to also require the orb's painted centre to be
//      IDENTICAL at both widths — see the note at the check itself for why that half is retired.
//   L. ONE LEFT EDGE, expanded: the header's text, the open group's path, the orb and the `+`
//      all start at the same x.
//   Y. the four foot ROWS land on identical y at both widths (Arrangement A's whole claim — the
//      bottom of the strip is as fixed as the member column).
//   B. ⌘B removes NONE of the eight foot controls. That is the live defect D1 fixes: collapsing
//      used to unmount the sidebar and take the theme toggle, Preferences and both `.claude`
//      shortcuts with it.
//   S. the eight foot glyphs carry the same painted INK SIZE. They sit in identical 24×24 boxes,
//      which is exactly why nobody noticed they didn't.
//   V. the painted gaps follow a stated rhythm (see RHYTHM below).
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
// `THEMES=all` sweeps all six; `THEMES=mission-control-light,1984-light` runs a named subset,
// which is what makes a one-glyph fix cheap to re-check instead of a ten-minute full sweep.
const THEMES = process.env.THEMES === 'all' ? ALL_THEMES
  : process.env.THEMES ? ALL_THEMES.filter(([t]) => process.env.THEMES.split(',').includes(t))
    : [ALL_THEMES[0]]
// THE FIXTURE CARRIES ITS OWN IDS, because the accent is hashed from the ID, not the name — so
// "web27 and Mise-landing collide" is only true of the ids in the real store. `Mise-landing-6` is
// picked to hash to the same swatch as `web27-id` (FNV-1a mod 11), which makes the two ADJACENT
// groups the same colour: the fixture for "colour must never be what separates two groups".
// `Mise-landing` is also the longest name here, so it is the one that has to ellipsise, not clip.
const NAMES = [
  { name: 'fastrack', id: 'fastrack-id' },
  { name: 'uwazi-app', id: 'uwazi-app-id' },
  { name: 'web27', id: 'web27-id' },
  { name: 'Mise-landing', id: 'Mise-landing-6' },
]

// The strip's own geometry, as declared in ProjectRail.tsx. Everything is asserted against these,
// not against whatever the DOM happens to report — a driver that derives its expectation from the
// thing it is testing agrees with any bug that is internally consistent.
const RAIL_W = 70
const RAIL_W_OPEN = 264
/** Zero — see ProjectRail's own note. It was 8 while the strip had a right-hand seam to stop
 *  short of; deleting the seam moved the visible boundary and the inset was never re-derived. */
const CONTENT_INSET_R = 0
/** `DashboardView`'s root padding, painted in the strip's own colour. The column a person sees
 *  runs from the WINDOW EDGE to the card's edge — 0 → 86 — so its centre is 43, and that is the
 *  number this driver checks. Asserting only that the elements agree with each other at their
 *  element-local axis is what let a 4px error stand: they agreed perfectly, at 34 when the column
 *  ran 0 → 76. */
const WINDOW_PAD = 8
const OPTICAL_CENTRE = 43
/** The optical axis. The strip has NO right-hand seam any more, so the column runs to the rail's
 *  own edge and the axis is simply the field's midpoint: (70 − 0) / 2 = 35 element-local, 43 from
 *  the window edge, the centre of the visible 78px strip. (Subtracting a right inset is what got
 *  this wrong twice: (60 − 8) / 2 = 26 was the seam-era derivation and it survived the seam.)
 *
 *  The old derivation subtracted a 1px seam that was an INSET BOX-SHADOW — which does not reduce
 *  the content box — so the prose centred at 29.5 while the CSS centred at 30.0. A standing 0.5px
 *  error, and one this driver would have reported as noise rather than as a defect. Deriving it
 *  from the measured width keeps the number honest at either width. */
/** THE MEMBER COLUMN'S AXIS DOES NOT MOVE WITH THE WIDTH — that is the invariant, not a
 *  consequence of it. Deriving it from the measured width would hold the expanded strip to 128,
 *  i.e. would demand that the orbs re-centre themselves in the wider box, which is the exact
 *  behaviour D1 exists to forbid. One number, both scenes. */
const AXIS = (RAIL_W - CONTENT_INSET_R) / 2
/** THE ⌘B ORB SLIDE, and the reason `ROW_INSET_L` has the value it has. See assertion X: this is a
 *  chosen number, not a derived one, and it is asserted here so that choosing a new `RAIL_W` cannot
 *  quietly change it. `rail-metrics.ts` carries the same 10 as prose beside the inset it solves. */
const ORB_SLIDE = 10

// INTENDED VERTICAL RHYTHM, stated up front so the table has something to be measured against.
// The foot is four pairs around three hairlines, and a hairline's whole job is to out-space what
// it divides — so the claim is not "the gaps are equal", it is:
//
//   member → member      equal for every pair in a group, whatever its state
//   row → hairline       equal above and below every hairline (each is centred in its own air)
//   foot row pitch       equal for all four rows — which is what makes Y (identical y at both
//                        widths) a property of the layout rather than a coincidence
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
    try {
      localStorage.setItem('operator.theme', t)
      // Deterministic starting width. The strip persists its own collapsed state, so without
      // this the first scene depends on whatever the last run left behind.
      localStorage.setItem('operator.sidebarCollapsed', '1')
      // THE FOOT IS UNFOLDED FOR THIS SWEEP. Four of the eight controls fold away by default now
      // (see `lib/rail-foot` for which and why), and assertions B and S are about all EIGHT
      // glyphs — their painted ink and their survival across ⌘B. A harness that measured only the
      // four resting ones would silently stop asserting the thing it exists for. The fold's OWN
      // behaviour — what disappears, how much height it returns, that it persists — is asserted
      // by `dev/drive-rail-foot-fold.mjs`, which is the harness that boots it folded.
      localStorage.setItem('operator.railFootExpanded', '1')
    } catch { /* quota */ }
    let real
    Object.defineProperty(window, 'operator', {
      configurable: true, get: () => real,
      set: (v) => {
        real = v
        const oP = v.loadProjects, oS = v.loadSessions, oT = v.terminalList
        const extras = names.map(({ name, id }, i) => ({
          id, name, path: `/Users/x/${name}`,
          createdAt: '2026-07-01T00:00:00.000Z',
          lastActiveAt: `2026-07-${String(10 + i).padStart(2, '0')}T00:00:00.000Z`,
        }))
        // A project reaches the strip only through ACTIVITY, and activity is rolled up from
        // terminals joined to saved sessions — so a synthetic live project needs both.
        // A REALISTIC VERSION STRING. The mock ships `0.8.8-mock`, which is long enough to
        // ellipsise inside the identity row — and a truncated string's ink is bounded by its box,
        // so the row would be exempt from the axis check in every run and the check would assert
        // nothing. The shipped version is `0.13.6`; measure that.
        v.getVersion = async () => '0.13.6'
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
  // Long enough for the your-turn pulse to SETTLE (PULSE_SETTLE_MS = 6s). A dot that changes
  // opacity between the two frames of a diff reads as ink appearing out of nowhere.
  await p.waitForTimeout(8000)
  return { browser, p }
}

/** The strip's own rect. `[data-rail]` on its root, NOT a width-keyed selector — that was keyed to
 *  the literal 44 and stopped matching the moment the strip legitimately grew. */
const railRect = (p) => p.evaluate(() => {
  const el = document.querySelector('[data-rail]')
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
        // exactly 0. The threshold only discards the very faintest antialiasing tail.
        const d = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2])
        if (d > 6) {
          n++
          if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y
          // WEIGHT and CHROMA of the ink itself, not just where it is. "Balanced" is a claim
          // about how loud each control reads, and eight glyphs can be identical in size and
          // still not read as a set — which a geometry table cannot see.
          sumL += Math.abs(lum(da, i) - lum(db, i))
          sumC += Math.max(da[i], da[i + 1], da[i + 2]) - Math.min(da[i], da[i + 1], da[i + 2])
        }
      }
    }
    if (!n) return null
    const s = cw / cssW
    return {
      left: minX / s, right: (maxX + 1) / s, top: minY / s, bottom: (maxY + 1) / s,
      px: n / (s * s), weight: (sumL / n), chroma: (sumC / n),
    }
  }, [before, after, w])
}

/** Painted extent of one element: hide it, diff, put it back.
 *
 *  THE BASE IS RE-TAKEN FOR EVERY ELEMENT, immediately before hiding it, and that is not
 *  belt-and-braces. Against one base captured at the top of the scene, ANY later repaint in the
 *  strip — a settle timer firing, a focus ring, a hover tint — lands in the diff of every element
 *  measured after it and is indistinguishable from ink. */
async function ink(p, clip, sel, attempt = 0) {
  const base = await p.screenshot({ clip, animations: 'disabled' })
  const rect = await p.evaluate(([s, cx, cy]) => {
    const el = document.querySelector(s)
    if (!el) return null
    const r = el.getBoundingClientRect()
    el.dataset.inkPrev = el.style.visibility
    el.style.visibility = 'hidden'
    return { left: r.left - cx, right: r.right - cx, top: r.top - cy, bottom: r.bottom - cy }
  }, [sel, clip.x, clip.y])
  if (!rect) return null
  const after = await p.screenshot({ clip, animations: 'disabled' })
  await p.evaluate((s) => {
    const el = document.querySelector(s)
    el.style.visibility = el.dataset.inkPrev || ''
    delete el.dataset.inkPrev
  }, sel)
  const box = await diffBox(p, b64(base), b64(after), clip.width)
  // A DIFF IS ONLY THIS ELEMENT'S INK IF NOTHING ELSE REPAINTED BETWEEN THE TWO FRAMES. Anything
  // that did — a settle timer, a status change arriving, a hover tint — lands in the diff and is
  // indistinguishable from ink, which is how one palette once reported a foot glyph as 50 × 815
  // (i.e. the whole strip). An element cannot paint far outside its own box, so a box that does is
  // contamination, not a finding: re-measure rather than report it. Ornaments (a ring, a shadow)
  // legitimately overhang, hence the slack.
  const SLACK = 8
  const contaminated = box && (
    box.left < rect.left - SLACK || box.right > rect.right + SLACK ||
    box.top < rect.top - SLACK || box.bottom > rect.bottom + SLACK
  )
  if (contaminated && attempt < 2) {
    console.log(`    (re-measuring ${sel} — something else repainted between frames)`)
    return ink(p, clip, sel, attempt + 1)
  }
  return box
}

const f = (n, w = 6, d = 2) => (n === null || n === undefined ? '—'.padStart(w) : n.toFixed(d).padStart(w))
const pad = (s, w) => String(s).padEnd(w)

/** The eight foot controls, in the order they are drawn — four pairs around three hairlines. */
/** Does an update affordance ride beside the version right now? Printed in the scene label,
 *  because "centred with the button" and "centred without it" are two different claims and the
 *  one that regresses silently is the one you only see when a release is pending. */
const updateShowing = (p) => p.evaluate(() => !!document.querySelector('[data-rail-identity-row] button'))

const FOOT = [
  ['agents', '[data-rail-agents]'], ['usage', '[data-rail-usage]'],
  ['gallery', '[data-rail-gallery]'], ['open folder', '[data-rail-open-folder]'],
  ['.claude', '[data-rail-folder-prefs]'], ['~/.claude', '[data-rail-global-prefs]'],
  ['prefs', '[data-rail-prefs]'], ['theme', '[data-rail-theme]'],
]

async function measure(p, label) {
  const rr = await railRect(p)
  label = `${label} · update ${(await updateShowing(p)) ? 'pending' : 'absent'}`
  const clip = { x: rr.left, y: rr.top, width: rr.width, height: rr.height }
  const collapsed = rr.width < (RAIL_W + RAIL_W_OPEN) / 2

  const groups = await p.evaluate(() => [...document.querySelectorAll('[data-rail-project-header]')]
    .map((h) => ({
      id: h.getAttribute('data-rail-project-header'),
      accent: h.getAttribute('data-rail-accent'),
      // A name too long for the field is ELLIPSISED, and a truncated string's ink is bounded by
      // the field rather than placed by centring — where its last glyph lands is where WebKit put
      // an ellipsis, not a statement about the axis. Measured, not assumed: this is read off the
      // DOM per name, so a name that starts fitting is asserted again automatically.
      truncated: h.scrollWidth > h.clientWidth,
    })))
  // `[data-rail-orb]`, which BOTH states carry — the collapsed disc and the expanded row's orb
  // are the same object at the same x, and that is the invariant. Keying this to the collapsed
  // button (`data-rail-session`) measured nothing at 264 and reported the orbs as "vanished",
  // which is a harness bug that looks exactly like the defect it is meant to catch.
  const orbs = await p.evaluate(() => [...document.querySelectorAll('[data-rail-orb]')]
    .map((o) => o.getAttribute('data-rail-orb')))
  const homes = await p.evaluate(() => document.querySelectorAll('[data-rail-home]').length)

  const targets = []
  for (const g of groups) {
    const name = g.id.replace(/-(id|\d+)$/, '').slice(0, 14)
    targets.push({
      key: `header ${name}${g.truncated ? ' ✂' : ''}`, state: g.truncated ? 'name ink (cut)' : 'name ink',
      sel: `[data-rail-project-header="${g.id}"]`,
      accent: g.accent,
      // Collapsed the name is centred in the field; expanded it is left-aligned at the margin,
      // which is deliberate and is why it is only held to the axis at 60. A truncated name is
      // exempt at both widths — see `truncated` above.
      offAxis: !collapsed || g.truncated,
    })
  }
  // MEMBER-COLUMN ITEMS ARE HELD TO THE AXIS WHEN COLLAPSED ONLY. Expanded they start at the
  // row's own left edge with the header and the `+` — see assertion L, and the retirement note at
  // assertion X. Measured in both scenes either way: the numbers are the diagnosis, and the orb's
  // SIZE is still gated at both widths.
  for (const id of orbs.slice(0, 3)) {
    targets.push({ key: `  └ orb ${id.slice(-6)}`, state: 'disc', sel: `[data-rail-orb="${id}"]`, orb: id, member: true, offAxis: !collapsed })
  }
  if (homes) targets.push({ key: '  └ home', state: 'mark', sel: '[data-rail-home-mark]', member: true, offAxis: !collapsed })
  // THE VERSION LINE, which went unmeasured until it was the last thing in the strip still off the
  // axis — the harness reported CLEAN through all of it. Measured as the ROW, not as the version
  // span: when an update is pending the affordance rides beside it and the pair has to centre as
  // one unit, which a probe on the text alone cannot see.
  // …and exempt it if it IS cut, on the same rule as a cut name: where an ellipsis lands is not
  // a statement about the axis. With a version that fits, this never fires — which is the point of
  // fixturing one that does.
  const versionCut = await p.evaluate(() => {
    const el = document.querySelector('[data-rail-identity-row] span')
    return !!el && el.scrollWidth > el.clientWidth
  })
  targets.push({
    key: `identity row${versionCut ? ' ✂' : ''}`, state: versionCut ? 'version (cut)' : 'version',
    sel: '[data-rail-identity-row]', offAxis: versionCut,
  })
  // The `+` of "Start an agent" — expanded only, so the collapsed pass measures nothing and that
  // is correct. Off the axis by design: it is left-aligned in its column so that shrinking it
  // could not move the left ink edge FIX-5 put there.
  targets.push({ key: '  └ + add lane', state: 'glyph', sel: '[data-rail-add-lane] svg', plus: true, offAxis: true })
  for (const [name, sel] of FOOT) {
    targets.push({ key: `foot ${name}`, state: 'glyph', sel: `${sel} svg`, glyph: true, foot: true, offAxis: true })
  }

  const rows = []
  for (const t of targets) {
    rows.push({ ...t, box: await ink(p, clip, t.sel) })
  }
  // The foot's ROWS and its hairlines, measured as boxes rather than by ink: a row is a
  // container, and Y is a claim about where the row sits, not about what it paints.
  // The two vertical gaps rule 3 is about, as BOXES: the ink gap between two tinted rows is the
  // tint's own edge, which is the thing a person sees butting or breathing.
  const gaps = await p.evaluate(() => {
    const r2 = (n) => Math.round(n * 100) / 100
    const rows = [...document.querySelectorAll('[data-rail-orb]')]
      .map((o) => o.closest('[role="button"], button')?.getBoundingClientRect()).filter(Boolean)
    const member = rows.length > 1 ? r2(rows[1].top - rows[0].bottom) : null
    const groups = [...document.querySelectorAll('[data-rail-group]')].map((g) => {
      const cs = getComputedStyle(g)
      return { top: parseFloat(cs.marginTop) || 0, pad: parseFloat(cs.paddingTop) || 0 }
    })
    // The visible separation between two groups: the second's margin plus its padding, with the
    // hairline drawn between them.
    const group = groups.length > 1 ? r2(groups[1].top + groups[1].pad) : null
    return { member, group }
  })
  const foot = await p.evaluate(() => {
    const rail = document.querySelector('[data-rail]').getBoundingClientRect()
    const r2 = (n) => Math.round(n * 100) / 100
    return {
      rows: [...document.querySelectorAll('[data-rail-foot-row]')].map((r) => {
        const b = r.getBoundingClientRect()
        return { top: r2(b.top - rail.top), h: r2(b.height) }
      }),
      seams: [...document.querySelectorAll('[data-rail-seam]')].map((s) => {
        const b = s.getBoundingClientRect()
        return { top: r2(b.top - rail.top) }
      }),
      present: [
        'data-rail-agents', 'data-rail-usage', 'data-rail-gallery', 'data-rail-open-folder',
        'data-rail-folder-prefs', 'data-rail-global-prefs', 'data-rail-prefs', 'data-rail-theme',
      ].filter((a) => document.querySelector(`[${a}]`)),
    }
  })
  return { label, rr, rows, foot, gaps, collapsed, groups, orbs, homes }
}

function report(m) {
  const axis = AXIS
  console.log(`\n${'='.repeat(98)}\n  ${m.label}   rail x=${m.rr.left.toFixed(2)} w=${m.rr.width.toFixed(2)} h=${m.rr.height.toFixed(0)}  → axis ${axis} local = ${axis + m.rr.left} from the window edge (want ${OPTICAL_CENTRE})\n${'='.repeat(98)}`)
  console.log('H · PAINTED CENTRE — every element that belongs on the member column')
  console.log(pad('ELEMENT', 24) + pad('STATE', 15) + '  INK L    INK R   WIDTH   CENTRE   Δaxis    INK T     INK B')
  console.log('-'.repeat(98))
  let worst = 0
  for (const r of m.rows) {
    if (!r.box) { console.log(pad(r.key, 24) + pad(r.state, 15) + '   (paints nothing)'); continue }
    const c = (r.box.left + r.box.right) / 2
    const d = c - axis
    if (!r.offAxis && Math.abs(d) > Math.abs(worst)) worst = d
    console.log(
      pad(r.key, 24) + pad(r.state, 15) +
      f(r.box.left) + f(r.box.right) + f(r.box.right - r.box.left) + f(c, 8) +
      (r.offAxis ? '     —  ' : f(d, 7) + (Math.abs(d) > TOL ? ' ◀' : '  ')) +
      f(r.box.top, 8, 1) + f(r.box.bottom, 9, 1),
    )
  }
  console.log('-'.repeat(98))
  console.log(`H: worst painted-centre delta ${worst >= 0 ? '+' : ''}${worst.toFixed(2)}px  (tolerance ±${TOL})`)
  // THE SAME NUMBER IN WINDOW COORDINATES, and it is the one that matters. The elements agreed
  // with each other at 34 for a whole release; what they did not agree with was the middle of the
  // column a person can see (window edge → card edge = 0 → 76). A self-consistent axis is not the
  // claim — 38 is.
  const onAxis = m.rows.filter((r) => !r.offAxis && r.box)
  const fromWindow = onAxis.map((r) => m.rr.left + (r.box.left + r.box.right) / 2)
  const worstWindow = fromWindow.reduce((w, c) => (Math.abs(c - OPTICAL_CENTRE) > Math.abs(w - OPTICAL_CENTRE) ? c : w), OPTICAL_CENTRE)
  console.log(`   painted centre from the WINDOW EDGE: ${fromWindow.map((x) => x.toFixed(2)).join(' / ') || '—'}   want ${OPTICAL_CENTRE}` +
    (Math.abs(worstWindow - OPTICAL_CENTRE) > TOL ? '  ◀ OFF' : '  ok'))

  // ---- S. the foot's eight glyphs, by painted ink size ---------------------------------------
  console.log('\nS · FOOT GLYPH INK — eight identical 24×24 boxes, which is why this goes unseen')
  console.log('  ' + pad('GLYPH', 14) + '  SIZE            AREA    WEIGHT   CHROMA')
  const glyphs = m.rows.filter((r) => r.glyph && r.box)
  for (const r of glyphs) {
    console.log('  ' + pad(r.key.replace('foot ', ''), 14) +
      `${f(r.box.right - r.box.left, 6, 2)} × ${f(r.box.bottom - r.box.top, 5, 2)}` +
      f(r.box.px, 9, 1) + f(r.box.weight, 9, 1) + f(r.box.chroma, 9, 1))
  }
  // SIZE IS THE PAINTED EXTENT — `max(w, h)` — not width and height held separately. A folder is
  // wider than it is tall and a robot has an antenna; forcing every silhouette into one square
  // would distort the drawings to satisfy a number. What must not vary is how BIG each glyph
  // reads in an identical box, which is what caught the gear painting 14 against everyone else's
  // 12 the first time all eight were measured together.
  // THE `+` OF "START AN AGENT", measured the same way but held to a DIFFERENT claim: it is not
  // one of the foot's eight, it is the member column's junior mark, and its rule is "at or just
  // under the orb's painted extent". Sizing it by ink is the fix — it used to paint 24×24, exactly
  // the disc's extent, which is why it read heavier than the thing it sits beneath (a cross
  // reaches the corners of its box; 92px² of ink across the same span as the disc's 405px²).
  const plus = m.rows.find((r) => r.plus)?.box
  const orb = m.rows.find((r) => r.orb)?.box
  if (plus && orb) {
    const pe = Math.max(plus.right - plus.left, plus.bottom - plus.top)
    const oe = Math.max(orb.right - orb.left, orb.bottom - orb.top)
    console.log(`  ${pad('+ (member)', 14)}${f(plus.right - plus.left, 6, 2)} × ${f(plus.bottom - plus.top, 5, 2)}` +
      f(plus.px, 9, 1) + `   against the orb's ${oe.toFixed(2)}` + (pe <= oe + 0.01 ? '  ok' : '  ◀ OFF'))
    if (pe > oe + 0.01) m.plusTooBig = `the + paints ${pe.toFixed(2)}, the orb ${oe.toFixed(2)} — it must be at or under`
  }
  const ws = glyphs.map((r) => r.box.right - r.box.left), hs = glyphs.map((r) => r.box.bottom - r.box.top)
  const extents = glyphs.map((r) => Math.max(r.box.right - r.box.left, r.box.bottom - r.box.top))
  const sizeSpread = glyphs.length ? Math.max(...extents) - Math.min(...extents) : 99
  console.log(`  extent spread ${sizeSpread.toFixed(2)}px across ${glyphs.length} controls` + (sizeSpread > 1 ? '  ◀ OFF' : '  ok') +
    `   (w ${(Math.max(...ws) - Math.min(...ws)).toFixed(2)} · h ${(Math.max(...hs) - Math.min(...hs)).toFixed(2)})`)

  // ---- V. the rhythm -------------------------------------------------------------------------
  console.log('\nV · RHYTHM — the member column, then the foot')
  // PITCH, not the ink gap. The selected member paints a marker outside its disc, so it
  // necessarily narrows the visible gap either side of itself — that is the marker being a
  // marker. Centre-to-centre is what separates "the marker is bigger" (fine) from "the stack is
  // irregular" (not), and it is the same distinction the old tile harness drew.
  const members = m.rows.filter((r) => r.member && r.box)
  const memberPitch = []
  for (let i = 1; i < members.length; i++) {
    memberPitch.push(((members[i].box.top + members[i].box.bottom) / 2) - ((members[i - 1].box.top + members[i - 1].box.bottom) / 2))
  }
  const spread = (xs) => (xs.length ? Math.max(...xs) - Math.min(...xs) : 0)
  console.log(`  member pitch: ${memberPitch.map((x) => x.toFixed(1)).join(' / ') || '(one member)'}   spread ${spread(memberPitch).toFixed(2)}`)
  // A DIVIDER MUST OUT-SPACE WHAT IT DIVIDES. Members are 6px apart expanded so each tinted row
  // reads as its own object; the group boundary is 6 + hairline + 6. If the member gap ever grows
  // past the group's, the grouping inverts — rows read as belonging to the group below them.
  console.log(`  member gap ${f(m.gaps.member, 5, 1)} · group separation ${f(m.gaps.group, 5, 1)}` +
    (m.gaps.member < m.gaps.group ? '  ok' : '  ◀ OFF — the gap between members must stay under the one between groups'))
  const pitches = []
  for (let i = 1; i < m.foot.rows.length; i++) pitches.push(m.foot.rows[i].top - m.foot.rows[i - 1].top)
  console.log(`  foot row tops:   ${m.foot.rows.map((r) => r.top.toFixed(1)).join(' / ')}`)
  console.log(`  foot row pitch:  ${pitches.map((x) => x.toFixed(1)).join(' / ')}   spread ${spread(pitches).toFixed(2)}`)
  // Every hairline centred in its own air: the gap above equals the gap below.
  const seamAir = m.foot.seams.map((s, i) => {
    const above = s.top - (m.foot.rows[i].top + m.foot.rows[i].h)
    const below = m.foot.rows[i + 1] ? m.foot.rows[i + 1].top - (s.top + 1) : null
    return { above, below }
  })
  for (const [i, a] of seamAir.entries()) {
    console.log(`  hairline ${i + 1}: ${f(a.above, 5, 1)} above · ${f(a.below, 5, 1)} below` +
      (a.below !== null && Math.abs(a.above - a.below) > TOL ? '  ◀ OFF' : '  ok'))
  }
  const okRhythm = spread(memberPitch) <= TOL && spread(pitches) <= TOL
    && (m.gaps.member === null || m.gaps.group === null || m.gaps.member < m.gaps.group)
    && seamAir.every((a) => a.below === null || Math.abs(a.above - a.below) <= TOL)
  const okFoot = m.foot.present.length === 8
  console.log(`  foot controls present: ${m.foot.present.length}/8` + (okFoot ? '  ok' : '  ◀ OFF'))

  return {
    worst, sizeSpread, okRhythm, okFoot, worstWindow, plusTooBig: m.plusTooBig,
    rows: m.foot.rows.map((r) => r.top),
    orbs: Object.fromEntries(m.rows.filter((r) => r.orb && r.box).map((r) => [r.orb, r.box])),
    accents: Object.fromEntries(m.groups.map((g) => [g.id, g.accent])),
  }
}

// ---------------------------------------------------------------------------------------------
const summary = []
for (const [theme, short] of THEMES) {
  const { browser, p } = await boot(theme)
  const fails = []

  // Scene 1 — COLLAPSED, which is the state every axis claim is about.
  const m1 = await measure(p, `${short} · collapsed (${RAIL_W})`)
  const r1 = report(m1)
  if (Math.abs(m1.rr.width - RAIL_W) > 0.5) fails.push(`collapsed width ${m1.rr.width}, expected ${RAIL_W}`)
  // The colliding pair must be two GROUPS, not one: same accent, separate hairlines. The strip is
  // grouped by proximity and a rule, never by tint, and this is the fixture that proves it.
  const collide = Object.entries(r1.accents).filter(([, a]) => a === r1.accents['web27-id'])
  if (collide.length < 2) fails.push(`the accent-collision fixture did not land — ${JSON.stringify(r1.accents)}`)
  const groupCount = await p.locator('[data-rail-group]').count()
  const hairlines = await p.evaluate(() => [...document.querySelectorAll('[data-rail-group]')]
    .filter((g) => getComputedStyle(g).boxShadow !== 'none').length)
  if (hairlines !== groupCount - 1) fails.push(`${groupCount} groups but ${hairlines} hairlines — expected one above every group but the first`)
  // No group may render empty: a header with a hairline and nothing under it is what a group whose
  // membership has not hydrated would look like.
  const emptyGroups = await p.evaluate(() => [...document.querySelectorAll('[data-rail-group]')]
    .filter((g) => !g.querySelector('[data-rail-session], [data-rail-home], [data-lane-row]')).length)
  if (emptyGroups) fails.push(`${emptyGroups} group(s) render a header with no members`)

  await p.screenshot({ path: `/tmp/operator-shots/rail-d1-${short.replace('·', '-')}-collapsed.png`, clip: { x: m1.rr.left, y: 0, width: 90, height: 900 } })

  // Scene 2 — EXPANDED. ⌘B, then the same measurements.
  await p.keyboard.press('Meta+b')
  await p.mouse.move(700, 450)
  await p.evaluate(() => document.activeElement?.blur?.())
  await p.waitForTimeout(7000)
  const m2 = await measure(p, `${short} · expanded (${RAIL_W_OPEN})`)
  const r2 = report(m2)
  if (Math.abs(m2.rr.width - RAIL_W_OPEN) > 0.5) fails.push(`expanded width ${m2.rr.width}, expected ${RAIL_W_OPEN}`)

  // ---- X. THE ORB DOES NOT RESIZE, AND THE COLLAPSED AXIS HOLDS -----------------------------
  //
  // THE Δx HALF OF THIS ASSERTION IS RETIRED — deliberately, by the user, on 2026-08-04
  // ("agent orb should be more to the left, balanced"). It required an orb's painted centre to be
  // identical collapsed and expanded, and it is what forced the 264 width: holding the orb column
  // at 2 × the axis cost ~30px of the name column. The expanded orb now starts at the row's own
  // left edge with everything else (assertion L below), so it slides on ⌘B and that is the
  // accepted trade. The SIZE of the slide is `ORB_SLIDE` — a number someone chose rather than a
  // consequence — and `ROW_INSET_L` is it solved for against the axis.
  //
  // DO NOT PUT Δx = 0 BACK WITHOUT ASKING. Four passes of pixel work depended on it, so an orb that
  // moves looks exactly like a regression to anyone reading this file cold — it isn't; it is the
  // decision. What is still true, and still gated:
  //   • the orb must not RESIZE between states (a disc that grows on ⌘B is a defect, not a choice)
  //   • the COLLAPSED axis stays at 35 element-local / 43 from the window edge, which is the
  //     optical-centre fix from D1-FIX-1 and lives one neighbourhood away from this change.
  //   • THE SLIDE IS `ORB_SLIDE`, and that is asserted now rather than printed. Retiring Δx = 0 did
  //     not make the slide free — it made it a CHOSEN number, and a chosen number that nothing
  //     checks is exactly what drifted: `RAIL_W` 60 → 70 moved the axis, `ROW_INSET_L` stayed at 8,
  //     and the accepted 10 silently became 15. `ROW_INSET_L` in `rail-metrics.ts` is this solved
  //     for; if RAIL_W moves again, this fails and that line is the one to re-solve.
  console.log(`\nX · the orb slides exactly ${ORB_SLIDE}px on ⌘B, and must not RESIZE (Δx = 0 retired — see the note)`)
  let worstX = 0
  for (const [id, a] of Object.entries(r1.orbs)) {
    const b = r2.orbs[id]
    if (!b) { fails.push(`orb ${id} vanished when expanded`); continue }
    const dx = ((b.left + b.right) / 2) - ((a.left + a.right) / 2)
    const dw = (b.right - b.left) - (a.right - a.left)
    if (Math.abs(dx) > Math.abs(worstX)) worstX = dx
    console.log(`  ${pad(id.slice(-8), 12)} centre ${f((a.left + a.right) / 2)} → ${f((b.left + b.right) / 2)}   Δx ${f(dx)} (want ${ORB_SLIDE})   Δsize ${f(dw)}` +
      (Math.abs(dw) > TOL ? '  ◀ OFF' : '  ok'))
    if (Math.abs(dw) > TOL) fails.push(`orb ${id} resized ${dw.toFixed(2)}px on expand`)
    if (Math.abs(Math.abs(dx) - ORB_SLIDE) > TOL) {
      fails.push(`orb ${id} slid ${Math.abs(dx).toFixed(2)}px on expand, expected ${ORB_SLIDE} — re-solve ROW_INSET_L`)
    }
  }

  // ---- L. ONE LEFT EDGE ----------------------------------------------------------------------
  // The other half of "balanced": reading down the expanded strip, the project header, the orb and
  // the `+` used to start at three different x (8.5 / 18 / 26 measured). A strip whose items start
  // at three different x reads as broken however correct each one is on its own.
  //
  // THE OPEN GROUP'S PATH IS IN THE LIST NOW. It was left out while `ROW_INSET_L` was 8, and it
  // agreed with the edge for the wrong reason — its own padding was a bare 8 literal. Moving the
  // inset to 12 stranded it 4px out, and this assertion passed anyway. An item is on the edge or
  // it is measured; there is no third state.
  console.log('\nL · ONE LEFT EDGE — expanded: header text, path, orb, and the + of "Start an agent"')
  {
    const rr = await railRect(p)
    const clip = { x: rr.left, y: rr.top, width: rr.width, height: rr.height }
    const edges = []
    for (const [name, sel] of [
      ['header text', '[data-rail-project-header]'],
      ['path', '[data-rail-path]'],
      ['orb', '[data-rail-orb]'],
      ['+ Start an agent', '[data-rail-add-lane] svg'],
    ]) {
      const box = await ink(p, clip, sel)
      if (!box) { fails.push(`L: ${name} paints nothing at 264`); continue }
      edges.push({ name, left: box.left })
      console.log(`  ${pad(name, 20)} ink starts at ${f(box.left)}`)
    }
    const spread = edges.length ? Math.max(...edges.map((e) => e.left)) - Math.min(...edges.map((e) => e.left)) : 99
    console.log(`  spread ${spread.toFixed(2)}px across ${edges.length}` + (spread > TOL ? '  ◀ OFF' : '  ok'))
    if (spread > TOL) fails.push(`the expanded strip starts its items at ${edges.map((e) => e.left.toFixed(1)).join(' / ')} — one left edge, not three`)
  }

  // ---- Y. the foot rows hold their y ---------------------------------------------------------
  console.log('\nY · FOOT ROWS — identical y at both widths (Arrangement A)')
  console.log(`  collapsed ${r1.rows.map((x) => x.toFixed(1)).join(' / ')}`)
  console.log(`  expanded  ${r2.rows.map((x) => x.toFixed(1)).join(' / ')}`)
  const rowDelta = r1.rows.length === r2.rows.length
    ? Math.max(...r1.rows.map((x, i) => Math.abs(x - r2.rows[i])))
    : 99
  console.log(`  worst Δy ${rowDelta.toFixed(2)}` + (rowDelta > TOL ? '  ◀ OFF' : '  ok'))
  if (rowDelta > TOL) fails.push(`foot rows move ${rowDelta.toFixed(2)}px between widths`)
  if (r1.rows.length !== 4) fails.push(`${r1.rows.length} foot rows, expected 4`)

  // ---- T. THE WHOLE CELL IS THE TARGET --------------------------------------------------------
  // The user's complaint, expressed as a test: "still can't click on the text for agents, usage,
  // etc, just the icon". `elementFromPoint` at the LABEL's centre must return the same control as
  // at the GLYPH's — measured from the user's side rather than by reading the tree, because a
  // label that merely LOOKS inside the button is exactly what shipped.
  console.log('\nT · HIT AREA — the cell, not the glyph')
  for (const [label, sel] of [['expanded', null], ['collapsed', 'Meta+b']]) {
    if (sel) { await p.keyboard.press(sel); await p.waitForTimeout(900) }
    const hits = await p.evaluate((names) => names.map(([name, q]) => {
      const btn = document.querySelector(q)
      if (!btn) return { name, missing: true }
      const b = btn.getBoundingClientRect()
      const glyph = btn.querySelector('svg')?.getBoundingClientRect()
      // The LABEL specifically, by its own hook — not "the widest span", which collapsed would
      // have matched against the glyph box and reported a pass for a label that isn't there.
      const word = btn.querySelector('[data-foot-label]')?.getBoundingClientRect() ?? null
      const at = (r) => (r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null)
      const owner = (el) => (el ? el.closest('button') : null)
      return {
        name,
        // The far edge of the cell, too: the space AROUND the word is part of the advertised
        // target and was dead as well.
        glyph: owner(at(glyph)) === btn,
        word: word ? owner(at(word)) === btn : null,
        edge: owner(document.elementFromPoint(b.right - 3, b.top + b.height / 2)) === btn,
        // One focus stop per cell. A button inside a button passes every click test above and is
        // still wrong for the keyboard.
        inner: btn.querySelectorAll('button, a, input, [tabindex]').length,
      }
    }), FOOT.map(([n, q]) => [n, q]))
    for (const h of hits) {
      if (h.missing) { fails.push(`${label}: ${h.name} is not in the foot`); continue }
      if (!h.glyph) fails.push(`${label}: a click on ${h.name}'s GLYPH does not reach its control`)
      if (h.word === false) fails.push(`${label}: a click on ${h.name}'s LABEL does not reach its control`)
      if (!h.edge) fails.push(`${label}: the space beside ${h.name}'s label is dead`)
      if (h.inner) fails.push(`${label}: ${h.name} holds ${h.inner} nested focusable control(s)`)
    }
    console.log(`  ${pad(label, 10)} glyph ${hits.filter((h) => h.glyph).length}/8 · label ${hits.filter((h) => h.word).length}/8 · cell edge ${hits.filter((h) => h.edge).length}/8 · nested controls ${hits.reduce((n, h) => n + (h.inner ?? 0), 0)}`)
  }
  // …and back to expanded, where scene 2 left the strip.
  await p.keyboard.press('Meta+b')
  await p.waitForTimeout(900)

  // ---- B. ⌘B removes nothing ------------------------------------------------------------------
  if (!r1.okFoot) fails.push(`collapsed foot has ${m1.foot.present.length}/8 controls — ⌘B is still deleting app chrome`)
  if (!r2.okFoot) fails.push(`expanded foot has ${m2.foot.present.length}/8 controls`)

  // The identity colour must be the same value at both widths — it reaches the DOM as three
  // different color-mix expressions, so this compares the SOURCE rather than an encoding.
  for (const [id, a] of Object.entries(r1.accents)) {
    if (r2.accents[id] !== a) fails.push(`${id}'s accent changed with the width: ${a} → ${r2.accents[id]}`)
  }

  await p.screenshot({ path: `/tmp/operator-shots/rail-d1-${short.replace('·', '-')}-expanded.png`, clip: { x: m2.rr.left, y: 0, width: 290, height: 900 } })

  for (const r of [r1, r2]) if (r.plusTooBig) fails.push(r.plusTooBig)
  if (Math.abs(r1.worst) > TOL) fails.push(`collapsed axis off by ${r1.worst.toFixed(2)}px`)
  // COLLAPSED ONLY, and that is the point of the change: expanded, the member column starts at the
  // row's left edge with everything else (assertion L). What must not drift is the COLLAPSED
  // optical centre — the version line is checked in both scenes because it stays on the axis at
  // both widths, and it is included in `worstWindow` by being on-axis in both.
  if (Math.abs(r1.worstWindow - OPTICAL_CENTRE) > TOL) {
    fails.push(`collapsed member column paints at ${r1.worstWindow.toFixed(2)} from the window edge, not the optical centre ${OPTICAL_CENTRE}`)
  }
  if (Math.abs(r2.worstWindow - OPTICAL_CENTRE) > TOL) {
    fails.push(`expanded: something still held to the axis paints at ${r2.worstWindow.toFixed(2)}, not ${OPTICAL_CENTRE} (the version line is the only one that should be)`)
  }
  if (r1.sizeSpread > 1) fails.push(`foot glyph ink spread ${r1.sizeSpread.toFixed(2)}px`)
  if (!r1.okRhythm) fails.push('collapsed rhythm off')
  if (!r2.okRhythm) fails.push('expanded rhythm off')

  summary.push({ short, worst: Math.abs(r1.worst), x: Math.abs(worstX), rowDelta, size: r1.sizeSpread, fails })
  for (const f of fails) console.log(`  ✗ ${f}`)
  await browser.close()
}

console.log('\n' + '='.repeat(78))
console.log(pad('PALETTE', 10) + pad('|Δaxis|', 10) + pad('|Δorb x|', 10) + pad('|Δfoot y|', 11) + pad('GLYPH SPREAD', 14) + 'FAILURES')
for (const s of summary) {
  console.log(pad(s.short, 10) + pad(s.worst.toFixed(2), 10) + pad(s.x.toFixed(2), 10) +
    pad(s.rowDelta.toFixed(2), 11) + pad(s.size.toFixed(2), 14) + (s.fails.length || 'none'))
}
const bad = summary.filter((s) => s.fails.length)
if (bad.length) {
  console.log(`\nNOT CLEAN on ${bad.length}/${summary.length} palettes`)
  for (const s of bad) for (const f of s.fails) console.log(`  ${s.short}  ✗ ${f}`)
  process.exit(1)
}
console.log('\nCLEAN on every palette measured')
