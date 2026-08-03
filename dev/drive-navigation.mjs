// Drive PROJECT-FIRST NAVIGATION end-to-end through the real renderer (see
// dev/project-first-navigation.md): the gallery (no sidebar beside it) → entering a project
// from a card → the scoped sidebar → back out, via the RAIL's foot controls and ⌘⇧O.
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

// 4. Cross-PROJECT navigation lives at the RAIL's foot — the sidebar header is not a switcher.
// (It IS a control now, but only for one destination: this project's home. Step 12.)
const railFoot = await p.evaluate(() => ({
  controls: Array.from(document.querySelectorAll('[data-rail-gallery], [data-rail-open-folder]')).map(b => b.getAttribute('aria-label')),
  headerIsNotASwitcher: !document.querySelector('[data-switcher-trigger]'),
}))
console.log('4 rail foot controls:', JSON.stringify(railFoot.controls), '(expect All projects + Open folder)')
console.log('4 sidebar header is not a project switcher:', railFoot.headerIsNotASwitcher, '(expect true)')
await p.screenshot({ path: '/tmp/nav-3-rail-foot.png' })

// 5. "All projects" → back to the gallery, sidebar gone again.
await p.locator('[data-rail-gallery]').click()
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

// 7. Back in: a rail tile switches project without going via the gallery.
await p.locator('[role="button"]').filter({ hasText: 'operator' }).first().click()
await p.waitForTimeout(700)
const scopedBefore = await p.evaluate(() => document.querySelector('[data-sidebar-project-name]')?.textContent?.trim())
await p.locator('[data-rail-tile]').nth(1).click()
await p.waitForTimeout(900)
const scopedAfter = await p.evaluate(() => document.querySelector('[data-sidebar-project-name]')?.textContent?.trim())
console.log('7 a rail tile switches project in place:', scopedBefore, '→', scopedAfter, '·', scopedBefore !== scopedAfter && (await p.locator('[data-lane-row], [data-session-row]').count()) > 0)
// …and back, so the steps below run against the same project they always did.
await p.locator('[data-rail-tile]').first().click()
await p.waitForTimeout(900)
await p.screenshot({ path: '/tmp/nav-5-sidebar.png' })

// 8. The section "+" opens Project Home, which must carry the back chevron. It says ROSTER,
// so it must land on TEAM — it called handleOpenProjectHome, which hard-sets the board.
await p.locator('button[aria-label="Open the roster"]').click()
await p.waitForTimeout(800)
console.log('8 Project Home + back chevron:', (await p.locator('button[aria-label="All projects"]').count()) > 0)
console.log('8 "+" lands on the roster:', await p.evaluate(() =>
  document.querySelector('[data-project-tab-active]')?.getAttribute('data-project-tab')), '(expect team)')
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

