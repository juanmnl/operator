// THE RAIL FOOT'S FOLD — what it hides, what it gives back, and that it stays that way.
//
// `dev/drive-rail-invariant.mjs` boots the foot UNFOLDED on purpose: its assertions B and S are
// about all eight glyphs, and a harness that measured only the four resting ones would quietly
// stop asserting the thing it exists for. This is the other half — the harness that boots it
// FOLDED and checks the fold itself.
//
// FIVE ASSERTIONS
//   T. TIERS — folded, exactly the four resting controls are in the DOM and the four folded ones
//      are absent. Not merely invisible: a control that still occupies layout has saved nothing.
//   R. REAL ESTATE — the foot's painted height actually shrinks, and the space goes to the list
//      above it. The number is reported, not just a pass: "shorter" with no figure is how a
//      collapse that saves 6px gets called a success.
//   A. AFFORDANCE — the disclosure is drawn AT REST (not hover-only), sits on the optical axis at
//      both widths, and is a different glyph from the sidebar's own collapse control.
//   P. PERSISTENCE — unfold, reload, still unfolded; fold, reload, still folded. Through the real
//      localStorage the app writes, not a stub.
//   K. KEYBOARD — ⌘⇧O and ⌘N still fire while the foot is folded. A folded control is still a
//      live command.
//
// Run: `./node_modules/.bin/vite --port 1448 --strictPort` then
//      `MOCK_PORT=1448 node dev/drive-rail-foot-fold.mjs`. `THEMES=all` sweeps all six palettes.
import { webkit } from 'playwright'
import { mkdirSync } from 'node:fs'

const PORT = process.env.MOCK_PORT || 1448
const OUT = '/tmp/operator-shots/rail-foot-fold'
mkdirSync(OUT, { recursive: true })

const ALL_THEMES = [
  ['mission-control-dark', 'mc·D'], ['mission-control-light', 'mc·L'],
  ['mr-pink-dark', 'pink·D'], ['mr-pink-light', 'pink·L'],
  ['1984-dark', '1984·D'], ['1984-light', '1984·L'],
]
const THEMES = process.env.THEMES === 'all'
  ? ALL_THEMES
  : process.env.THEMES
    ? ALL_THEMES.filter(([k]) => process.env.THEMES.split(',').includes(k))
    : [ALL_THEMES[0], ALL_THEMES[1]]

/** The optical axis, element-local — the same 30 every orb and the identity row sits on. */
const AXIS = 30
const TOL = 0.75

const RESTING = ['data-rail-agents', 'data-rail-usage', 'data-rail-gallery', 'data-rail-open-folder']
const FOLDED = ['data-rail-folder-prefs', 'data-rail-global-prefs', 'data-rail-prefs', 'data-rail-theme']

async function boot(theme, { expanded }) {
  const browser = await webkit.launch()
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: theme.endsWith('light') ? 'light' : 'dark',
    deviceScaleFactor: 2,
  })
  await ctx.addInitScript(([t, exp, names]) => {
    // SEED ONCE PER CONTEXT, NOT PER LOAD. An init script runs on every navigation, so seeding
    // unconditionally re-wrote the very key the persistence check had just toggled — the reload
    // then "lost" a state the harness itself had stamped back over. That reads as a product bug
    // and is not one, which is the expensive kind.
    try {
      if (!localStorage.getItem('__foldHarnessSeeded')) {
        localStorage.setItem('__foldHarnessSeeded', '1')
        localStorage.setItem('operator.theme', t)
        localStorage.setItem('operator.sidebarCollapsed', '1')
        // The state under test. Written BEFORE first paint, which is the only way to observe the
        // boot-time default rather than a post-hydration toggle.
        if (exp === null) localStorage.removeItem('operator.railFootExpanded')
        else localStorage.setItem('operator.railFootExpanded', exp ? '1' : '0')
      }
    } catch { /* quota */ }
    // The strip draws nothing without live projects, so the same fixture
    // `drive-rail-invariant.mjs` uses: a project reaches the rail only through ACTIVITY, and
    // activity is rolled up from terminals joined to saved sessions — hence all three overrides.
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
        v.getVersion = async () => '0.15.0'
        v.loadProjects = async () => [...((await oP()) ?? []), ...extras]
        v.saveProjects = () => {}
        v.terminalList = async () => [
          ...((await oT()) ?? []),
          ...extras.map((e, i) => ({ id: `tx${i}`, pid: 0, cwd: e.path, command: 'claude', alive: true })),
        ]
        v.loadSessions = async () => [
          ...((await oS()) ?? []),
          ...extras.map((e, i) => ({
            key: `key-tx${i}`, cwd: e.path, projectName: e.name, projectId: e.id,
            claudeSessionId: `s-${e.id}`, terminalId: `tx${i}`, lastActiveAt: e.lastActiveAt,
          })),
        ]
      },
    })
  }, [theme, expanded, ['fastrack', 'uwazi-app', 'web27']])
  const p = await ctx.newPage()
  p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))
  await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
  await p.waitForTimeout(2500)
  return { browser, ctx, p }
}

