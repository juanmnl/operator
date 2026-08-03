// `Send →` MUST LEAVE YOU ON THE BOARD.
//
// This drives the REAL app (dev/mock.html + the mock bridge), not the standalone board preview,
// because the defect was never in the board: `dispatchToRole` in DashboardView called
// setActiveTerminalId/setActiveSessionId/setActiveProjectId on its live-lane branch — the same
// navigation used when you deliberately click a lane's chip to go TO it. So dispatching a task
// unmounted the board and dropped you in a terminal, and the one piece of feedback the board
// already had (the card moving Backlog → Running) happened somewhere you were no longer looking.
// QA's report: "board STILL visible immediately after Send →: false".
//
// The assertion IS the fix, so this exits non-zero when it regresses.
//
// It also covers the two things that must NOT change with it:
//   • the agent chip still navigates — that is its whole job, and it is a different code path
//     (`onOpenLane` → `focusTerminal`), so it has to be proven still wired rather than assumed;
//   • `Start all` also stays on the board (same shared implementation, and it would have yanked
//     you into whichever lane happened to be last in its loop).
//
// Run against a hand-started vite dev server:
//   npx vite --port 1438 --strictPort
//   node dev/drive-send-stays.mjs
import { webkit } from 'playwright'
import { mkdirSync } from 'node:fs'

const PORT = process.env.MOCK_PORT || 1438
const URL = `http://localhost:${PORT}/dev/mock.html`
const OUT = '/tmp/operator-shots/send-stays'
mkdirSync(OUT, { recursive: true })

const THEMES = [
  ['mission-control', 'dark'], ['mission-control', 'light'],
  ['mr-pink', 'dark'], ['mr-pink', 'light'],
  ['1984', 'dark'], ['1984', 'light'],
]

const fails = []
const notes = []
const TASK = 'Drive check — this task must land in Running while the board stays put'

/** Open the project and land on its Board tab. */
async function openBoard(p) {
  await p.goto(URL, { waitUntil: 'load' })
  await p.waitForTimeout(2600)
  await p.keyboard.press('Meta+Shift+O')      // project gallery
  await p.waitForTimeout(700)
  await p.locator('text=operator').first().click()
  await p.waitForTimeout(900)
  const board = p.locator('[data-board]')
  if (!(await board.count())) {
    // The project may have opened on another tab; the Board tab is the first one.
    await p.locator('[data-toolbar-header="project"] button', { hasText: /^BOARD$/i }).click()
    await p.waitForTimeout(500)
  }
  await p.waitForSelector('[data-board]', { timeout: 5000 })
}

/** Add a task through the board's own composer and assign it to a LIVE lane.
 *  Live matters: the live-lane branch is the one that navigated. Sending to an idle lane took a
 *  different path (`handleLaunchRole`), so testing that one would have passed against the bug. */
async function addTaskAssignedToCode(p, text) {
  await p.click('[data-board-add]')
  await p.waitForTimeout(250)
  const composer = p.locator('[data-board-composer]')
  await composer.locator('textarea').fill(text)
  // The assignee control is a native <select> laid transparently over the dot + name.
  await composer.locator('select').selectOption('code')
  await p.waitForTimeout(150)
  await p.click('[data-board-add-submit]')
  await p.waitForTimeout(500)
}

const cardColumn = (p, text) => p.evaluate((t) => {
  const card = [...document.querySelectorAll('[data-task-card]')]
    .find((c) => c.querySelector('[data-card-title]')?.textContent?.includes(t))
  if (!card) return null
  return card.closest('[data-board-column]')?.getAttribute('data-board-column') ?? 'detached'
}, text)

// Any unexpected throw is itself a failure and must still reach the report — the first time this
// driver caught the regression it crashed on the NEXT step (the board was gone, so nothing could
// be clicked) and exited before printing a single word about why.
async function phase(label, fn) {
  try { await fn() } catch (e) { fails.push(`${label} THREW — ${String(e).split('\n')[0]}`) }
}

// ---- 1. The fix, per palette (the board must survive a Send in every theme) -----------------
for (const [identity, mode] of THEMES) {
  const key = `${identity}-${mode}`
  const b = await webkit.launch()
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: mode })
  const p = await ctx.newPage()
  p.on('pageerror', (e) => fails.push(`${key} PAGEERROR ${String(e).slice(0, 200)}`))
  await phase(key, async () => {
  await p.addInitScript((t) => {
    const orig = Storage.prototype.clear
    Storage.prototype.clear = function () { orig.call(this); try { localStorage.setItem('operator.theme', t) } catch { /* quota */ } }
    try { localStorage.setItem('operator.theme', t) } catch { /* quota */ }
  }, key)

  await openBoard(p)
  await addTaskAssignedToCode(p, TASK)

  const before = await cardColumn(p, TASK)
  if (before !== 'backlog') fails.push(`${key} — new task landed in "${before}", expected backlog`)

  // THE SEND. Click the card's own Send →, then look immediately — no re-navigation, no reload.
  await p.evaluate((t) => {
    const card = [...document.querySelectorAll('[data-task-card]')]
      .find((c) => c.querySelector('[data-card-title]')?.textContent?.includes(t))
    card.querySelector('[data-card-send]').click()
  }, TASK)
  await p.waitForTimeout(600)

  // (a) THE ASSERTION. The board is still mounted and on screen.
  const boardVisible = await p.locator('[data-board]').isVisible().catch(() => false)
  if (!boardVisible) fails.push(`${key} — the board was UNMOUNTED by Send → (you were navigated away)`)

  // (b) …and the card moved, without anyone re-navigating to make it true.
  const after = await cardColumn(p, TASK)
  if (after !== 'running') fails.push(`${key} — after Send the card is in "${after}", expected running`)

  // (c) The terminal must NOT have taken over the view.
  const terminalTookOver = await p.locator('.xterm').isVisible().catch(() => false)
  if (terminalTookOver) fails.push(`${key} — a terminal is on screen after Send →`)

  notes.push(`${key}: board visible after send = ${boardVisible}, card ${before} → ${after}`)
  await p.screenshot({ path: `${OUT}/${key}-after-send.png` })
  })
  await b.close()
}

