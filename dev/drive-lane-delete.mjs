// DELETING A LANE MUST NOT ERASE WHO ITS TASKS WERE FOR.
//
// The board has a built, reviewed treatment for a task whose lane is gone — `AgentChip`'s
// `lostRoleId` → `design — lane gone`, and the assignee picker's `gone` branch. Deleting a lane
// is the ONLY user action that can produce a dangling roleId, and `removeRoleFrom` used to clear
// the roleId as it went — so that UI was unreachable through the one path to it, and a task filed
// against Design read as "Unassigned", i.e. as though nobody had ever been asked.
//
// QA found it by driving the real delete; every existing driver missed it because the board
// driver's fixture hand-writes `roleId: 'infra'` with no such lane in the roster — it exercises
// the RENDERING of the lost state, never the action that is supposed to produce it. This driver
// exists to close that gap: it deletes a real lane and reads the real board.
//
// Exits 1 on any failed assertion.
// Run: `npx vite --port 1441` then `MOCK_PORT=1441 node dev/drive-lane-delete.mjs`.
import { webkit } from 'playwright'
const PORT = process.env.MOCK_PORT || 1441

let failed = 0
const ok = (label, pass, detail) => {
  if (!pass) failed++
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`)
}

const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
p.on('pageerror', (e) => { console.log('ERR', String(e).slice(0, 200)); failed++ })
await p.addInitScript(() => { try { localStorage.clear() } catch { /* quota */ } })
await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await p.waitForTimeout(3000)

const roleIdOf = (id) => p.evaluate((t) => (JSON.parse(localStorage.getItem('operator.projects') || '[]')[0]?.tasks ?? [])
  .find((x) => x.id === t)?.roleId ?? null, id)
const tab = (name) => p.locator('[data-toolbar-header="project"] button', { hasText: new RegExp(`^${name}$`) }).click()

await p.locator('[data-rail-gallery]').click(); await p.waitForTimeout(700)
await p.locator('[data-project-card]').first().click(); await p.waitForTimeout(1200)

// 1. File the task against a lane, through the board's own picker.
const task = await p.evaluate(() => document.querySelector('[data-task-card]')?.getAttribute('data-task-card') ?? null)
ok('(precondition) a backlog card to assign', !!task, task)
await p.locator(`[data-task-card="${task}"] [data-card-assignee] select`).selectOption('design')
await p.waitForTimeout(600)
ok('the task is filed against the design lane', (await roleIdOf(task)) === 'design')

// 2. Delete that lane from Team, through the real two-click confirm.
await tab('Team'); await p.waitForTimeout(900)
await p.locator('[data-roster-row="design"]').hover(); await p.waitForTimeout(200)
await p.locator('[data-roster-row="design"] button[aria-label^="Configure"]').click(); await p.waitForTimeout(500)
const del = p.locator('[data-role-card="design"] [data-role-remove]')
await del.click(); await p.waitForTimeout(300)   // arms
await del.click(); await p.waitForTimeout(900)   // confirms
ok('the lane is gone from the roster', await p.evaluate(() =>
  !(JSON.parse(localStorage.getItem('operator.projects') || '[]')[0]?.roster ?? []).some((r) => r.id === 'design')))

// 3. THE POINT: the task still names it, and the board says so.
ok('the task STILL names the deleted lane — deleting a lane is not deleting the record of who it was for',
  (await roleIdOf(task)) === 'design', await roleIdOf(task))
await tab('Board'); await p.waitForTimeout(900)
const lost = await p.evaluate((t) =>
  document.querySelector(`[data-task-card="${t}"] [data-card-agent-lost]`)?.getAttribute('data-card-agent-lost') ?? null, task)
const picker = await p.evaluate((t) =>
  document.querySelector(`[data-task-card="${t}"] [data-card-assignee]`)?.textContent?.trim() ?? '', task)
ok('the board names the lost lane rather than reading "Unassigned"',
  /design\s*—\s*gone/.test(picker) || lost === 'design', { picker: picker.slice(0, 40), lost })
ok('…and it does NOT read as never-assigned', !/^Assign…/.test(picker) && !/^Unassigned/.test(picker), picker.slice(0, 40))

await p.screenshot({ path: '/tmp/operator-shots/lane-delete-gone.png' })
await b.close()
console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
