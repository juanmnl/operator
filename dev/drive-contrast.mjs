// Measure the EFFECTIVE contrast of the roster board's receded (idle) lane cards.
// The card sets opacity:0.62, so every text inside composites toward whatever is
// behind the card — which in a light theme is near-white. This computes the real
// post-composite ratio, not the authored one.
import { webkit } from 'playwright'

const theme = process.argv[2] || 'mission-control-light'
const b = await webkit.launch()
const p = await b.newPage({
  viewport: { width: 1440, height: 980 },
  colorScheme: theme.endsWith('light') ? 'light' : 'dark',
})
await p.addInitScript((t) => localStorage.setItem('operator.theme', t), theme)
await p.goto('http://localhost:1429/dev/mock.html', { waitUntil: 'load' })
await p.waitForTimeout(2500)
await p.keyboard.press('Meta+k'); await p.waitForTimeout(500)
await p.keyboard.type('workspace', { delay: 40 }); await p.waitForTimeout(500)
await p.keyboard.press('Enter'); await p.waitForTimeout(1600)

const result = await p.evaluate(() => {
  // WebKit serialises color-mix() as `color(srgb r g b / a)` with 0..1 channels —
  // parsing that with the rgb() 0..255 assumption reads every tinted chip as black.
  const parse = (c) => {
    if (!c || c === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
    const m = (c.match(/[\d.]+/g) || []).map(Number)
    if (!m.length) return { r: 0, g: 0, b: 0, a: 0 }
    const srgb = c.startsWith('color(')
    return {
      r: srgb ? m[0] * 255 : m[0],
      g: srgb ? m[1] * 255 : m[1],
      b: srgb ? m[2] * 255 : m[2],
      a: m.length > 3 ? m[3] : 1,
    }
  }
  // Proper source-over: the result keeps its own alpha, so a stack of translucent
  // layers (accent-tinted chip over card over page) composites in the right order.
  const over = (fg, bg) => {
    const a = fg.a + bg.a * (1 - fg.a)
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 }
    return {
      r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
      g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
      b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
      a,
    }
  }
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
  }
  const ratio = (a, bb) => {
    const [l1, l2] = [lum(a), lum(bb)].sort((x, y) => y - x)
    return (l1 + 0.05) / (l2 + 0.05)
  }
  // Resolve the real painted background behind an element (walk up past transparents).
  const bgOf = (el) => {
    let cur = el, acc = null
    while (cur) {
      const c = parse(getComputedStyle(cur).backgroundColor)
      if (c.a > 0) acc = acc ? over(acc, c) : c
      if (acc && acc.a >= 1) break
      cur = cur.parentElement
    }
    return acc || { r: 255, g: 255, b: 255, a: 1 }
  }
  // Nearest ancestor opacity < 1 (the card recede).
  const opacityChain = (el) => {
    let o = 1, cur = el
    while (cur) { o *= Number(getComputedStyle(cur).opacity); cur = cur.parentElement }
    return o
  }
  const pageBg = parse(getComputedStyle(document.body).backgroundColor)

  const cards = Array.from(document.querySelectorAll('div')).filter((el) => {
    const o = Number(getComputedStyle(el).opacity)
    return o > 0 && o < 1 && el.clientHeight > 60 && el.textContent.length > 40
  })
  const out = []
  for (const card of cards) {
    const name = (card.querySelector('div')?.textContent || '').slice(0, 24)
    const cardOpacity = Number(getComputedStyle(card).opacity)
    const leaves = Array.from(card.querySelectorAll('*')).filter(
      (el) => el.children.length === 0 && (el.textContent || '').trim().length > 2)
    for (const el of leaves.slice(0, 40)) {
      const fg = parse(getComputedStyle(el).color)
      const bgRaw = bgOf(el)
      const bgOnPage = over(bgRaw, pageBg)
      const o = opacityChain(el)
      // Post-composite: the whole card (text AND its bg) fades toward the page bg.
      const fgOnCard = over(fg, bgOnPage)
      const effFg = over({ ...fgOnCard, a: o }, pageBg)
      const effBg = over({ ...bgOnPage, a: o }, pageBg)
      out.push({
        card: name,
        cardOpacity: +cardOpacity.toFixed(2),
        text: (el.textContent || '').trim().slice(0, 28),
        authored: +ratio(fgOnCard, bgOnPage).toFixed(2),
        effective: +ratio(effFg, effBg).toFixed(2),
        px: getComputedStyle(el).fontSize,
      })
    }
  }
  return { pageBg: getComputedStyle(document.body).backgroundColor, rows: out }
})

console.log('page bg:', result.pageBg)
const bad = result.rows.filter((r) => r.effective < 4.5).sort((a, b) => a.effective - b.effective)
console.log(`\n${bad.length} of ${result.rows.length} text nodes on receded cards below 4.5:1\n`)
for (const r of bad.slice(0, 22)) {
  console.log(`  ${String(r.effective).padStart(5)}:1  (authored ${String(r.authored).padStart(5)}:1)  ${r.px.padStart(7)}  [${r.card}] "${r.text}"`)
}
await b.close()
