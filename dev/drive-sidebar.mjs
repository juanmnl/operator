// Drive the sidebar's affordances: the "Recent" projects list (collapse + open a
// project) and drag-reorder of a session row within its project group.
import { webkit } from 'playwright'
const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
p.on('pageerror', e => console.log('ERR', String(e).slice(0, 200)))
await p.goto('http://localhost:1429/dev/mock.html', { waitUntil: 'load' })
await p.waitForTimeout(2500)
await p.screenshot({ path: '/tmp/sidebar-before.png' })

// --- Recent projects: rendered, and scoped to projects with nothing live ---------
// (Read-only checks here; the interactive ones run LAST, since opening a project
// navigates away and would change what the session-row steps below are looking at.)
const header = p.locator('button', { hasText: 'Recent · ' })
console.log('recent header:', await header.count())
const recentRows = () => p.evaluate(() =>
  Array.from(document.querySelectorAll('[data-recent-project]')).map(el => el.textContent.trim()))
console.log('recent rows:', JSON.stringify(await recentRows()))
// No per-row dismiss on a project row (that was the old per-session list).
console.log('forget buttons (want 0):', await p.locator('[data-forget]').count())
// The live project must NOT also appear under Recent.
console.log('recent excludes live project:', !(await recentRows()).includes('operator'))

// --- Session reorder within the group -------------------------------------------
// Scoped to the 'operator' project's group: the mock now has a live session in a second
// project too, and an unscoped query would mix both groups' rows into one list.
const order = () => p.evaluate(() => {
  const g = document.querySelector('[data-project-group^="operator-"]')
  return Array.from(g?.querySelectorAll('[data-session-row]') ?? []).map(el => el.getAttribute('data-session-row'))
})
console.log('session order before:', JSON.stringify(await order()))
const rows = p.locator('[data-session-row]')
const src = await rows.nth(0).boundingBox()
const dst = await rows.nth(2).boundingBox()
await p.mouse.move(src.x + src.width / 2, src.y + src.height / 2)
await p.mouse.down()
await p.mouse.move(dst.x + dst.width / 2, dst.y + dst.height - 3, { steps: 12 })
await p.mouse.move(dst.x + dst.width / 2, dst.y + dst.height - 1, { steps: 4 })
await p.screenshot({ path: '/tmp/sidebar-dragging.png' })
await p.mouse.up()
await p.waitForTimeout(500)
console.log('session order after :', JSON.stringify(await order()))
await p.screenshot({ path: '/tmp/sidebar-after.png' })

// --- Project section: collapse, expand, close-all -------------------------------
const chevron = p.getByLabel(/^(Collapse|Expand) operator$/)
console.log('group chevron:', await chevron.count())
await chevron.click()
await p.waitForTimeout(300)
console.log('rows when group collapsed:', JSON.stringify(await order()))
await p.screenshot({ path: '/tmp/sidebar-group-collapsed.png' })
await chevron.click()
await p.waitForTimeout(300)
console.log('rows when group expanded :', JSON.stringify(await order()))
// Close the whole section (ends all three agents; hover the header to reveal ×).
await p.locator('div', { hasText: /^operator$/ }).first().hover().catch(() => {})
const closeAll = p.getByLabel('Close all agents in operator')
await closeAll.click({ force: true })
await p.waitForTimeout(600)
console.log('rows after close-all:', JSON.stringify(await order()))
await p.screenshot({ path: '/tmp/sidebar-closed.png' })

// --- Recent projects, interactive: collapse, expand, open a workspace ------------
await header.click()
await p.waitForTimeout(300)
console.log('recent rows after collapse:', JSON.stringify(await recentRows()))
await p.screenshot({ path: '/tmp/sidebar-collapsed.png' })
await header.click()
await p.waitForTimeout(300)
console.log('recent rows after expand :', JSON.stringify(await recentRows()))
// Click a Recent row → its workspace opens, and the click spawns nothing.
const spawnsBefore = await p.evaluate(() => window.__calls.filter(c => c.fn === 'terminalSpawn').length)
// By name, not .first(): close-all put 'operator' at the top of Recent, and its saved
// sessions were just forgotten — only uwazi_app still has a dormant agent to resume.
await p.locator('[data-recent-project]', { hasText: 'uwazi_app' }).click()
await p.waitForTimeout(500)
// The workspace = ProjectView (its Moodboard tab), sitting there waiting to launch —
// its "Resume N agents" button proves it's the CLICKED project (only that one has a
// dormant saved session), and that per-session restore still has a home.
console.log('workspace opened:', await p.getByText('Moodboard', { exact: true }).first().isVisible().catch(() => false))
// (Case-insensitive: the button is uppercased by CSS, which is what Playwright reads.)
console.log('resume button:', await p.locator('button', { hasText: /^resume \d+ agent/i }).count())
console.log('spawns from the click (want 0):',
  (await p.evaluate(() => window.__calls.filter(c => c.fn === 'terminalSpawn').length)) - spawnsBefore)
await p.screenshot({ path: '/tmp/sidebar-recent-open.png' })
await b.close()
