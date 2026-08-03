// Drive WHERE ENTERING A PROJECT LANDS (dev/briefs/open-project-lands-on-channel.md).
//
// Every project used to open on the roster board; then, once a project could have several lanes,
// "several lanes → the room they talk in" sent you to the channel. The channel is deleted, and
// the rule collapsed to two answers: exactly one LIVE lane → straight into that agent, everything
// else → the BOARD, which is project home. One rule — entering a project shows you the work.
//
// The fixtures give all three: `operator` has 4 lanes with 3 live, `uwazi_app` has 2, `el-encanto`
// has 1 (Code, and it IS live), and `?solo=1` is a one-lane project with nothing running.
import { webkit } from 'playwright'
const PORT = process.env.MOCK_PORT || 1440
const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))
await p.addInitScript(() => { try { localStorage.clear() } catch { /* quota */ } })

/** What surface are we looking at? Read from the DOM, not from state. */
const surface = () => p.evaluate(() => {
  // The board is project home, so it is checked FIRST: the Team tab still renders roster rows,
  // but landing never opens it — a driver that matched the roster first would read the board's
  // own tab bar as a roster landing.
  if (document.querySelector('[data-board], [data-board-column], [data-board-empty]')) return 'board'
  if (document.querySelector('[data-roster-row], [data-role-card]')) return 'roster'
  if (document.querySelector('.xterm, [data-terminal-pane]')) return 'session'
  return 'unknown'
})
const enter = async (name, query = '') => {
  await p.goto(`http://localhost:${PORT}/dev/mock.html${query}`, { waitUntil: 'load' })
  await p.waitForTimeout(3000)
  await p.locator('[data-rail-gallery]').click()
  await p.waitForTimeout(700)
  await p.locator('[data-project-card]').filter({ hasText: name }).first().click()
  await p.waitForTimeout(1400)
  const lanes = await p.evaluate((n) => (JSON.parse(localStorage.getItem('operator.projects') || '[]')
    .find((x) => x.name === n)?.roster ?? []).length, name)
  return { surface: await surface(), lanes }
}

console.log('=== the rule ===')
for (const [name, query, expected] of [
  ['operator', '', 'board'],        // 4 lanes — was 'channel'
  ['uwazi_app', '', 'board'],       // 2 lanes — was 'channel'
  // el-encanto has ONE roster lane (code) but its fixture session deliberately carries no
  // roleId, so nothing is live AS that lane — the board is the correct answer, not session.
  ['el-encanto', '', 'board'],
  ['solo-demo', '?solo=live', 'session'], // 1 lane, LIVE → straight into it
  ['solo-demo', '?solo=1', 'board'],      // 1 lane, IDLE → the board
]) {
  const r = await enter(name, query)
  console.log(`  ${name.padEnd(11)} ${String(r.lanes)} lane(s) → ${r.surface.padEnd(8)} (expect ${expected})  ${r.surface === expected ? 'OK' : 'MISMATCH'}`)
}

// A zero-lane project: delete the only lane, then re-enter.
await p.goto(`http://localhost:${PORT}/dev/mock.html?solo=1`, { waitUntil: 'load' })
await p.waitForTimeout(3000)
await p.evaluate(() => {
  const ps = JSON.parse(localStorage.getItem('operator.projects'))
  ps[0].roster = []
  localStorage.setItem('operator.projects', JSON.stringify(ps))
})
await p.reload({ waitUntil: 'load' })
await p.waitForTimeout(3000)
await p.locator('[data-rail-gallery]').click(); await p.waitForTimeout(700)
await p.locator('[data-project-card]').first().click(); await p.waitForTimeout(1400)
console.log(`  ${'(0 lanes)'.padEnd(11)} 0 lane(s) → ${(await surface()).padEnd(8)} (expect board)`)

console.log('\n=== re-entering the project you are already in must not yank you ===')
await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await p.waitForTimeout(3000)
await p.locator('[data-rail-gallery]').click(); await p.waitForTimeout(700)
await p.locator('[data-project-card]').filter({ hasText: 'operator' }).first().click()
await p.waitForTimeout(1400)
console.log('  entered a 4-lane project →', await surface())
// Now go somewhere else INSIDE it, then re-select the same project from the rail tile.
await p.locator('[data-session-row]').first().click()
await p.waitForTimeout(900)
const parked = await surface()
console.log('  moved to a session     →', parked)
// The rail TILE re-selects without leaving the project — going out via the gallery would clear
// `activeProjectId`, making the return a genuine entry rather than a re-select.
await p.locator('[data-rail-tile]').first().click()
await p.waitForTimeout(1200)
const afterReselect = await surface()
console.log('  re-selected the SAME   →', afterReselect, afterReselect === parked ? '(unchanged — correct)' : '(YANKED)')

console.log('\n=== the project-home verb still works ===')
const home = await p.locator('[data-toolbar-project-home], button').filter({ hasText: /^‹/ }).first().click().then(() => true).catch(() => false)
await p.waitForTimeout(1000)
console.log('  back-chevron →', home ? await surface() : 'not found on this surface', '(expect board)')
await p.screenshot({ path: '/tmp/operator-shots/project-landing.png' })
await b.close()
