// Open the ⌘K palette in the mock harness and capture what it offers.
import { webkit } from 'playwright'
const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
p.on('pageerror', e => console.log('ERR', String(e).slice(0, 160)))
await p.goto('http://localhost:1429/dev/mock.html', { waitUntil: 'load' })
await p.waitForTimeout(2500)

await p.keyboard.press('Meta+k')
await p.waitForTimeout(700)
await p.screenshot({ path: '/tmp/palette-open.png' })

// Pull the visible palette rows as text so we can assert the groups/labels.
const rows = await p.evaluate(() => {
  const txt = []
  document.querySelectorAll('div,li,button').forEach(el => {
    const s = getComputedStyle(el)
    if (s.position === 'fixed' || s.position === 'absolute') return
  })
  // Grab the deepest elements with short text inside the topmost overlay.
  const all = Array.from(document.body.querySelectorAll('*'))
  const overlay = all.reverse().find(el => (getComputedStyle(el).position === 'fixed') && el.clientHeight > 200)
  if (!overlay) return ['<no overlay found>']
  overlay.querySelectorAll('*').forEach(el => {
    if (el.children.length === 0 && el.textContent?.trim()) txt.push(el.textContent.trim())
  })
  return txt
})
console.log('--- palette rows (' + rows.length + ') ---')
console.log(rows.slice(0, 60).join('\n'))
await b.close()
