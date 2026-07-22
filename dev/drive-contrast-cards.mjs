// Measure specific roster-card texts REGARDLESS of any card opacity, so the idle-card
// legibility fix can be compared like-for-like. Pass `--simulate-old` to re-apply the
// old opacity:0.62 recede and print the before/after side by side.
import { webkit } from 'playwright'

const theme = process.argv[2] || 'mission-control-light'
const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 980 }, colorScheme: theme.endsWith('light') ? 'light' : 'dark' })
await p.addInitScript((t) => localStorage.setItem('operator.theme', t), theme)
await p.goto('http://localhost:1429/dev/mock.html', { waitUntil: 'load' })
await p.waitForTimeout(2500)
await p.keyboard.press('Meta+k'); await p.waitForTimeout(500)
await p.keyboard.type('workspace', { delay: 40 }); await p.waitForTimeout(500)
await p.keyboard.press('Enter'); await p.waitForTimeout(1600)

const measure = async (simulateOld) => p.evaluate((old) => {
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
  const ratio = (a, bb) => { const [l1, l2] = [lum(a), lum(bb)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05) }
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

  const findCard = (name) => Array.from(document.querySelectorAll('div'))
    .filter((el) => el.clientHeight > 60 && (el.querySelector('div')?.textContent || '').trim().startsWith(name))
    .sort((a, b) => a.clientHeight - b.clientHeight)[0]

  const out = []
  for (const cardName of ['Review', 'QA', 'Design']) {
    const card = findCard(cardName)
    if (!card) continue
    if (old) card.style.opacity = '0.62'
    const leaves = Array.from(card.querySelectorAll('*')).filter((el) => el.children.length === 0 && (el.textContent || '').trim().length > 2)
    for (const el of leaves) {
      const t = (el.textContent || '').trim()
      if (!/^(Launch|Opus|Sonnet|High|Normal|Own UI|Review adv|Verify beh)/.test(t)) continue
      const fg = parse(getComputedStyle(el).color)
      const bg = bgOf(el)
      const o = opacityChain(el)
      const fgOnBg = over(fg, bg)
      out.push({
        card: cardName, text: t.slice(0, 26), px: getComputedStyle(el).fontSize,
        ratio: +ratio(over({ ...fgOnBg, a: o }, pageBg), over({ ...bg, a: o }, pageBg)).toFixed(2),
      })
    }
    if (old) card.style.opacity = ''
  }
  return out
}, simulateOld)

const now = await measure(false)
const before = await measure(true)
const key = (r) => `${r.card}|${r.text}`
const map = new Map(before.map((r) => [key(r), r.ratio]))
console.log(`\n${theme}\n  was  →  now    size    text`)
for (const r of now) {
  const wasV = map.get(key(r))
  const flag = r.ratio >= 4.5 ? 'ok ' : r.ratio >= 3 ? '~  ' : 'LOW'
  console.log(`  ${String(wasV).padStart(5)} → ${String(r.ratio).padStart(5)}  ${flag} ${r.px.padStart(7)}  [${r.card}] "${r.text}"`)
}
await b.close()
