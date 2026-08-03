// Task lifecycle (dev/briefs/queued-tasks-no-trigger.md). Three things the durable store got
// wrong and one that must stay right:
//   1. the roster chip counted running + done tasks and labelled the total "QUEUED";
//   2. a task stamped with a pty id from a previous run could never be completed again, so
//      `running` accumulated forever (one project: 26 running, 0 done);
//   3. genuinely queued tasks with no roleId are routed by nothing — they must at least be
//      visible and assignable rather than silently stuck.
//
// Run against a vite dev server: `npx vite --port 1440` then `node dev/drive-task-lifecycle.mjs`.
// (Port 1440, NOT 1433 — that's a bare Python server, not the app.)
import { webkit } from 'playwright'
const PORT = process.env.MOCK_PORT || 1440
const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))
await p.addInitScript(() => { try { localStorage.removeItem('operator.activeProjectId') } catch { /* quota */ } })
await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await p.waitForTimeout(3000)
await p.keyboard.press('Meta+Shift+O')
await p.waitForTimeout(600)
await p.locator('[data-project-card]').filter({ hasText: 'operator' }).first().click()
await p.waitForTimeout(900)
await p.locator('button[aria-label="Add an agent on the roster"]').click()
await p.waitForTimeout(1200)

// --- 1. The chip counts ONLY queued -----------------------------------------------------
// Fixture: code has 1 queued + 1 running(live t1) + 1 running(dead) ; design has 1 queued +
// 1 running(dead). The pre-fix count would have been 3 and 2.
const chips = await p.evaluate(() => Array.from(document.querySelectorAll('[data-role-card],[data-roster-row]')).map((el) => {
  const id = el.getAttribute('data-role-card') || el.getAttribute('data-roster-row')
  const m = (el.textContent || '').match(/(\d+)\s*QUEUED/i)
  return `${id}:${m ? m[1] : 0}`
}))
console.log('1 chip counts (lane:queued):', JSON.stringify(chips))

// --- 2. Stranded tasks were reconciled on load ------------------------------------------
const lifecycle = await p.evaluate(() => {
  const proj = JSON.parse(localStorage.getItem('operator.projects') || '[]').find((x) => x.name === 'operator')
  const by = { queued: 0, running: 0, done: 0, abandoned: 0, reconciled: 0 }
  for (const t of proj?.tasks ?? []) {
    by[t.status ?? 'queued'] = (by[t.status ?? 'queued'] ?? 0) + 1
    if (t.reconciledAt) by.reconciled++
  }
  return by
})
console.log('2 durable task states after load:', JSON.stringify(lifecycle))
// `abandoned`, not `done`: reconciliation knows the run ended, never that the work finished.
console.log('2 the dead-pty tasks were ABANDONED (not silently "done"):', lifecycle.abandoned === 2 && lifecycle.running === 1)

// --- 3. A reconciled task admits it is unconfirmed ---------------------------------------
// The closed list (done + abandoned) is collapsed by default — expand it first. Its header
// counts abandoned separately, because "Closed · 68" reading as 68 finished tasks was the same
// lie in aggregate that `status: 'done'` was per task.
const closedHeader = await p.locator('[data-task-closed-header]').first().textContent()
console.log('3 closed header:', JSON.stringify(closedHeader?.trim()))
await p.locator('[data-task-closed-header]').first().click()
await p.waitForTimeout(500)
const marks = await p.evaluate(() => Array.from(document.querySelectorAll('[data-task-reconciled]')).map((e) => e.textContent?.trim()))
console.log('3 "unconfirmed" markers on the done rows:', marks.length, JSON.stringify(marks.slice(0, 2)))

// --- 4. Unassigned queued tasks are visible AND assignable -------------------------------
const unassigned = await p.evaluate(() => {
  const heads = Array.from(document.querySelectorAll('*')).filter((e) => e.children.length === 0 && /^Unassigned$/.test(e.textContent?.trim() || ''))
  const selects = Array.from(document.querySelectorAll('select')).filter((s) => Array.from(s.options).some((o) => o.textContent === 'Unassigned'))
  return { group: heads.length > 0, assignSelects: selects.length }
})
console.log('4 unassigned group shown:', unassigned.group, '| rows with an assignee select:', unassigned.assignSelects)
await p.screenshot({ path: '/tmp/operator-shots/task-lifecycle.png' })
await b.close()
