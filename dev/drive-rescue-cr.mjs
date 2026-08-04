// THE RESCUE CR MUST NOT SUBMIT WHAT A HUMAN IS TYPING (2026-08-03, HIGH).
//
// Reported as: "i'm writing a message on the input on any agent, and when a message is
// dispatched from any other lane, it sends my message with it, half baked, incomplete."
//
// Every submission arms a bare CR for its terminal — the rescue for a draft whose CR the TUI
// swallowed. The user's keystrokes go into that same TUI composer, and the CR cannot tell a
// stranded dispatch from a person mid-sentence, so it submits whatever is there. On an
// observed terminal the window is RESCUE_AFTER_MS = 30s.
//
// The unit tests in submit-queue.test.ts prove the QUEUE's contract. They cannot prove the
// thing that was actually missing, which is that anything calls `cancelNudge` when the user
// types — that lives in TerminalPane's key handler. This driver is the only proof of the
// wiring, so it types into a real xterm and watches the real write log.
//
// Slow on purpose: it waits out the full 30s horizon twice. There is no way to observe "the CR
// did not fire" faster than the deadline it would have fired at.
//
// Run against a vite dev server: `npx vite --port 1440` then `node dev/drive-rescue-cr.mjs`.
import { webkit } from 'playwright'

const PORT = process.env.MOCK_PORT || 1440
const HORIZON_MS = 30_000            // RESCUE_AFTER_MS
const SETTLE_MS = 6_000              // + the confirmation window and slack

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

// Focus a live lane and put the Console up — that is where a human types into the pty.
await p.locator('[data-session-row="s-code"]').click()
await p.waitForTimeout(1200)
const termId = await p.evaluate(() => {
  const t = JSON.parse(localStorage.getItem('operator.terminals') || '[]')
  return Array.isArray(t) && t.length ? t : null
})
console.log('terminals in localStorage:', JSON.stringify(termId)?.slice(0, 120))

/** Bare-CR writes ('\r' alone) are the rescue. A submission is the bracketed paste. */
const writeLog = () => p.evaluate(() => window.__calls
  .filter((c) => c.fn === 'terminalWrite')
  .map((c) => ({ id: c.id, kind: c.data === '\r' ? 'RESCUE-CR' : (c.data.startsWith('[200~') ? 'submit' : 'keys'), at: c.at })))

/** Submit into the FOCUSED lane's pty through the app's own queue, the way a dispatch does. */
let dispatchN = 0
const dispatchToFocusedLane = async (text) => p.evaluate(([t, n]) => {
  // `__mockDispatch` routes through DashboardView exactly as a real OPERATOR-DISPATCH does;
  // its target is resolved from the roster, so this is the real submit path, not a stub.
  // Source is the coordinator's terminal (t0), target the `code` lane — a dispatch from
  // ANOTHER lane, which is how the report described it.
  window.__mockDispatch({ id: `rescue-${n}`, terminalId: 't0', role: 'code', task: t })
}, [text, ++dispatchN])

// ── 1. CONTROL: nobody types → the rescue CR must still fire ────────────────────────────
// Without this the test below proves nothing: "no CR" is also what a broken submit path looks
// like. The rescue exists and must keep existing.
const before1 = (await writeLog()).length
await dispatchToFocusedLane('control: nobody is typing')
await p.waitForTimeout(2000)
const submitted1 = (await writeLog()).slice(before1).some((w) => w.kind === 'submit')
console.log('1 dispatch submitted:', submitted1)
await p.waitForTimeout(HORIZON_MS + SETTLE_MS)
const after1 = (await writeLog()).slice(before1)
ok('CONTROL: with nobody typing, the rescue CR fires',
  after1.some((w) => w.kind === 'RESCUE-CR'), after1.map((w) => w.kind))

// ── 2. THE BUG: the user types during the window → the CR must NOT fire ─────────────────
const before2 = (await writeLog()).length
await dispatchToFocusedLane('the dispatch that arms the rescue')
await p.waitForTimeout(1500)
// A human, mid-sentence, in the SAME lane. Real key events — that is the whole point: the
// disarm hangs off the key handler, not off `term.onData` (which xterm also fires for cursor
// reports and for the focus in/out reports `ESC[I`/`ESC[O`, i.e. not user input at all).
await p.locator('.xterm-helper-textarea').first().focus()
await p.keyboard.type('half a sentence that must never be sent', { delay: 25 })
const typed = (await writeLog()).slice(before2).filter((w) => w.kind === 'keys').length
console.log('2 keystrokes reached the pty:', typed)
await p.waitForTimeout(HORIZON_MS + SETTLE_MS)
const after2 = (await writeLog()).slice(before2)
ok('a keystroke in the lane disarms its rescue CR',
  typed > 0 && !after2.some((w) => w.kind === 'RESCUE-CR'), after2.filter((w) => w.kind !== 'keys').map((w) => w.kind))

// ── 3. CROSS-LANE: typing in one lane must not disarm another ───────────────────────────
// Queues are per terminal, so this should hold structurally — assert it anyway, because the
// report said "dispatched from any other lane" and a shared disarm would be a silent
// regression that only shows up as lost dispatches.
const before3 = (await writeLog()).length
await dispatchToFocusedLane('lane A, armed')
await p.waitForTimeout(1200)
const laneA = (await writeLog()).slice(before3).find((w) => w.kind === 'submit')?.id
// Type into a DIFFERENT lane's terminal.
await p.locator('[data-session-row="s-res"]').click()
await p.waitForTimeout(1200)
await p.locator('.xterm-helper-textarea').first().focus()
await p.keyboard.type('typing in lane B', { delay: 25 })
await p.waitForTimeout(HORIZON_MS + SETTLE_MS)
const after3 = (await writeLog()).slice(before3)
ok('typing in lane B leaves lane A\'s rescue armed',
  !!laneA && after3.some((w) => w.kind === 'RESCUE-CR' && w.id === laneA),
  { laneA, crs: after3.filter((w) => w.kind === 'RESCUE-CR').map((w) => w.id) })

await b.close()
console.log(failed ? `\n${failed} FAILED` : '\nall checks passed')
process.exit(failed ? 1 : 0)
