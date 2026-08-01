// SIX-PALETTE PASS over the diff surface — the one renderer (`DiffBody`) that `DiffPanel`,
// `CanvasDiffPanel` and `TaskDiffCard` all go through after move 04.
//
// It measures `--add-fg` / `--del-fg` as PAINTED PIXELS: the ink's own colour composited through
// its `--add-bg` / `--del-bg` row tint onto whichever backdrop is actually behind it, in all four
// places a diff ink appears — the summary bar's totals, a file header's per-file counts, an added
// row and a removed row — on both backdrops a diff sits on (`--bg-terminal` for the Review panel
// and a task card, `--bg-surface` for the sticky file header).
//
// These four tokens were ONE hardcoded pair shared by every palette until this move. The
// `pre-04 tokens` toggle stamps that pair back on, so every run measures BEFORE and AFTER the
// same way rather than comparing a measurement against an estimate. Measured, the shared pair
// drew at 1.30–1.64:1 on the three light identities, and `--del-fg` also missed 4.5:1 on two of
// the three dark ones (3.56 mr-pink, 4.44 mission-control; 1984 scraped 4.55). This driver is
// what stops that coming back.
//
// It also checks the render decisions that came out of collapsing the two parsers: a rename and a
// chmod show a note instead of an empty body, and a content line that merely LOOKS like a
// preamble marker survives.
//
// Run against a hand-started vite dev server:
//   npx vite --port 1438 --strictPort
//   node dev/drive-diff-surface.mjs
import { webkit } from 'playwright'
import { mkdirSync } from 'node:fs'

const PORT = process.env.MOCK_PORT || 1438
const URL = `http://localhost:${PORT}/dev/diff-preview.html`
const OUT = '/tmp/operator-shots/diff-surface'
mkdirSync(OUT, { recursive: true })

const THEMES = [
  ['mission-control', 'dark'], ['mission-control', 'light'],
  ['mr-pink', 'dark'], ['mr-pink', 'light'],
  ['1984', 'dark'], ['1984', 'light'],
]

// Ported from drive-theme-pass.mjs: measure against the EFFECTIVE backdrop (walk up for the
// first opaque background, folding each translucent layer in on the way). That walk is the whole
// point here — a `+` row's backdrop is `--add-bg` over the host, never the host alone, and
// WebKit serializes those color-mix values as `color(srgb …)`, which a naive rgba() parse misses.
const PROBE = `(() => {
  const parseRGB = (s) => {
    const str = String(s)
    const cm = str.match(/color\\(srgb ([^)]+)\\)/)
    if (cm) {
      const p = cm[1].split(/[ /]+/).filter(Boolean).map(Number)
      return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 }
    }
    const m = str.match(/rgba?\\(([^)]+)\\)/)
    if (!m) return null
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number)
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }
  }
  const backdrop = (el) => {
    let n = el
    while (n && n !== document.documentElement) {
      const c = parseRGB(getComputedStyle(n).backgroundColor)
      if (c && c.a > 0.99) return c
      if (c && c.a > 0) {
        const under = backdrop(n.parentElement || document.body)
        return { r: c.r * c.a + under.r * (1 - c.a), g: c.g * c.a + under.g * (1 - c.a), b: c.b * c.a + under.b * (1 - c.a), a: 1 }
      }
      n = n.parentElement
    }
    const b = parseRGB(getComputedStyle(document.body).backgroundColor)
    return b && b.a > 0 ? b : { r: 0, g: 0, b: 0, a: 1 }
  }
  const effOpacity = (el) => { let o = 1, n = el; while (n && n !== document.documentElement) { o *= parseFloat(getComputedStyle(n).opacity || '1'); n = n.parentElement } return o }
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b) }
  window.__contrast = (sel, label) => {
    const el = document.querySelector(sel)
    if (!el) return { label, missing: true }
    const fg = parseRGB(getComputedStyle(el).color)
    if (!fg) return { label, missing: true }
    const bg = backdrop(el)
    const a = fg.a * effOpacity(el)
    const c = { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a) }
    const L1 = lum(c), L2 = lum(bg)
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)
    return { label, ratio: Math.round(ratio * 100) / 100, size: parseFloat(getComputedStyle(el).fontSize), ink: getComputedStyle(el).color }
  }
})()`

