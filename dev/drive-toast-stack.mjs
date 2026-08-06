// TOAST STACK pass — coalescing, Dismiss all, and the overflow cap, driven against the
// REAL <Toasts> component through dev/toast-preview.html (not a copy of it).
//
// Checks per theme (all 4 identities × light/dark):
//   1. the undelivered burst (4 identical + 1) renders TWO cards, one carrying ×4
//   2. "Dismiss all" is present at 2+ cards and clears the whole stack
//   3. 7 distinct toasts cap at 4 cards + a "+3 EARLIER" marker (nothing clipped)
//   4. contrast of the new receding ink: the ×N chip and both stack rows
//
// Run: `npx vite --port 1447` then `MOCK_PORT=1447 node dev/drive-toast-stack.mjs`.
import { webkit } from 'playwright'
import { mkdirSync } from 'node:fs'

const PORT = process.env.MOCK_PORT || 1447
const OUT = '/tmp/operator-shots/toast-stack'
mkdirSync(OUT, { recursive: true })

// Three identities, each with a light AND dark palette (themes/index.ts) — the
// standalone "Light" identity was folded into the per-identity mode toggle.
const THEMES = [
  ['Mission Control', 'dark'], ['Mission Control', 'light'],
  ['Mr Pink', 'dark'], ['Mr Pink', 'light'],
  ['1984', 'dark'], ['1984', 'light'],
]

// Effective-backdrop contrast probe (same maths as drive-theme-pass.mjs): walk up for the
// first opaque background, fold the element's own alpha + inherited opacity into the sample.
const PROBE = `(() => {
  const parseRGB = (s) => {
    const str = String(s)
    const cm = str.match(/color\\(srgb ([^)]+)\\)/)
    if (cm) { const p = cm[1].split(/[ /]+/).filter(Boolean).map(Number); return { r: p[0]*255, g: p[1]*255, b: p[2]*255, a: p.length > 3 ? p[3] : 1 } }
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
      if (c && c.a > 0) { const u = backdrop(n.parentElement || document.body); return { r: c.r*c.a + u.r*(1-c.a), g: c.g*c.a + u.g*(1-c.a), b: c.b*c.a + u.b*(1-c.a), a: 1 } }
      n = n.parentElement
    }
    const b = parseRGB(getComputedStyle(document.body).backgroundColor)
    return b && b.a > 0 ? b : { r: 0, g: 0, b: 0, a: 1 }
  }
  const effOpacity = (el) => { let o = 1, n = el; while (n && n !== document.documentElement) { o *= parseFloat(getComputedStyle(n).opacity || '1'); n = n.parentElement } return o }
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4) }; return 0.2126*f(c.r) + 0.7152*f(c.g) + 0.0722*f(c.b) }
  window.__contrastText = (needle, label) => {
    const el = [...document.querySelectorAll('div,span,button')].filter((e) => e.textContent.trim() === needle).pop()
    if (!el) return { label, missing: true }
    const fg = parseRGB(getComputedStyle(el).color)
    if (!fg) return { label, missing: true }
    const bg = backdrop(el)
    const a = fg.a * effOpacity(el)
    const c = { r: fg.r*a + bg.r*(1-a), g: fg.g*a + bg.g*(1-a), b: fg.b*a + bg.b*(1-a) }
    const L1 = lum(c), L2 = lum(bg)
    return { label, ratio: Math.round(((Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05))*100)/100, size: parseFloat(getComputedStyle(el).fontSize) }
  }
})()`

// Every string measured here is ≤10.5px supporting ink (counts and stack chrome), so 3:1
// is the floor. Declared, not inferred.
const META_FLOOR = 3.0

const rows = []
const fails = []
const notes = []