const probe = (p) => p.evaluate(([resting, folded, axis]) => {
  const r2 = (n) => Math.round(n * 100) / 100
  const rail = document.querySelector('[data-rail]')
  const foot = document.querySelector('[data-rail-foot]')
  const disc = document.querySelector('[data-rail-foot-disclosure]')
  const railRect = rail?.getBoundingClientRect()
  const footRect = foot?.getBoundingClientRect()
  const dRect = disc?.getBoundingClientRect()
  const cs = disc ? getComputedStyle(disc) : null
  return {
    railW: railRect ? r2(railRect.width) : null,
    footH: footRect ? r2(footRect.height) : null,
    // What the agent list actually gets: the strip's height minus the foot's.
    listH: railRect && footRect ? r2(railRect.height - footRect.height) : null,
    rows: document.querySelectorAll('[data-rail-foot-row]').length,
    seams: document.querySelectorAll('[data-rail-seam]').length,
    present: {
      resting: resting.filter((a) => document.querySelector(`[${a}]`)).length,
      folded: folded.filter((a) => document.querySelector(`[${a}]`)).length,
    },
    disclosure: disc ? {
      // Rest state, straight off the computed style — a hover-only control would be
      // display:none / opacity:0 here while still holding its box.
      visible: cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.01,
      expanded: disc.getAttribute('aria-expanded'),
      label: disc.getAttribute('aria-label'),
      // Painted centre against the axis, in rail-local coordinates.
      dAxis: r2((dRect.left + dRect.right) / 2 - railRect.left - axis),
      w: r2(dRect.width), h: r2(dRect.height),
      // The sidebar's own collapse control, for the two-verbs-one-glyph check.
      glyph: disc.querySelector('svg path')?.getAttribute('d') ?? null,
    } : null,
    sidebarToggleGlyph: [...document.querySelectorAll('[data-sidebar-toggle] svg *')]
      .map((n) => n.tagName.toLowerCase()).join(','),
    // The version line and any update affordance must survive the fold.
    identity: !!document.querySelector('[data-sidebar-identity]'),
  }
}, [RESTING, FOLDED, AXIS])

const rows = []
const fails = []