// A diff's +/- lines are code you READ, at 11px. 4.5:1, no large-text allowance, no meta excuse.
const FLOOR = 4.5

const rows = []
const notes = []
const fails = []

for (const [identity, mode] of THEMES) {
  const key = `${identity}-${mode}`
  const b = await webkit.launch()
  const ctx = await b.newContext({ viewport: { width: 1200, height: 900 }, colorScheme: mode })
  const p = await ctx.newPage()
  p.on('pageerror', (e) => fails.push(`${key} PAGEERROR ${String(e).slice(0, 200)}`))
  await p.goto(URL, { waitUntil: 'load' })
  await p.waitForSelector('[data-diff-host]')
  await p.click(`[data-theme-btn="${identity}"]`)
  await p.click(`[data-mode-btn="${mode}"]`)
  await p.waitForTimeout(200)
  // Open every file so the +/- rows exist to measure.
  await p.click('text=Expand all')
  await p.waitForTimeout(200)
  await p.evaluate(PROBE)

  // Measure the CURRENT tokens and the pre-move-04 shared pair the same way, so the before/after
  // table is two measurements rather than a measurement and an estimate.
  for (const era of ['after', 'before']) {
    if (era === 'before') { await p.click('[data-legacy-btn]'); await p.waitForTimeout(200) }
  for (const surface of ['terminal', 'surface']) {
    await p.click(`[data-surface-btn="${surface}"]`)
    await p.waitForTimeout(150)
    if (era === 'after') await p.screenshot({ path: `${OUT}/${key}-${surface}.png` })
    const probes = await p.evaluate(() => {
      const host = document.querySelector('[data-diff-host]')
      const spans = host.querySelectorAll('span')
      // Summary-bar totals: the first two tabular-nums spans in the bar.
      const totals = [...spans].filter((s) => getComputedStyle(s).fontVariantNumeric.includes('tabular-nums'))
      totals[0]?.setAttribute('data-p-total-add', '')
      totals[1]?.setAttribute('data-p-total-del', '')
      // Per-file header counts (they come after the summary bar's two).
      totals[2]?.setAttribute('data-p-file-add', '')
      totals[3]?.setAttribute('data-p-file-del', '')
      // An actual added / removed row inside a hunk.
      const rows = [...host.querySelectorAll('div')].filter((d) => d.children.length === 0 && /^[+-][^+-]/.test(d.textContent || ''))
      rows.find((d) => d.textContent.startsWith('+'))?.setAttribute('data-p-add-row', '')
      rows.find((d) => d.textContent.startsWith('-'))?.setAttribute('data-p-del-row', '')
      return [
        window.__contrast('[data-p-total-add]', 'summary total +'),
        window.__contrast('[data-p-total-del]', 'summary total −'),
        window.__contrast('[data-p-file-add]', 'file header +'),
        window.__contrast('[data-p-file-del]', 'file header −'),
        window.__contrast('[data-p-add-row]', 'added row (on its --add-bg)'),
        window.__contrast('[data-p-del-row]', 'removed row (on its --del-bg)'),
      ]
    })
    for (const r of probes) {
      if (r.missing) { fails.push(`${key}/${surface} — MISSING probe "${r.label}"`); continue }
      rows.push({ key, surface, era, ...r })
      // Only the shipped tokens are held to the floor; the `before` pass is documentation.
      if (era === 'after' && r.ratio < FLOOR) fails.push(`${key}/${surface} — ${r.label}: ${r.ratio}:1 (< ${FLOOR}:1) @${r.size}px`)
    }
  }
  }
  await p.click('[data-legacy-btn]') // back to the shipped tokens

  // Empty diff must say so rather than render a bare summary bar.
  await p.click('[data-empty-btn]')
  await p.waitForTimeout(150)
  const emptyText = await p.locator('[data-diff-host]').innerText()
  if (!/No changes\./.test(emptyText)) fails.push(`${key} — empty diff did not say "No changes."`)
  await p.screenshot({ path: `${OUT}/${key}-empty.png` })

  await b.close()
}