for (const [identity, mode] of THEMES) {
  const key = `${identity.toLowerCase().replace(/\s+/g, '-')}-${mode}`
  const b = await webkit.launch()
  const ctx = await b.newContext({ viewport: { width: 1200, height: 820 }, colorScheme: mode })
  const p = await ctx.newPage()
  p.on('pageerror', (e) => notes.push(`${key} PAGEERROR ${String(e).slice(0, 200)}`))
  await p.goto(`http://localhost:${PORT}/dev/toast-preview.html`, { waitUntil: 'load' })
  await p.getByRole('button', { name: identity, exact: true }).click()
  await p.getByRole('button', { name: mode, exact: true }).click()
  await p.evaluate(PROBE)

  // ---- 1. the real burst: 4 identical + 1 -------------------------------------
  await p.getByRole('button', { name: 'burst: 4× identical + 1' }).click()
  await p.waitForTimeout(400)
  const cards = await p.locator('div[title="Go to session"], div:has(> span[title^="Happened"])').count()
  const shape = await p.evaluate(() => {
    const heads = [...document.querySelectorAll('div')].filter((d) => d.style.fontWeight === '550')
    return {
      texts: heads.map((h) => h.textContent),
      counts: [...document.querySelectorAll('span[title^="Happened"]')].map((s) => s.textContent),
      dismissAll: !!document.querySelector('button[title^="Clear every notice"]'),
      actionLabels: [...document.querySelectorAll('button')].map((x) => x.textContent).filter((t) => /Show/.test(t)),
    }
  })
  rows.push([key, 'burst 4+1', `cards=${shape.texts.length}`, `counts=${shape.counts.join(',') || '—'}`, `dismissAll=${shape.dismissAll}`, `actions=${shape.actionLabels.join('|')}`])
  if (shape.texts.length !== 2) fails.push(`${key}: burst 4+1 rendered ${shape.texts.length} cards, expected 2`)
  if (!shape.counts.includes('×4')) fails.push(`${key}: no ×4 count chip on the coalesced card`)
  if (!shape.dismissAll) fails.push(`${key}: Dismiss all missing at 2 cards`)
  if (!shape.actionLabels.some((t) => /Show latest/.test(t))) fails.push(`${key}: coalesced card did not qualify its action as "latest"`)
  await p.screenshot({ path: `${OUT}/${key}-burst.png` })

  for (const [needle, label] of [['×4', 'count chip'], ['Dismiss all', 'dismiss-all label']]) {
    const r = await p.evaluate(([n, l]) => window.__contrastText(n, l), [needle, label])
    rows.push([key, 'contrast', r.label, r.missing ? 'MISSING' : `${r.ratio}:1 @${r.size}px`, '', ''])
    if (!r.missing && r.ratio < META_FLOOR) fails.push(`${key}: ${label} ${r.ratio}:1 < ${META_FLOOR}`)
  }

  // ---- 2. Dismiss all clears the whole stack ----------------------------------
  // Exact: the coalesced card's own ✕ must NOT also answer to this name.
  await p.getByRole('button', { name: 'Dismiss all', exact: true }).click()
  await p.waitForTimeout(600)
  const after = await p.evaluate(() => [...document.querySelectorAll('div')].filter((d) => d.style.fontWeight === '550').length)
  rows.push([key, 'dismiss all', `remaining=${after}`, '', '', ''])
  if (after !== 0) fails.push(`${key}: Dismiss all left ${after} cards`)

  // ---- 3. overflow cap ---------------------------------------------------------
  await p.getByRole('button', { name: 'burst: 7 distinct (overflow cap)' }).click()
  await p.waitForTimeout(400)
  const capped = await p.evaluate(() => ({
    cards: [...document.querySelectorAll('div')].filter((d) => d.style.fontWeight === '550').length,
    marker: [...document.querySelectorAll('div')].map((d) => d.textContent).find((t) => /^\+\d+ earlier$/.test(t?.trim() ?? '')) ?? null,
  }))
  rows.push([key, 'overflow', `cards=${capped.cards}`, `marker=${capped.marker ?? '—'}`, '', ''])
  if (capped.cards !== 4) fails.push(`${key}: overflow rendered ${capped.cards} cards, expected 4`)
  if (capped.marker !== '+3 earlier') fails.push(`${key}: overflow marker was ${capped.marker}, expected "+3 earlier"`)
  await p.screenshot({ path: `${OUT}/${key}-overflow.png` })

  const rEarlier = await p.evaluate(() => window.__contrastText('+3 earlier', 'overflow marker'))
  rows.push([key, 'contrast', rEarlier.label, rEarlier.missing ? 'MISSING' : `${rEarlier.ratio}:1 @${rEarlier.size}px`, '', ''])
  if (!rEarlier.missing && rEarlier.ratio < META_FLOOR) fails.push(`${key}: overflow marker ${rEarlier.ratio}:1 < ${META_FLOOR}`)

  // ---- 4. the stack must not run off the bottom of the window -----------------
  const bottom = await p.evaluate(() => {
    const stack = document.querySelector('div[style*="z-index: 900"]') || [...document.querySelectorAll('div')].find((d) => d.style.zIndex === '900')
    return stack ? Math.round(stack.getBoundingClientRect().bottom) : null
  })
  rows.push([key, 'stack bottom', `${bottom}px of 820`, '', '', ''])
  if (bottom !== null && bottom > 820) fails.push(`${key}: stack runs ${bottom - 820}px past the window bottom`)

  await b.close()
}

const w = [22, 14, 22, 26, 18, 26]
const line = (r) => r.map((c, i) => String(c).padEnd(w[i])).join('')
console.log(line(['THEME', 'CHECK', 'A', 'B', 'C', 'D']))
console.log('-'.repeat(w.reduce((a, x) => a + x, 0)))
for (const r of rows) console.log(line(r))
console.log()
if (notes.length) { console.log('NOTES'); notes.forEach((n) => console.log('  ' + n)) }
console.log(fails.length ? `FAIL (${fails.length})\n  ${fails.join('\n  ')}` : 'PASS — all themes')
console.log(`shots → ${OUT}`)
