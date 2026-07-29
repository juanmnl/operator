// Drive PROJECT-FIRST NAVIGATION end-to-end through the real renderer (see
// dev/project-first-navigation.md): the gallery (no sidebar beside it) → entering a project
// from a card → the scoped sidebar → the switcher popover → back out, by menu and by ⌘⇧O.
// Also covers the ‹ back chevron on Project Home, the scoped rail, and launching an idle lane.
//
// Run against a vite dev server: `npx vite --port 1440` then `node dev/drive-navigation.mjs`.
// (Don't default the port from process.env.PORT — the app's own shell exports PORT.)
import { webkit } from 'playwright'
const PORT = process.env.MOCK_PORT || 1440
const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
p.on('pageerror', e => console.log('ERR', String(e).slice(0, 300)))
p.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 200)) })
await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await p.waitForTimeout(3000)

// 0. The mock always has live ptys, so a cold start re-attaches and focuses one (rule 1
// then scopes to its project). Go to the gallery explicitly to test it.
await p.keyboard.press('Meta+Shift+O')
await p.waitForTimeout(800)

// 1. The gallery: no sidebar beside it, one card per project.
const headings = await p.evaluate(() => Array.from(document.querySelectorAll('h2')).map(h => h.textContent?.trim()))
console.log('1 gallery heading:', JSON.stringify(headings))
console.log('1 sidebar rows visible:', await p.locator('[data-session-row]').count(), '(expect 0)')
const cards = await p.evaluate(() =>
  Array.from(document.querySelectorAll('[role="button"]')).map(el => el.textContent?.trim()))
console.log('1 cards:', JSON.stringify(cards))
await p.screenshot({ path: '/tmp/nav-1-gallery.png' })

// 2. Enter the "operator" project.
await p.locator('[role="button"]').filter({ hasText: 'operator' }).first().click()
await p.waitForTimeout(900)
console.log('2 sidebar header:', JSON.stringify(await p.evaluate(() => {
  const el = document.querySelector('.drag-region [role="button"]')
  return el?.textContent?.trim()
})))
const laneRows = await p.evaluate(() => Array.from(document.querySelectorAll('[data-lane-row]')).map(el => el.getAttribute('data-lane-row')))
const sessRows = await p.evaluate(() => Array.from(document.querySelectorAll('[data-session-row]')).map(el => el.getAttribute('data-session-row')))
console.log('2 lane rows (idle lanes):', JSON.stringify(laneRows))
console.log('2 session rows (live):', JSON.stringify(sessRows))
console.log('2 has Recent section:', (await p.getByText(/Recent ·/).count()) > 0, '(expect false)')
console.log('2 footer identity:', JSON.stringify(await p.evaluate(() => {
  const t = Array.from(document.querySelectorAll('span')).map(s => s.textContent?.trim()).filter(Boolean)
  return t.filter(x => /^Operator v/.test(x))
})))
await p.screenshot({ path: '/tmp/nav-2-project.png' })

// 3. Sidebar must be scoped: no el-encanto session in it.
console.log('3 scoped (no other project rows):', !(await p.evaluate(() =>
  Array.from(document.querySelectorAll('[data-session-row]')).some(el => el.textContent?.includes('booking')))))

// 4. Open the switcher from the header row.
await p.locator('.drag-region [role="button"]').first().click()
await p.waitForTimeout(500)
const switcher = await p.evaluate(() => Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim()).filter(t => t && (t.includes('All projects') || t.includes('Open folder'))))
console.log('4 switcher footer actions:', JSON.stringify(switcher))
await p.screenshot({ path: '/tmp/nav-3-switcher.png' })

// 5. "All projects…" → back to the gallery, sidebar gone again.
await p.getByText('All projects…').first().click()
await p.waitForTimeout(800)
console.log('5 back at gallery:', (await p.locator('[data-session-row]').count()) === 0 && (await p.getByText(/^Projects ·/).count()) > 0)

// 6. Enter a project, focus a live session, and confirm scope + ⌘⇧O.
await p.locator('[role="button"]').filter({ hasText: 'operator' }).first().click()
await p.waitForTimeout(700)
await p.locator('[data-session-row]').first().click()
await p.waitForTimeout(700)
console.log('6 session focused, sidebar still scoped:', await p.locator('[data-session-row]').count())
await p.keyboard.press('Meta+Shift+O')
await p.waitForTimeout(700)
console.log('6 ⌘⇧O returned to gallery:', (await p.getByText(/^Projects ·/).count()) > 0)
await p.screenshot({ path: '/tmp/nav-4-after-shortcut.png' })

// 7. Back in, Esc must close the switcher WITHOUT leaving the project.
await p.locator('[role="button"]').filter({ hasText: 'operator' }).first().click()
await p.waitForTimeout(700)
await p.locator('.drag-region [role="button"]').first().click()
await p.waitForTimeout(400)
await p.keyboard.press('Escape')
await p.waitForTimeout(400)
console.log('7 Esc closed switcher, still in project:', (await p.getByText('All projects…').count()) === 0 && (await p.locator('[data-lane-row]').count()) > 0)
await p.screenshot({ path: '/tmp/nav-5-sidebar.png' })

// 8. The section "+" opens Project Home, which must carry the back chevron.
await p.locator('button[aria-label="Open the roster"]').click()
await p.waitForTimeout(800)
console.log('8 Project Home + back chevron:', (await p.locator('button[aria-label="All projects"]').count()) > 0)
await p.screenshot({ path: '/tmp/nav-6-project-home.png' })

// 9. Collapse to the rail — it must be scoped and badge the project.
await p.keyboard.press('Meta+b')
await p.waitForTimeout(800)
console.log('9 rail project badge:', JSON.stringify(await p.evaluate(() => {
  const b = document.querySelector('button[aria-label^="Project "]')
  return b ? b.textContent?.trim() : null
})))
await p.screenshot({ path: '/tmp/nav-7-rail.png' })
await p.keyboard.press('Meta+b')
await p.waitForTimeout(600)

// 10. Clicking an IDLE lane row launches it.
const before = await p.evaluate(() => window.__calls.filter(c => c.fn === 'terminalSpawn').length)
await p.locator('[data-lane-row="design"]').click()
await p.waitForTimeout(1200)
const after = await p.evaluate(() => window.__calls.filter(c => c.fn === 'terminalSpawn').length)
console.log('10 idle lane launched:', after === before + 1, `(${before} → ${after})`)

// 11. BACK TO PROJECT HOME from a focused session (release blocker 2026-07-28). The session
// view was the only level with no up-navigation, so Project Home — and the moodboard behind
// it — appeared only as a side effect of unfocusing. Must survive a collapsed sidebar and
// must not disturb scope.
await p.locator('[data-session-row="s-code"]').click()
await p.waitForTimeout(1200)
const scopeBefore = await p.evaluate(() => localStorage.getItem('operator.activeProjectId'))
console.log('11 back control in session:', await p.locator('[data-back-to-project]').count(), '(expect 1)')
await p.keyboard.press('Meta+b'); await p.waitForTimeout(700)
console.log('11 survives collapsed sidebar:', (await p.locator('[data-back-to-project]').count()) === 1)
await p.locator('[data-back-to-project]').first().click()
await p.waitForTimeout(900)
console.log('11 lands on Project Home:', await p.evaluate(() => /AGENTS|MOODBOARD/i.test(document.body.innerText)))
console.log('11 scope undisturbed:', scopeBefore === await p.evaluate(() => localStorage.getItem('operator.activeProjectId')))
await p.keyboard.press('Meta+b'); await p.waitForTimeout(500)
await b.close()