// ---- Render decisions from collapsing the two parsers (theme-independent) -------------------
{
  const b = await webkit.launch()
  const ctx = await b.newContext({ viewport: { width: 1200, height: 900 }, colorScheme: 'dark' })
  const p = await ctx.newPage()
  p.on('pageerror', (e) => fails.push(`structure PAGEERROR ${String(e).slice(0, 200)}`))
  await p.goto(URL, { waitUntil: 'load' })
  await p.waitForSelector('[data-diff-host]')
  await p.click('text=Expand all')
  await p.waitForTimeout(250)

  // A rename and a chmod have no hunks at all: they must show what happened, not an empty body.
  const noteTexts = await p.$$eval('[data-file-note]', (els) => els.map((e) => e.textContent.trim()))
  notes.push(`notes rendered: ${JSON.stringify(noteTexts)}`)
  for (const want of ['Mode 100644 → 100755', 'Renamed from rename-me.ts', 'Renamed from renamed with space.ts']) {
    if (!noteTexts.includes(want)) fails.push(`missing metadata note: "${want}"`)
  }

  // The line that both former parsers lost: `-- dashes` reads as `--- dashes` once prefixed.
  const body = await p.locator('[data-file="edge.md"]').innerText()
  if (!body.includes('--- dashes') || !body.includes('+++ pluses')) {
    fails.push(`edge.md lost its preamble-shaped content lines — got:\n${body}`)
  }
  notes.push(`edge.md renders its --- / +++ content lines`)

  // The path with a space is a real section, not a placeholder.
  const spaced = await p.locator('[data-file="my file.ts"]').count()
  if (!spaced) fails.push('no section for the space-containing path')

  // The status letter DiffPanel's file list used to carry.
  const statuses = await p.$$eval('[data-file-status]', (els) => els.map((e) => e.textContent))
  notes.push(`file status letters: ${JSON.stringify(statuses)}`)
  if (!statuses.includes('R') || !statuses.includes('A')) fails.push(`status letters lost: ${statuses}`)

  await b.close()
}

// ---- Report --------------------------------------------------------------------------------
const worst = new Map()
for (const r of rows.filter((r) => r.era === 'after')) {
  const prev = worst.get(r.label)
  if (!prev || r.ratio < prev.ratio) worst.set(r.label, r)
}
console.log('\nDIFF INK — worst palette/backdrop per probe (floor 4.5:1)')
console.log('─'.repeat(90))
for (const [label, r] of worst) {
  console.log(`${r.ratio >= FLOOR ? 'ok  ' : 'FAIL'}  ${label.padEnd(30)} ${String(r.ratio).padStart(6)}:1  @${r.size}px  (worst: ${r.key}/${r.surface})`)
}
console.log('\nPER PALETTE — worst ratio of each token, pre-move-04 shared pair vs shipped')
console.log('palette                  --add-fg           --del-fg           shipped ink')
const isAdd = (l) => /\+/.test(l)
const cell = (key, era, add) => {
  const rs = rows.filter((r) => r.key === key && r.era === era && isAdd(r.label) === add)
  return rs.length ? Math.min(...rs.map((r) => r.ratio)) : NaN
}
const inkOf = (key, add) => (rows.find((r) => r.key === key && r.era === 'after' && isAdd(r.label) === add) || {}).ink
for (const [identity, mode] of THEMES) {
  const k = `${identity}-${mode}`
  const ab = cell(k, 'before', true), aa = cell(k, 'after', true)
  const db = cell(k, 'before', false), da = cell(k, 'after', false)
  const f = (n) => n.toFixed(2).padStart(5)
  console.log(`${k.padEnd(24)} ${f(ab)} → ${f(aa)}    ${f(db)} → ${f(da)}    ${inkOf(k, true)} / ${inkOf(k, false)}`)
}
console.log('\nNOTES')
for (const n of notes) console.log(`  · ${n}`)
console.log(`\nShots → ${OUT}`)
if (fails.length) {
  console.log(`\n${fails.length} FAILURE(S)`)
  for (const f of fails) console.log(`  ✗ ${f}`)
  process.exit(1)
}
console.log('\nAll checks passed.')