// 12. THE SIDEBAR PROJECT HEADER IS THE OTHER WAY HOME (2026-08-03). "clicking on an agent
// then on the project doesn't navigate" was reported three times; the two fixes before this
// one landed on the RAIL, and the control actually being clicked — the biggest, closest
// "go back to the project" target on screen — had never been wired at all.
// The trap this step exists to catch: the header lives inside <DragRegion>, whose mousedown
// handler starts a WINDOW DRAG unless the press lands on a button/[role="button"]. A plain
// onClick on a div is eaten before it fires, so assert the navigation, not the handler.
await p.locator('[data-session-row="s-code"]').click()
await p.waitForTimeout(1200)
// "Unfocused" is the HEADER swapping session→project, not the terminal unmounting: the
// chosen surface overlays a still-mounted, still-sized pty on purpose (resizing it hangs it).
// So a live .xterm after navigating is the aliveness evidence, not a failure.
const ptyBefore = await p.evaluate(() => ({
  header: document.querySelector('[data-toolbar-header]')?.getAttribute('data-toolbar-header'),
  xterm: !!document.querySelector('.xterm'),
  kills: window.__calls.filter(c => c.fn === 'terminalKill').length,
  rows: document.querySelectorAll('[data-session-row]').length,
}))
console.log('12 focused an agent:', JSON.stringify(ptyBefore), '(expect header=session, xterm true)')
const header = await p.evaluate(() => {
  const el = document.querySelector('[data-sidebar-project]')
  return {
    role: el?.getAttribute('role'),
    label: el?.getAttribute('aria-label'),
    cursor: el ? getComputedStyle(el).cursor : null,
    // The path line must be INSIDE the target, not a dead strip under it.
    coversPath: !!el?.querySelector('[title^="/"], [title^="~"]'),
    height: el ? Math.round(el.getBoundingClientRect().height) : 0,
  }
})
console.log('12 header is a real control in a session:', JSON.stringify(header), '(expect role=button, pointer)')
// The affordance has to be EYEBALLED in both states, so shoot the header itself, hovered,
// not a 1440px page where it's 220px of one corner.
const shotHeader = async (path) => {
  await p.locator('[data-sidebar-project]').hover()
  await p.waitForTimeout(250)
  const box = await p.locator('[data-sidebar-project]').boundingBox()
  await p.screenshot({ path, clip: { x: box.x - 12, y: box.y - 10, width: box.width + 24, height: box.height + 20 } })
}
await shotHeader('/tmp/nav-8-header-in-agent.png')
await p.locator('[data-sidebar-project]').click()
await p.waitForTimeout(900)
const afterClick = await p.evaluate(() => ({
  tab: document.querySelector('[data-project-tab-active]')?.getAttribute('data-project-tab'),
  atHome: /AGENTS|MOODBOARD/i.test(document.body.innerText),
  header: document.querySelector('[data-toolbar-header]')?.getAttribute('data-toolbar-header'),
  xterm: !!document.querySelector('.xterm'),
  kills: window.__calls.filter(c => c.fn === 'terminalKill').length,
  rows: document.querySelectorAll('[data-session-row]').length,
}))
console.log('12 lands on Project Home (board):', afterClick.atHome && afterClick.tab === 'board', `(tab=${afterClick.tab})`)
console.log('12 agent unfocused:', afterClick.header === 'project', `(header ${ptyBefore.header}→${afterClick.header})`)
console.log('12 …but its pty is still alive:', afterClick.xterm && afterClick.kills === ptyBefore.kills && afterClick.rows === ptyBefore.rows,
  `(xterm ${afterClick.xterm}, kills ${afterClick.kills}, rows ${ptyBefore.rows}→${afterClick.rows})`)

// …and clicking it AGAIN, from home, must change nothing — and must not even light up.
const homeState = await p.evaluate(() => {
  const el = document.querySelector('[data-sidebar-project]')
  return { role: el?.getAttribute('role') ?? null, cursor: el ? getComputedStyle(el).cursor : null }
})
await p.locator('[data-sidebar-project]').hover()
await p.waitForTimeout(250)
const hoverBg = await p.evaluate(() => getComputedStyle(document.querySelector('[data-sidebar-project]')).backgroundColor)
await p.locator('[data-sidebar-project]').click()
await p.waitForTimeout(700)
const idle = await p.evaluate(() => ({
  tab: document.querySelector('[data-project-tab-active]')?.getAttribute('data-project-tab'),
  atHome: /AGENTS|MOODBOARD/i.test(document.body.innerText),
}))
console.log('12 inert at home:', homeState.role === null && homeState.cursor !== 'pointer', JSON.stringify(homeState))
console.log('12 not hover-lit at home:', /rgba\(0, 0, 0, 0\)|transparent/.test(hoverBg), `(bg=${hoverBg})`)
console.log('12 clicking at home changes nothing:', idle.atHome && idle.tab === afterClick.tab, `(tab=${idle.tab})`)
await shotHeader('/tmp/nav-9-header-at-home.png')

// (The `previous` chip now lives INSIDE this target and must not navigate. It only renders
// for a shelved project, which needs the durable-store stand-in — so that assertion lives in
// dev/drive-sidebar-chip.mjs step 3, which already builds that fixture.)
await b.close()