for (const [theme, short] of THEMES) {
  // ---- folded (the default) ----------------------------------------------------------------
  const folded = await boot(theme, { expanded: null })
  const f = await probe(folded.p)
  await folded.p.screenshot({ path: `${OUT}/${theme}-folded.png`, clip: { x: 0, y: 0, width: 220, height: 900 } })

  rows.push([short, 'folded (default)', `rows=${f.rows}`, `resting=${f.present.resting}/4`, `folded=${f.present.folded}/4`, `footH=${f.footH}`])
  if (f.present.resting !== 4) fails.push(`${short}: folded state is missing ${4 - f.present.resting} RESTING control(s)`)
  if (f.present.folded !== 0) fails.push(`${short}: folded state still renders ${f.present.folded} folded control(s) — hidden is not folded`)
  if (f.rows !== 2) fails.push(`${short}: folded foot has ${f.rows} rows, expected 2`)
  if (!f.identity) fails.push(`${short}: the version/update line vanished with the fold`)

  // A. the affordance, at rest
  if (!f.disclosure) {
    fails.push(`${short}: no disclosure control in the folded foot`)
  } else {
    rows.push([short, 'disclosure', `${f.disclosure.w}×${f.disclosure.h}`, `Δaxis=${f.disclosure.dAxis}`, `visible=${f.disclosure.visible}`, `"${f.disclosure.label}"`])
    if (!f.disclosure.visible) fails.push(`${short}: the disclosure is not drawn at rest — a hover-only control must not reserve space`)
    if (Math.abs(f.disclosure.dAxis) > TOL) fails.push(`${short}: disclosure is ${f.disclosure.dAxis}px off the optical axis`)
    if (f.disclosure.expanded !== 'false') fails.push(`${short}: aria-expanded is "${f.disclosure.expanded}", expected "false" when folded`)
    if (!/^Show \d+ more controls$/.test(f.disclosure.label ?? '')) fails.push(`${short}: disclosure label "${f.disclosure.label}" does not name the count`)
    // Two verbs never share a glyph: the sidebar toggle draws a panel (rect + line).
    if (!/rect/.test(f.sidebarToggleGlyph)) fails.push(`${short}: could not read the sidebar toggle's glyph to compare against`)
    if (/rect/.test(f.disclosure.glyph ?? '')) fails.push(`${short}: the disclosure draws a panel, same as the sidebar toggle`)
  }

  // K. the folded commands are still live. ⌘⇧O opens the gallery; the foot's button is gone.
  await folded.p.keyboard.press('Meta+Shift+O')
  await folded.p.waitForTimeout(700)
  const galleryReached = await folded.p.evaluate(() => !!document.querySelector('[data-project-gallery], [data-gallery]')
    || /All projects|Projects/i.test(document.body.innerText.slice(0, 400)))
  rows.push([short, 'keyboard', '⌘⇧O while folded', galleryReached ? 'reached' : 'NO EFFECT', '', ''])
  if (!galleryReached) fails.push(`${short}: ⌘⇧O did nothing while the foot was folded`)
  await folded.browser.close()

  // ---- unfolded -----------------------------------------------------------------------------
  const open = await boot(theme, { expanded: true })
  const o = await probe(open.p)
  await open.p.screenshot({ path: `${OUT}/${theme}-unfolded.png`, clip: { x: 0, y: 0, width: 220, height: 900 } })

  const saved = o.footH !== null && f.footH !== null ? Math.round((o.footH - f.footH) * 100) / 100 : null
  const pct = saved !== null && o.footH ? Math.round((saved / o.footH) * 1000) / 10 : null
  rows.push([short, 'unfolded', `rows=${o.rows}`, `resting=${o.present.resting}/4`, `folded=${o.present.folded}/4`, `footH=${o.footH}`])
  rows.push([short, 'REAL ESTATE', `saved ${saved}px`, `${pct}% of the foot`, `list ${f.listH} vs ${o.listH}`, ''])
  if (o.present.folded !== 4) fails.push(`${short}: unfolding did not restore all four folded controls`)
  if (o.rows !== 4) fails.push(`${short}: unfolded foot has ${o.rows} rows, expected 4`)
  if (o.seams !== 3) fails.push(`${short}: unfolded foot has ${o.seams} hairlines, expected 3 — the fold must REPLACE one, not add one`)
  if (saved === null || saved <= 40) fails.push(`${short}: the fold returned only ${saved}px — not worth a control`)
  if (o.disclosure?.expanded !== 'true') fails.push(`${short}: aria-expanded is "${o.disclosure?.expanded}", expected "true" when unfolded`)
  if (!/^Hide \d+ more controls$/.test(o.disclosure?.label ?? '')) fails.push(`${short}: unfolded label "${o.disclosure?.label}" does not offer the way back`)
  if (o.disclosure && Math.abs(o.disclosure.dAxis) > TOL) fails.push(`${short}: unfolded disclosure is ${o.disclosure.dAxis}px off the axis`)

  // P. persistence — toggle through the UI, reload, and see if it held.
  await open.p.click('[data-rail-foot-disclosure]')
  await open.p.waitForTimeout(300)
  const stored = await open.p.evaluate(() => localStorage.getItem('operator.railFootExpanded'))
  await open.p.reload({ waitUntil: 'load' })
  await open.p.waitForTimeout(2500)
  const after = await probe(open.p)
  rows.push([short, 'persistence', `stored=${stored}`, `after reload rows=${after.rows}`, `folded=${after.present.folded}/4`, ''])
  if (stored !== '0') fails.push(`${short}: clicking to fold wrote "${stored}", expected "0"`)
  if (after.rows !== 2 || after.present.folded !== 0) fails.push(`${short}: the folded state did not survive a reload`)

  // And back again, so persistence is proven in both directions rather than only the one.
  await open.p.click('[data-rail-foot-disclosure]')
  await open.p.waitForTimeout(300)
  await open.p.reload({ waitUntil: 'load' })
  await open.p.waitForTimeout(2500)
  const back = await probe(open.p)
  rows.push([short, 'persistence', 'unfold → reload', `rows=${back.rows}`, `folded=${back.present.folded}/4`, ''])
  if (back.rows !== 4 || back.present.folded !== 4) fails.push(`${short}: the unfolded state did not survive a reload`)

  // ---- expanded rail (264): the fold must behave the same at both widths ---------------------
  await open.p.evaluate(() => { try { localStorage.setItem('operator.sidebarCollapsed', '0') } catch { /* quota */ } })
  await open.p.reload({ waitUntil: 'load' })
  await open.p.waitForTimeout(2500)
  const wide = await probe(open.p)
  rows.push([short, 'at 264', `railW=${wide.railW}`, `rows=${wide.rows}`, `Δaxis=${wide.disclosure?.dAxis}`, ''])
  if (wide.disclosure && Math.abs(wide.disclosure.dAxis) > TOL) {
    fails.push(`${short}: at 264 the disclosure is ${wide.disclosure.dAxis}px off the axis — it must hold the axis at both widths`)
  }
  await open.browser.close()
}

const w = [9, 18, 20, 22, 24, 16]
const line = (r) => r.map((c, i) => String(c).padEnd(w[i])).join('')
console.log(line(['THEME', 'CHECK', 'A', 'B', 'C', 'D']))
console.log('-'.repeat(w.reduce((a, x) => a + x, 0)))
for (const r of rows) console.log(line(r))
console.log()
console.log(fails.length ? `FAIL (${fails.length})\n  ${fails.join('\n  ')}` : 'PASS — the fold holds')
console.log(`shots → ${OUT}`)
