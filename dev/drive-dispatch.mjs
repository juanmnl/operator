// Drive the OPERATOR-DISPATCH routing end-to-end through the real renderer:
// a dispatch to an IDLE lane must auto-launch it (new session row, no focus steal),
// a repeat of the same dispatch id must dedupe, and a dispatch to a LIVE lane must
// go through the submit queue (bracketed paste + watchdog CR nudge).
import { webkit } from 'playwright'
const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
p.on('pageerror', e => console.log('ERR', String(e).slice(0, 200)))
// Port: this repo's harnesses run on 1440 (don't default from process.env.PORT — the
// app's own shell exports PORT).
await p.goto(`http://localhost:${process.env.MOCK_PORT || 1440}/dev/mock.html`, { waitUntil: 'load' })
await p.waitForTimeout(3000)

const rows = () => p.evaluate(() =>
  Array.from(document.querySelectorAll('[data-session-row]')).map(el => el.getAttribute('data-session-row')))
const calls = (fn) => p.evaluate((f) => window.__calls.filter(c => c.fn === f), fn)

console.log('rows before:', JSON.stringify(await rows()))

// 1. Dispatch to the IDLE design lane → auto-launch.
await p.evaluate(() => window.__mockDispatch({ id: 'd-test-1', sessionId: 's-op', terminalId: 't0', role: 'design', task: 'Polish the empty state' }))
await p.waitForTimeout(1200)
console.log('rows after idle-dispatch:', JSON.stringify(await rows()))
const spawns = await calls('terminalSpawn')
console.log('spawns:', spawns.length, '| prompt carries task:', JSON.stringify(spawns[0]?.opts?.initialPrompt ?? '').includes('Polish the empty state'))
await p.screenshot({ path: '/tmp/dispatch-autolaunch.png' })

// 2. Same dispatch id again → dedupe, no second spawn.
await p.evaluate(() => window.__mockDispatch({ id: 'd-test-1', sessionId: 's-op', terminalId: 't0', role: 'design', task: 'Polish the empty state' }))
await p.waitForTimeout(800)
console.log('spawns after dupe:', (await calls('terminalSpawn')).length)

// 3. Dispatch to the LIVE code lane → typed into its pty via the submit queue.
await p.evaluate(() => window.__mockDispatch({ id: 'd-test-2', sessionId: 's-op', terminalId: 't0', role: 'code', task: 'Add a regression test' }))
await p.waitForTimeout(1500) // submit + 800ms nudge window
const writes = (await calls('terminalWrite')).filter(w => w.id === 't1')
console.log('t1 writes:', JSON.stringify(writes.map(w => w.data)))

// 4. LENGTH SWEEP — the P0 in dev/briefs/submit-queue-long-message-split.md. A long dispatch
// was arriving as one truncated turn plus a stranded tail, because the watchdog CR fired on a
// FIXED 800ms timer that had been tuned on short strings. What the harness can see is the
// emitted timeline: exactly one paste + one CR per dispatch, and a nudge delay that GROWS with
// the message (the split itself lives inside Claude Code's TUI — see the unit test's model).
const nudgeDelay = async (chars) => {
  const before = (await calls('terminalWrite')).length
  await p.evaluate((n) => window.__mockDispatch({
    id: `d-len-${n}`, sessionId: 's-op', terminalId: 't0', role: 'code', task: 'L'.repeat(n),
  }), chars)
  // Wait past the scaled nudge: floor 800 + 1.5ms/char, capped at 6s.
  await p.waitForTimeout(Math.min(6000, 800 + chars * 1.5) + 900)
  const fresh = (await calls('terminalWrite')).slice(before).filter((w) => w.id === 't1')
  const paste = fresh.find((w) => w.data.startsWith('\x1b[200~'))
  const nudge = fresh.find((w) => w.data === '\r')
  return { chars, pastes: fresh.filter((w) => w.data.startsWith('\x1b[200~')).length, nudges: fresh.filter((w) => w.data === '\r').length,
           delay: paste && nudge ? nudge.at - paste.at : null,
           // The message must go out INTACT in one paste — the bug shipped half of it.
           whole: !!paste && paste.data.includes('L'.repeat(chars)) }
}
console.log('\nlength sweep — one paste + one nudge each, nudge delay scaling with length:')
for (const n of [200, 500, 1000, 2000, 4000]) {
  const r = await nudgeDelay(n)
  console.log(`  ${String(n).padStart(5)} chars  pastes ${r.pastes}  nudges ${r.nudges}  whole-message ${r.whole}  nudge@ ${r.delay}ms`)
}
await b.close()
