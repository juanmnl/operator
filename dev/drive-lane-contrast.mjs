// Verify laneTextColor across EVERY theme: lane titles on the dashboard and lane names
// in the sidebar must clear 4.5:1, and the dark themes must be unchanged (blend 0%).
import { webkit } from 'playwright'

const THEMES = [
  'mission-control-dark', 'mission-control-light',
  'mr-pink-dark', 'mr-pink-light',
  '1984-dark', '1984-light',
]

const b = await webkit.launch()
for (const theme of THEMES) {
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: theme.endsWith('light') ? 'light' : 'dark' })
  await p.addInitScript((t) => localStorage.setItem('operator.theme', t), theme)
  await p.goto('http://localhost:1429/dev/mock.html', { waitUntil: 'load' })
  await p.waitForTimeout(2200)
  await p.getByTitle('Active sessions').click()
  await p.waitForTimeout(600)

  const res = await p.evaluate(() => {
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
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b) }
    const ratio = (x, y) => { const [l1, l2] = [lum(x), lum(y)].sort((m, n) => n - m); return (l1 + 0.05) / (l2 + 0.05) }
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
    const measure = (el) => {
      const bg = bgOf(el)
      return +ratio(over(parse(getComputedStyle(el).color), bg), bg).toFixed(2)
    }
    const out = { blend: getComputedStyle(document.documentElement).getPropertyValue('--lane-ink-blend').trim(), rows: [] }
    for (const el of document.querySelectorAll('[data-dash-title]')) {
      out.rows.push({ where: 'dash', text: el.textContent.trim().slice(0, 14), r: measure(el) })
    }
    // Sidebar lane names: the tracked-uppercase spans inside session rows.
    for (const row of document.querySelectorAll('[data-session-row]')) {
      for (const el of row.querySelectorAll('span')) {
        if (getComputedStyle(el).textTransform === 'uppercase' && el.children.length === 0 && el.textContent.trim().length > 2 && getComputedStyle(el).fontWeight >= 600) {
          out.rows.push({ where: 'side', text: el.textContent.trim().slice(0, 14), r: measure(el) })
          break
        }
      }
    }
    return out
  })

  const worst = res.rows.length ? Math.min(...res.rows.map((r) => r.r)) : NaN
  const bad = res.rows.filter((r) => r.r < 4.5)
  console.log(`\n${theme.padEnd(22)} blend=${(res.blend || '(unset)').padStart(4)}  worst=${worst.toFixed(2)}  ${bad.length ? 'FAIL ' + bad.length : 'PASS'}`)
  for (const r of res.rows) console.log(`   ${r.r < 4.5 ? '✗' : '·'} ${String(r.r).padStart(6)}:1  [${r.where}] ${r.text}`)
  await p.close()
}
await b.close()
