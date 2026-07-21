// Drive the OPERATOR-DISPATCH routing end-to-end through the real renderer:
// a dispatch to an IDLE lane must auto-launch it (new session row, no focus steal),
// a repeat of the same dispatch id must dedupe, and a dispatch to a LIVE lane must
// go through the submit queue (bracketed paste + watchdog CR nudge).
import { webkit } from 'playwright'
const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
p.on('pageerror', e => console.log('ERR', String(e).slice(0, 200)))
await p.goto('http://localhost:1429/dev/mock.html', { waitUntil: 'load' })
await p.waitForTimeout(2500)

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
await b.close()
