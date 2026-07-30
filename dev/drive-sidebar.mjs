// Drive the SCOPED sidebar's affordances (post project-first navigation): the AGENTS list is
// the project's roster — live lanes as session rows, idle lanes as launch rows — so the drag
// that used to reorder sessions within a folder group now reorders the ROSTER, which is what
// orders those rows. The old Recent list, group disclosure and close-all-in-group are gone
// with FolderGroup; the gallery + switcher are covered by dev/drive-navigation.mjs.
//
// Run against a vite dev server: `npx vite --port 1440` then `node dev/drive-sidebar.mjs`.
import { webkit } from 'playwright'
const PORT = process.env.MOCK_PORT || 1440
const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
p.on('pageerror', e => console.log('ERR', String(e).slice(0, 200)))
await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await p.waitForTimeout(3000)

// The mock re-attaches live ptys on boot, which scopes us into the operator project.
const laneOrder = () => p.evaluate(() => Array.from(document.querySelectorAll('[data-lane-row],[data-session-row]'))
  .map(el => el.getAttribute('data-lane-row') || el.getAttribute('data-session-row')))
console.log('rows:', JSON.stringify(await laneOrder()))
console.log('no folder groups left:', (await p.locator('[data-project-group]').count()) === 0)
console.log('no Recent list left  :', (await p.getByText(/Recent ·/).count()) === 0)
await p.screenshot({ path: '/tmp/sidebar-before.png' })

// --- Nothing may spill out of the 220px sidebar ----------------------------------
// The wrapper clips with overflow:hidden, so an over-wide row doesn't scroll — it gets
// SLICED at the edge (the footer icon row did exactly that with seven icons: the theme
// toggle was cut down the middle). Assert the box, don't eyeball it.
const spill = await p.evaluate(() => {
  const sidebar = Array.from(document.querySelectorAll('div')).find(d => getComputedStyle(d).width === '220px')
  if (!sidebar) return ['no sidebar found']
  const edge = sidebar.getBoundingClientRect().right
  return Array.from(sidebar.querySelectorAll('*'))
    .filter(el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.right > edge + 0.5 })
    .map(el => `${(el.getAttribute('title') || el.textContent || el.tagName).trim().slice(0, 28)} +${Math.round(el.getBoundingClientRect().right - edge)}px`)
})
console.log('overflowing the sidebar (want []):', JSON.stringify(spill))

// --- Footer layout ---------------------------------------------------------------
// Two things that only read correctly when they're in the right place: the active COUNT
// belongs to the lanes (so it sits INSIDE their scroller, hugging the last row), and the app
// IDENTITY belongs to the app's own icon row. The identity is the fragile one — with flexWrap
// on, an auto-margined item drops to a line of its own the moment it doesn't fit, which is a
// silent regression that looks like the old layout.
const footer = await p.evaluate(() => {
  const count = document.querySelector('[data-sidebar-active-count]')
  const ident = document.querySelector('[data-sidebar-identity]')
  const lastLane = Array.from(document.querySelectorAll('[data-lane-row], [data-session-row]')).pop()
  const icons = ident ? Array.from(ident.parentElement.querySelectorAll(':scope > button')) : []
  const iconRow = icons.filter((b) => b !== ident)
  return {
    count: count?.textContent?.trim() ?? null,
    // Directly under the lanes, not stranded at the foot of the sidebar: within a row's
    // height of the last one.
    countHugsLanes: count && lastLane
      ? count.getBoundingClientRect().top - lastLane.getBoundingClientRect().bottom < 32
      : null,
    identity: ident?.textContent?.trim() ?? null,
    // Same line as the icons? Compare vertical centres, not tops — the boxes differ in height.
    identityInIconRow: ident && iconRow.length
      ? Math.abs((ident.getBoundingClientRect().top + ident.getBoundingClientRect().bottom) / 2
        - (iconRow[0].getBoundingClientRect().top + iconRow[0].getBoundingClientRect().bottom) / 2) < 4
      : null,
    identityTruncated: ident ? ident.scrollWidth > ident.clientWidth : null,
  }
})
console.log('footer:', JSON.stringify(footer))
console.log('  active count hugs the last lane:', footer.countHugsLanes, '(expect true)')
console.log('  identity shares the icon row (never wrapped below it):', footer.identityInIconRow, '(expect true)')

// --- Lane drag: dropping row 1 onto row 3 must rewrite the ROSTER order ----------
// Use locator.dragTo, NOT a hand-rolled mouse down/move/up: in WebKit the native drag loop
// swallows a synthetic mouseup, so the hand-rolled version ends in `dragend` with no `drop`
// and silently "passes" by changing nothing. dragTo drives the real DnD protocol.
const rows = p.locator('[data-lane-row], [data-session-row]')
await rows.nth(0).dragTo(rows.nth(2))
await p.waitForTimeout(500)
console.log('rows after drag:', JSON.stringify(await laneOrder()))
await p.screenshot({ path: '/tmp/sidebar-after.png' })

// --- An idle lane launches; a live lane focuses ----------------------------------
const spawns = () => p.evaluate(() => window.__calls.filter(c => c.fn === 'terminalSpawn').length)
const before = await spawns()
// A LIVE lane row carries both attributes (the session's id and its role's); an idle one
// only has data-lane-row, which is how the harness tells them apart.
const idle = p.locator('[data-lane-row]:not([data-session-row])').first()
if (await idle.count()) {
  await idle.click()
  await p.waitForTimeout(1200)
  console.log('idle lane launched:', (await spawns()) === before + 1)
}
await p.locator('[data-session-row]').first().click()
await p.waitForTimeout(500)
console.log('live row focuses (terminal visible):', (await p.locator('.xterm').count()) > 0)

// --- Closing the last session leaves you at Project Home, not the gallery --------
for (let i = 0; i < 8 && (await p.locator('[data-session-row]').count()) > 0; i++) {
  const row = p.locator('[data-session-row]').first()
  await row.hover()
  await p.waitForTimeout(150)
  const x = row.locator('button[title]').filter({ hasText: '×' }).first()
  if (!(await x.count())) break
  await x.click()       // arms the confirm
  await x.click()       // confirms
  await p.waitForTimeout(400)
}
await p.waitForTimeout(600)
console.log('still inside the project after closing all:', (await p.getByText(/^Projects ·/).count()) === 0)
await p.screenshot({ path: '/tmp/sidebar-closed.png' })
await b.close()
