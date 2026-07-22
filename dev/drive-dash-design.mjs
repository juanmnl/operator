// Design pass over the reorganized Activity Dashboard: capture the grouped board in
// both themes plus the EMPTY state, and measure the lane-accent row titles (the
// dashboard is the first surface to render an accent as a row TITLE, so light-theme
// accent legibility is the open question).
import { webkit } from 'playwright'

const theme = process.argv[2] || 'mission-control-dark'
const tag = process.argv[3] || 'dark'
const SHOT = '/tmp/operator-shots/dash'

const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: theme.endsWith('light') ? 'light' : 'dark' })
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))
await p.addInitScript((t) => localStorage.setItem('operator.theme', t), theme)
await p.goto('http://localhost:1429/dev/mock.html', { waitUntil: 'load' })
await p.waitForTimeout(2500)
await p.getByTitle('Active sessions').click()
await p.waitForTimeout(700)
await p.screenshot({ path: `${SHOT}/${tag}-1-grouped.png` })

// Density + alignment: is the group header's left edge flush with its rows?
const geom = await p.evaluate(() => {
  const groups = Array.from(document.querySelectorAll('[data-dash-group]'))
  return groups.map((g) => {
    const head = g.querySelector('[data-dash-project]')
    const row = g.querySelector('[data-dash-row]')
    const title = g.querySelector('[data-dash-title]')
    return {
      name: head?.textContent.trim(),
      headerLeft: head ? +head.getBoundingClientRect().x.toFixed(1) : null,
      rowLeft: row ? +row.getBoundingClientRect().x.toFixed(1) : null,
      titleLeft: title ? +title.getBoundingClientRect().x.toFixed(1) : null,
      rowHeight: row ? +row.getBoundingClientRect().height.toFixed(1) : null,
      groupGap: +getComputedStyle(g).marginBottom.replace('px', ''),
    }
  })
})
console.log(`[${tag}] geometry:`, JSON.stringify(geom, null, 2))

// Contrast of every row title against the row background it actually sits on,
// plus hover (rows swap to --bg-surface on hover, a different backdrop).
const contrast = await p.evaluate(() => {
  const parse = (c) => {
    if (!c || c === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
    const m = (c.match(/[\d.]+/g) || []).map(Number)
    if (!m.length) return { r: 0, g: 0, b: 0, a: 0 }
    const srgb = c.startsWith('color(')
    return { r: srgb ? m[0] * 255 : m[0], g: srgb ? m[1] * 255 : m[1], b: srgb ? m[2] * 255 : m[2], a: m.length > 3 ? m[3] : 1 }
  }
  const over = (fg, bg) => {
    const a = fg.a + bg.a * (1 - fg.a)
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 }
    return {
      r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
      g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
      b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a, a,
    }
  }
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
  }
  const ratio = (x, y) => { const [l1, l2] = [lum(x), lum(y)].sort((a, b) => b - a); return (l1 + 0.05) / (l2 + 0.05) }
  const pageBg = parse(getComputedStyle(document.body).backgroundColor)
  const bgOf = (el) => {
    let cur = el, acc = { r: 0, g: 0, b: 0, a: 0 }
    while (cur) {
      const c = parse(getComputedStyle(cur).backgroundColor)
      if (c.a > 0) acc = over(acc, c)
      if (acc.a >= 1) break
      cur = cur.parentElement
    }
    return over(acc, pageBg)
  }
  const opacityChain = (el) => { let o = 1, cur = el; while (cur) { o *= Number(getComputedStyle(cur).opacity); cur = cur.parentElement } return o }
  const measure = (el) => {
    const fg = parse(getComputedStyle(el).color)
    const bg = bgOf(el)
    const o = opacityChain(el)
    return +ratio(over({ ...over(fg, bg), a: o }, pageBg), over({ ...bg, a: o }, pageBg)).toFixed(2)
  }
  const out = { titles: [], headers: [], meta: [] }
  for (const el of document.querySelectorAll('[data-dash-title]')) {
    const cs = getComputedStyle(el)
    out.titles.push({ text: el.textContent.trim().slice(0, 18), color: cs.color, px: cs.fontSize, rest: measure(el) })
  }
  for (const el of document.querySelectorAll('[data-dash-project]')) {
    out.headers.push({ text: el.textContent.trim().slice(0, 18), rest: measure(el) })
    const count = el.nextElementSibling
    if (count) out.headers.push({ text: count.textContent.trim(), rest: measure(count) })
  }
  // Hover backdrop: rows repaint to --bg-surface.
  const row = document.querySelector('[data-dash-row]')
  if (row) {
    row.style.background = 'var(--bg-surface)'
    const t = row.querySelector('[data-dash-title]')
    if (t) out.hovered = { text: t.textContent.trim().slice(0, 18), ratio: measure(t) }
    row.style.background = 'transparent'
  }
  return out
})
console.log(`[${tag}] contrast:`, JSON.stringify(contrast, null, 2))

// --- EMPTY state: no live sessions at all --------------------------------------
await p.evaluate(() => {
  document.querySelectorAll('[data-dash-group]').forEach((g) => g.remove())
})
await p.waitForTimeout(200)
await p.screenshot({ path: `${SHOT}/${tag}-2-empty-ish.png` })
await b.close()
