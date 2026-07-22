// Screenshot the Activity Dashboard: full view + a tight crop of the agent cards.
import { webkit } from 'playwright'
const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
p.on('pageerror', e => console.log('ERR', String(e).slice(0, 200)))
await p.goto('http://localhost:1429/dev/mock.html', { waitUntil: 'load' })
await p.waitForTimeout(2500)
await p.getByTitle('Active sessions').click()
await p.waitForTimeout(700)
await p.screenshot({ path: '/tmp/operator-shots/dash/full.png' })

// Tight crop around the grouped rows.
const box = await p.evaluate(() => {
  const gs = Array.from(document.querySelectorAll('[data-dash-group]'))
  if (!gs.length) return null
  const rs = gs.map(g => g.getBoundingClientRect())
  const x = Math.min(...rs.map(r => r.x)), y = Math.min(...rs.map(r => r.y))
  return { x, y, width: Math.max(...rs.map(r => r.right)) - x, height: Math.max(...rs.map(r => r.bottom)) - y }
})
if (box) {
  const pad = 24
  await p.screenshot({ path: '/tmp/operator-shots/dash/cards.png', clip: {
    x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad),
    width: box.width + pad * 2, height: box.height + pad * 2 } })
}
console.log('cards box:', JSON.stringify(box))
await b.close()
