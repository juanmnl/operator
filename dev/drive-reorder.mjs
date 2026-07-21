// Drive a real drag in the roster: grab the Operator lane's grip and drop it below Code.
import { webkit } from 'playwright'
const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
p.on('pageerror', e => console.log('ERR', String(e).slice(0, 200)))
await p.goto('http://localhost:1429/dev/mock.html', { waitUntil: 'load' })
await p.waitForTimeout(2500)

// Open the project workspace (the roster board) via ⌘K.
await p.keyboard.press('Meta+k')
await p.waitForTimeout(400)
await p.keyboard.type('Open operator workspace')
await p.waitForTimeout(400)
await p.keyboard.press('Enter')
await p.waitForTimeout(1200)
await p.screenshot({ path: '/tmp/roster.png' })

const names = () => p.evaluate(() =>
  Array.from(document.querySelectorAll('[aria-label^="Reorder "]')).map(el => el.getAttribute('aria-label')))
console.log('before:', JSON.stringify(await names()))

const grips = p.locator('[aria-label^="Reorder "]')
if (await grips.count() < 3) { console.log('roster not visible; grips =', await grips.count()); await b.close(); process.exit(0) }

// Drag lane 1 (Operator) past lane 3 (Code).
const src = await grips.nth(0).boundingBox()
const dst = await grips.nth(2).boundingBox()
await p.mouse.move(src.x + 5, src.y + 5)
await p.mouse.down()
await p.mouse.move(dst.x + 5, dst.y + dst.height, { steps: 12 })
await p.mouse.move(dst.x + 5, dst.y + dst.height + 4, { steps: 4 })
await p.screenshot({ path: '/tmp/roster-dragging.png' })
await p.mouse.up()
await p.waitForTimeout(700)
console.log('after :', JSON.stringify(await names()))
await p.screenshot({ path: '/tmp/roster-after.png' })
await b.close()
