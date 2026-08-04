// A TASK MUST LEAVE `running` WHEN ITS LANE FINISHES THE TURN (2026-08-04).
//
// Measured across the real store before this fix: 72 tasks `running`, ZERO done, every one
// stamped with a LIVE terminal id. Not the old stale-id leak — a lifecycle with no exit. The
// only automatic close was `exitCompleteRef`, which fires when a lane's SESSION ENDS, and lanes
// are long-lived and take task after task. So nothing ever closed, the board read as a wall of
// running work, and the Done column stayed empty forever.
//
// task-lifecycle.test.ts proves `finishedTurn`'s edge rule. It cannot prove that anything calls
// it — which is the failure mode that hid the rescue-CR bug and the dead-pty dispatch bug in a
// fully green suite, twice in one day. This driver is the only proof of the wiring: it dispatches
// real work, drives the real phase transition, and reads the task's status back.
//
// Run: `npx vite --port 1441 --strictPort` then `MOCK_PORT=1441 node dev/drive-task-completion.mjs`
import { webkit } from 'playwright'

const PORT = process.env.MOCK_PORT || 1441
let failed = 0
const ok = (label, pass, detail) => {
  if (!pass) failed++
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`)
}

const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))
await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await p.waitForTimeout(3000)

/** Statuses of the `code` lane's tasks, straight out of the persisted store. */
const codeTaskStatuses = () => p.evaluate(() => {
  const projects = JSON.parse(localStorage.getItem('operator.projects') || '[]')
  return projects.flatMap((pr) => (pr.tasks || [])
    .filter((t) => t.roleId === 'code')
    .map((t) => ({ id: t.id, status: t.status ?? 'queued' })))
})

// ── 1. Dispatch → the task is running ───────────────────────────────────────────────────────
await p.evaluate(() => {
  window.__mockPhase('s-code', { phase: 'running' })
  window.__mockDispatch({ id: 'done-1', terminalId: 't0', role: 'code', task: 'a task that will finish' })
})
await p.waitForTimeout(2500)
const running = await codeTaskStatuses()
ok('the dispatched task is running', running.some((t) => t.status === 'running'), running.slice(0, 4))

// ── 2. The lane finishes its turn → the task closes ─────────────────────────────────────────
// This is the edge `finishedTurn` watches, and the same one the review toast already used.
await p.evaluate(() => { window.__mockPhase('s-code', { phase: 'waiting' }) })
await p.waitForTimeout(3000)
const after = await codeTaskStatuses()
ok('…and it is no longer running once the turn ends', !after.some((t) => t.status === 'running'), after.slice(0, 4))
ok('…it landed in done, not abandoned', after.some((t) => t.status === 'done'), after.slice(0, 4))

// ── 3. Going busy again must not close anything that has not started ─────────────────────────
// The edge is busy→not-busy. Entering work is not a completion, and a second waiting tick with
// nothing running must be a no-op rather than a repeated close.
const before3 = JSON.stringify(await codeTaskStatuses())
await p.evaluate(() => { window.__mockPhase('s-code', { phase: 'running' }) })
await p.waitForTimeout(1200)
await p.evaluate(() => { window.__mockPhase('s-code', { phase: 'waiting' }) })
await p.waitForTimeout(1500)
ok('an idle lane with no running work changes nothing', JSON.stringify(await codeTaskStatuses()) === before3)

await b.close()
console.log(failed ? `\n${failed} FAILED` : '\nall checks passed')
process.exit(failed ? 1 : 0)
