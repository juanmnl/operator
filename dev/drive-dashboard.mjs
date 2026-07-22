// Drive the Activity Dashboard ("N agents at work"): rows must say WHO each agent is
// (lane name, lane accent) grouped under its project — not repeat the dev-server
// instruction Operator injects into every launch prompt.
import { webkit } from 'playwright'
const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
p.on('pageerror', e => console.log('ERR', String(e).slice(0, 200)))
await p.goto('http://localhost:1429/dev/mock.html', { waitUntil: 'load' })
await p.waitForTimeout(2500)

// The app boots into a session console; the logo button shows the dashboard.
await p.getByTitle('Active sessions').click()
await p.waitForTimeout(600)
await p.screenshot({ path: '/tmp/dashboard.png' })

console.log('heading:', await p.locator('h2').first().textContent())
// --- Grouped by project ----------------------------------------------------------
console.log('project headers:', JSON.stringify(await p.evaluate(() =>
  Array.from(document.querySelectorAll('[data-dash-project]')).map(el => el.textContent.trim()))))
console.log('groups:', await p.locator('[data-dash-group]').count())
console.log('rows per group:', JSON.stringify(await p.evaluate(() =>
  Array.from(document.querySelectorAll('[data-dash-group]'))
    .map(g => g.querySelectorAll('[data-dash-row]').length))))

// --- Rows name the agent, not the injected instruction ---------------------------
const titles = await p.evaluate(() =>
  Array.from(document.querySelectorAll('[data-dash-title]')).map(el => el.textContent.trim()))
console.log('row titles:', JSON.stringify(titles))
console.log('none start with "First, start"/"First, make sure":',
  titles.every(t => !/^First, (start|make sure)/i.test(t)))
console.log('preamble+task row reads the real task:', titles.includes('Wire up the booking form'))
// Lane rows carry their lane's accent (colour = who, per the roster board).
console.log('lane accents:', JSON.stringify(await p.evaluate(() =>
  Array.from(document.querySelectorAll('[data-dash-title]'))
    .map(el => getComputedStyle(el).color)
    .filter((c, i, a) => a.indexOf(c) === i))))
await b.close()
