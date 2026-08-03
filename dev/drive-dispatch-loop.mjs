// Drive the CLOSED LOOP on dispatch delivery.
//
// The split (dev/briefs/submit-queue-long-message-split.md) was fought twice with a timer: space
// the writes, then scale the watchdog CR with message length. Both are open-loop — they estimate
// how long Claude Code's TUI needs to commit a paste, and both ways of being wrong have shipped
// as bugs. This is the third and last version: watch the transcript for the turn the message
// became, fire the rescue CR only when it didn't, and report a message that never arrived.
//
// What the UNIT tests own (submit-queue.test.ts, delivery-confirm.test.ts): the race itself,
// against a model of the TUI, and every matching rule. What only the harness can show is the
// WIRING — that a real session update reaches the queue, that the rescue is actually skipped in
// the running app, and that a lost dispatch turns into a visible outcome rather than silence.
//
// Run against a vite dev server: `npx vite --port 1440` then `node dev/drive-dispatch-loop.mjs`.
import { webkit } from 'playwright'
const PORT = process.env.MOCK_PORT || 1440
const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))
await p.addInitScript(() => { try { localStorage.removeItem('operator.activeProjectId') } catch { /* quota */ } })
await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await p.waitForTimeout(3000)

/** Writes to the live Code lane's pty (t1), newest last. */
const writes = () => p.evaluate(() => window.__calls.filter((c) => c.fn === 'terminalWrite' && c.id === 't1'))
const kinds = (ws) => ws.map((w) => (w.data === '\r' ? 'CR' : w.data.startsWith('[200~') ? 'paste' : 'other'))
const dispatch = (id, task) => p.evaluate(([i, t]) => window.__mockDispatch(
  { id: i, sessionId: 's-op', terminalId: 't0', role: 'code', task: t },
), [id, task])
/** What the transcript records when a prompt actually commits (transcript.rs apply_user). */
const commit = (text) => p.evaluate((t) => window.__mockUserTurn('s-code', t), text)
const outcomes = () => p.evaluate(() => (JSON.parse(localStorage.getItem('operator.projects') || '[]')
  .flatMap((x) => x.dispatches ?? [])).map((d) => `${d.task.slice(0, 18)}=${d.outcome}`))

// ---- 1. CONFIRMED: the rescue CR is never sent ----------------------------------------
// The CR is a keystroke, and a keystroke landing on an already-committed paste is exactly what
// halved a long dispatch. Once the turn is observed there is nothing left to rescue.
const task1 = 'C'.repeat(900)
const before1 = (await writes()).length
await dispatch('loop-1', task1)
await p.waitForTimeout(400)          // paste is out; the watchdog is armed but has not fired
await commit(task1)                  // …the transcript records the turn first
await p.waitForTimeout(2600)         // past nudgeDelayFor(900) = 800 + 1350
const after1 = kinds((await writes()).slice(before1))
console.log('1 writes for a CONFIRMED 900-char dispatch:', JSON.stringify(after1))
console.log('1 paste sent, rescue CR skipped:', after1.includes('paste') && !after1.includes('CR'))

// ---- 2. UNCONFIRMED: the rescue still fires -------------------------------------------
// The stranded-draft rescue is why the nudge exists at all; closing the loop must not remove it.
// It is now 30s away rather than 1.1s — the trade the loop buys, since being late costs nothing
// and being early is what corrupts. These waits are long on purpose; that IS the change.
const before2 = (await writes()).length
await dispatch('loop-2', 'Add a regression test')
await p.waitForTimeout(32_000)
const after2 = kinds((await writes()).slice(before2))
console.log('2 writes for an UNCONFIRMED dispatch:', JSON.stringify(after2))
console.log('2 rescue CR still fires:', after2.includes('CR'))

// ---- 3. …and only ONCE, then it is reported --------------------------------------------
// Every extra keystroke is another chance to split something, so there is no second CR. After
// the confirmation window the dispatch stops claiming to have been delivered.
await p.waitForTimeout(5000)         // CONFIRM_WINDOW_MS + slack
const after3 = kinds((await writes()).slice(before2))
console.log('3 total CRs for that dispatch:', after3.filter((k) => k === 'CR').length, '(expect 1)')
console.log('3 dispatch outcomes:', JSON.stringify(await outcomes()))
const toast = p.locator('text=/never started the task it was sent/').first()
console.log('3 toast shown:', await toast.count() > 0)
console.log('3 toast text:', JSON.stringify(await toast.textContent().catch(() => null)))
await p.screenshot({ path: '/tmp/operator-shots/dispatch-undelivered.png' })

// ---- 4. The channel says so, instead of showing it delivered ---------------------------
// The log used to read `sent` forever — which is how a task could sit unsent in a composer for
// an hour while the UI showed it delivered.
await p.locator('[data-rail-gallery]').click()
await p.waitForTimeout(700)
await p.locator('[data-project-card]').filter({ hasText: 'operator' }).first().click()
await p.waitForTimeout(900)
// Was the channel feed's chips; that surface is deleted and the dispatch log on Team is where
// an outcome is legible now.
await p.locator('[data-toolbar-header="project"] button', { hasText: 'Team' }).click()
await p.waitForTimeout(900)
await p.locator('button', { hasText: /Dispatches · \d+/ }).first().click().catch(() => {})
await p.waitForTimeout(500)
console.log('4 dispatch-log outcomes:', JSON.stringify(await p.evaluate(() =>
  Array.from(document.querySelectorAll('[data-dispatch-outcome]')).map((e) => e.getAttribute('title') || e.textContent?.trim()))))
await p.screenshot({ path: '/tmp/operator-shots/dispatch-loop-log.png' })

// ---- 5. A SPLIT is not a delivery -------------------------------------------------------
// The failure mode itself: a turn carrying only the front of the message. Confirming on that
// would report the broken half as a success and leave the tail stranded, exactly as before.
const task5 = 'Rework the dispatch router and then report back with what you found'
const before5 = (await writes()).length
await dispatch('loop-5', task5)
await p.waitForTimeout(400)
await commit('Rework the dispatch router')   // the prefix only — the reported artifact
await p.waitForTimeout(32_000)
const after5 = kinds((await writes()).slice(before5))
console.log('5 writes when only a PREFIX was recorded:', JSON.stringify(after5))
console.log('5 a split does NOT confirm — rescue still fires:', after5.includes('CR'))

await b.close()
