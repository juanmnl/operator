// TWO DISPATCH-HYGIENE FIXES (2026-08-03).
//
// 1. A dispatch naming a lane this project does not have must NOT become a `ProjectTask`. Eight
//    rows filed that way in July were lane STATUS REPORTS ("code done: …"); twelve days later
//    they were assigned and dispatched back into a live session as if they were work, and six of
//    the eight described work that was already finished. A delivery failure belongs in Waiting.
// 2. A queued task older than the horizon must not dispatch silently — and what is held back has
//    to be named, with a way to send it anyway.
//
// Assertions are on what was SUBMITTED and what the durable store holds, never on appearance: a
// task that was created and then filtered out of a column looks identical to one never created.
//
// Run against a vite dev server: `npx vite --port 1440` then `node dev/drive-dispatch-hygiene.mjs`.
import { webkit } from 'playwright'

const PORT = process.env.MOCK_PORT || 1440
let failed = 0
const ok = (label, pass, detail) => {
  if (!pass) failed++
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`)
}

const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 250)))
await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await p.waitForTimeout(3200)

const openBoard = async () => {
  await p.locator('button[aria-label="Add an agent on the roster"]').click()
  await p.waitForTimeout(800)
  await p.locator('[data-project-tab="board"]').click()
  await p.waitForTimeout(700)
}
const tasks = () => p.evaluate(() => {
  const ps = JSON.parse(localStorage.getItem('operator.projects') || '[]')
  return (ps.find((x) => x.name === 'operator')?.tasks ?? []).map((t) => t.text)
})
const submits = () => p.evaluate(() => window.__calls.filter((c) => c.fn === 'terminalWrite' && c.data.startsWith('[200~')).length)

// ── 1. A dispatch to a lane that does not exist creates NO task ────────────────────────
await openBoard()
const tasksBefore = await tasks()
await p.evaluate(() => window.__mockDispatch({
  id: 'ghost-1', terminalId: 't0', role: 'archaeology', task: 'code done: shipped the thing',
}))
await p.waitForTimeout(1200)
const tasksAfter = await tasks()
ok('a dispatch naming no lane mints NO durable task',
  tasksAfter.length === tasksBefore.length, { before: tasksBefore.length, after: tasksAfter.length })
ok('…and specifically not one carrying its text',
  !tasksAfter.includes('code done: shipped the thing'))

// It has to be somewhere, though — a delivery failure that vanishes is worse than one filed wrong.
const waitingCards = await p.evaluate(() => [...document.querySelectorAll('[data-waiting-card]')]
  .map((el) => el.textContent?.slice(0, 80)))
console.log('1 waiting cards:', JSON.stringify(waitingCards))
ok('it surfaces as a WAITING card instead',
  waitingCards.some((t) => t?.includes('code done: shipped the thing')), waitingCards.length)
await p.screenshot({ path: '/tmp/hygiene-1-waiting.png' })

// ── 2. The recovery path the backlog row used to provide ───────────────────────────────
// Removing a control must not strand the need behind it: the row could be assigned and sent, so
// the card has to offer the same. Route it to a real lane and assert a SUBMISSION happened.
const before2 = await submits()
const picker = p.locator('[data-route-dispatch]').first()
const hasPicker = (await picker.count()) > 0
ok('the card carries a lane picker (not a dead card)', hasPicker)
// Guarded: if the card regressed away, every check below is about a control that isn't there —
// that must read as FAILs on their own lines, not as one throw that hides them.
if (hasPicker) {
  await picker.selectOption('code')
  await p.waitForTimeout(1500)
}
const after2 = await submits()
ok('routing it to a real lane actually dispatches', after2 > before2, { before: before2, after: after2 })
// Routing it DOES create a record — that is the point: it is real work on a real lane now, and
// `addRunning` tracks it as running. What must never happen is the unrouted dispatch minting a
// QUEUED row nobody asked for, which step 1 already asserted at the only moment it could.
ok('routing tracks it as running work, not as a queued row',
  (await p.evaluate(() => {
    const ps = JSON.parse(localStorage.getItem('operator.projects') || '[]')
    const t = (ps.find((x) => x.name === 'operator')?.tasks ?? []).find((t) => t.text === 'code done: shipped the thing')
    return t?.status ?? null
  })) !== 'queued')

// ── 3. Dismiss closes the other one ────────────────────────────────────────────────────
await p.evaluate(() => window.__mockDispatch({
  id: 'ghost-2', terminalId: 't0', role: 'nobody', task: 'qa done: nothing to do',
}))
await p.waitForTimeout(1200)
const dismissable = await p.locator('[data-dismiss]').count()
ok('an unrouted card can be dismissed', dismissable > 0, { dismissable })
await p.locator('[data-dismiss]').first().click()
await p.waitForTimeout(900)
// Read the CARDS, not the page text: the toast that announced the dispatch also carries the
// task's text, so `body.innerText` would report a card that is gone as still present.
ok('dismissing removes it from Waiting',
  !(await p.evaluate(() => [...document.querySelectorAll('[data-waiting-card]')]
    .some((el) => el.textContent?.includes('qa done: nothing to do')))))

// ── 4. A STALE task does not dispatch silently ─────────────────────────────────────────
// `?stale=1` — a twelve-day-old queued task on the LIVE `code` lane. Staged in the mock rather
// than by writing localStorage here, because the mock re-seeds that key on every boot and a
// fixture the harness overwrites at load is a fixture that proves nothing.
await p.goto(`http://localhost:${PORT}/dev/mock.html?stale=1`, { waitUntil: 'load' })
await p.waitForTimeout(3200)
await openBoard()
const staleBadge = await p.evaluate(() => document.querySelector('[data-card-stale]')?.getAttribute('data-card-stale'))
ok('a twelve-day-old task LOOKS twelve days old before you press anything', staleBadge === '12', staleBadge)
const before4 = await submits()
await p.locator('[data-card-send]').first().click()
await p.waitForTimeout(1200)
ok('pressing Send does NOT dispatch it', (await submits()) === before4, { before: before4, after: await submits() })
const held = await p.evaluate(() => document.body.innerText.match(/Held — \d+ days old/)?.[0] ?? null)
ok('…it says so, with the age', !!held, held)
const status = await p.evaluate(() => {
  const ps = JSON.parse(localStorage.getItem('operator.projects') || '[]')
  return ps.find((x) => x.name === 'operator')?.tasks?.[0]?.status
})
// The ~200-stuck-in-running failure: a guard behind markTasksRunning marks work running and
// never delivers it. This one sits ahead of it.
ok('and it was NOT marked running', status === 'queued', { status })
await p.screenshot({ path: '/tmp/hygiene-2-stale.png' })

// ── 5. The override sends it ───────────────────────────────────────────────────────────
const before5 = await submits()
await p.locator('button', { hasText: 'Send anyway' }).first().click()
await p.waitForTimeout(1500)
ok('"Send anyway" dispatches the same task', (await submits()) > before5, { before: before5, after: await submits() })

await b.close()
console.log(failed ? `\n${failed} FAILED` : '\nall checks passed')
process.exit(failed ? 1 : 0)