// ---- 2. What must NOT have changed with it (once, theme-independent) ------------------------
{
  const b = await webkit.launch()
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
  const p = await ctx.newPage()
  p.on('pageerror', (e) => fails.push(`invariants PAGEERROR ${String(e).slice(0, 200)}`))
  await phase('invariants', async () => {
  await openBoard(p)

  // The landing mark: the card that just arrived carries it, and only for a moment.
  await addTaskAssignedToCode(p, TASK)
  await p.evaluate((t) => {
    const card = [...document.querySelectorAll('[data-task-card]')]
      .find((c) => c.querySelector('[data-card-title]')?.textContent?.includes(t))
    card.querySelector('[data-card-send]').click()
  }, TASK)
  await p.waitForTimeout(300)
  const markedNow = await p.locator('[data-task-landed]').count()
  if (markedNow < 1) fails.push('the card that just landed in Running carries no landing mark')
  await p.waitForTimeout(1600)
  const markedLater = await p.locator('[data-task-landed]').count()
  if (markedLater !== 0) fails.push(`the landing mark did not clear (${markedLater} still marked after 1.9s)`)
  notes.push(`landing mark: ${markedNow} card marked at 0.3s, ${markedLater} at 1.9s`)

  // A just-landed card must show a real elapsed time. It read "—" because the board's 30s clock
  // was older than the `startedAt` the send had just stamped, so the elapsed came out negative —
  // harmless while nobody was present to see a card land, which is exactly what changed.
  const elapsed = await p.evaluate((t) => {
    const card = [...document.querySelectorAll('[data-task-card]')]
      .find((c) => c.querySelector('[data-card-title]')?.textContent?.includes(t))
    return card?.querySelector('[data-card-time]')?.textContent?.trim() ?? null
  }, TASK)
  notes.push(`elapsed on the just-landed card: "${elapsed}"`)
  if (!elapsed || !/^\d/.test(elapsed)) fails.push(`a just-landed card shows "${elapsed}" for elapsed, not a duration`)

  // A toast says WHERE it went — the case the card's own move cannot cover, since the board
  // stacks at narrow widths and Running can be below the fold.
  const toast = await p.locator('text=/Sent to Code/').count()
  if (!toast) fails.push('no toast naming the lane the task was sent to')
  notes.push(`toast naming the target lane: ${toast > 0}`)

  // START ALL stays on the board too — same shared implementation, and it dispatches to several
  // lanes, so navigating would have picked one arbitrarily.
  await addTaskAssignedToCode(p, 'Start-all check — must not navigate either')
  const startAll = await p.locator('[data-board-start-all]').count()
  if (startAll) {
    await p.click('[data-board-start-all]')
    await p.waitForTimeout(700)
    const stillThere = await p.locator('[data-board]').isVisible().catch(() => false)
    if (!stillThere) fails.push('the board was UNMOUNTED by Start all')
    notes.push(`board visible after Start all = ${stillThere}`)
  } else {
    notes.push('Start all not offered (no dispatchable queued task) — not exercised')
  }

  // THE CHIP MUST STILL NAVIGATE. Removing navigation from the send path must not have taken the
  // chip's with it: they are different code paths and they mean opposite things.
  await p.waitForTimeout(400)
  const chip = p.locator('[data-card-open-lane]').first()
  if (!(await chip.count())) {
    fails.push('no running card exposes its lane chip as a control — the route to the agent is gone')
  } else {
    await chip.click()
    await p.waitForTimeout(800)
    const boardGone = !(await p.locator('[data-board]').isVisible().catch(() => false))
    if (!boardGone) fails.push('clicking the agent chip did NOT navigate to the lane — the chip lost its job')
    notes.push(`agent chip still navigates away from the board = ${boardGone}`)
    await p.screenshot({ path: `${OUT}/chip-navigates.png` })
  }
  })
  await b.close()
}

// ---- Report --------------------------------------------------------------------------------
console.log('\nSEND → STAYS ON THE BOARD')
console.log('─'.repeat(78))
for (const n of notes) console.log(`  · ${n}`)
console.log(`\nShots → ${OUT}`)
if (fails.length) {
  console.log(`\n${fails.length} FAILURE(S)`)
  for (const f of fails) console.log(`  ✗ ${f}`)
  process.exit(1)
}
console.log('\nAll checks passed.')
