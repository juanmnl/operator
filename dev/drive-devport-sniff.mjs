// Prove the dev-server port sniff reaches the backend.
//
// This is the path that replaced the per-pid `lsof` walk (which fired a macOS TCC prompt
// per inspected process). It matters that this is a DRIVER and not a unit test: the sniff
// itself was already unit-tested and already correct, but nothing passed
// `onDevServerDetected` to TerminalPane, so the callback was null and the detector
// returned on its first line — built, tested, and wired to nothing. A test of
// detectDevServerPort would have stayed green through the whole outage.
//
// Run: `npx vite --port 1440` then `node dev/drive-devport-sniff.mjs`.
import { webkit } from 'playwright'
const PORT = process.env.MOCK_PORT || 1440
const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))
await p.addInitScript(() => { try { localStorage.removeItem('operator.activeProjectId') } catch { /* quota */ } })
await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await p.waitForTimeout(2600)

let failed = 0
const ok = (label, pass, detail) => {
  if (!pass) failed++
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`)
}

// The harness must actually expose the recorder, or every check below is vacuous.
ok('the mock records noteSessionPort at all',
  await p.evaluate(() => Array.isArray(window.__notedPorts)))

// Push a dev-server banner through a real pty stream, exactly as Claude prints it
// (its own prose — subprocess output gets collapsed into "+5 lines" and never streams).
const noted = async () => p.evaluate(() => (window.__notedPorts || []).map(([id, port]) => `${id}:${port}`))
const before = await noted()
await p.evaluate(() => window.__mockTerminalData?.('t1', 'Dev server is running: http://localhost:5273/\r\n'))
await p.waitForTimeout(900)
const after = await noted()
const fresh = after.filter((x) => !before.includes(x))
ok('a banner in the pty stream reaches the backend as a noted port', fresh.includes('t1:5273'), { before, after })

// Attribution: the port must be filed under the terminal that PRINTED it. Filing a
// banner under the wrong lane is how a sibling's server gets shown as this session's app,
// which is the exact failure the old process-tree walk existed to prevent.
await p.evaluate(() => window.__mockTerminalData?.('t2', 'Local:   http://127.0.0.1:4321/\r\n'))
await p.waitForTimeout(900)
const all = await noted()
ok('a second lane\'s banner is filed under THAT lane', all.includes('t2:4321'), all)
ok('and it did not leak onto the first lane', !all.includes('t1:4321'), all)

// A repeated banner (dev server reloads and reprints) must not spam the backend.
const n1 = (await noted()).length
await p.evaluate(() => window.__mockTerminalData?.('t1', 'Dev server is running: http://localhost:5273/\r\n'))
await p.waitForTimeout(700)
ok('a repeated banner for the same port is deduped', (await noted()).length === n1, { was: n1, now: (await noted()).length })

await b.close()
console.log(failed ? `\n${failed} FAILED` : '\nsniff → backend hop verified')
process.exit(failed ? 1 : 0)
