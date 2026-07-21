// Verify the sidebar hover card: does it show the CURRENT task, and does it work
// with the pane OPEN (not just the collapsed rail)?
// The Code lane's in-progress todo ("Extract routeDispatch into lib/dispatch") differs
// from its summary ("Extract the dispatch router"), so the two are distinguishable.
import { webkit } from 'playwright'
const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
p.on('pageerror', e => console.log('ERR', String(e).slice(0, 160)))
await p.goto('http://localhost:1429/dev/mock.html', { waitUntil: 'load' })
await p.waitForTimeout(2500)

const sidebarRows = await p.evaluate(() =>
  Array.from(document.querySelectorAll('[role="button"]'))
    .map(el => el.textContent?.trim().slice(0, 40)).filter(Boolean))
console.log('sidebar rows:', JSON.stringify(sidebarRows.slice(0, 8)))

// Hover the Code lane row in the EXPANDED sidebar.
const row = p.locator('[role="button"]').filter({ hasText: 'Code' }).first()
await row.hover()
await p.waitForTimeout(600)
await p.screenshot({ path: '/tmp/hover-expanded.png' })

// Read any fixed-position card that appeared.
const card = await p.evaluate(() => {
  const fixed = Array.from(document.querySelectorAll('div'))
    .filter(el => getComputedStyle(el).position === 'fixed' && el.clientHeight > 0 && el.clientHeight < 200)
  return fixed.map(el => el.textContent?.trim()).filter(t => t && t.length > 4).slice(-3)
})
console.log('hover card text:', JSON.stringify(card))
await b.close()
