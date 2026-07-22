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

// --- Row titles go through the shared label ladder --------------------------------
// Read the titles from the rows themselves ([data-row], see CommandPalette's Row): first
// child of the row's text column. Operator prepends a dev-server instruction to every
// lane's opening prompt, and a session summarised by its FIRST prompt would show that
// boilerplate as its title — so every launched agent reads identically. Same assertion
// the dashboard harness makes (lib/session-label is the one ladder for both).
const titles = await p.evaluate(() =>
  Array.from(document.querySelectorAll('[data-row]'))
    .map((r) => r.firstElementChild?.firstElementChild?.textContent?.trim() || '')
    .filter(Boolean))
console.log('row titles:', JSON.stringify(titles.slice(0, 40)))
console.log('none start with "First, start"/"First, make sure":',
  titles.every(t => !/^First, (start|make sure)/i.test(t)))
console.log('preamble+task row reads the real task:', titles.includes('Wire up the booking form'))
await b.close()
