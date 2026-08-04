// A DISPATCH MUST NOT BE TYPED INTO A PTY WHOSE CHILD IS DEAD (2026-08-04).
//
// What happened: three dispatches were sent to the `code` lane whose `claude` had exited five
// hours earlier. Two were filed as `status: running` against its dead terminal id; zero were
// delivered; nothing raised an error. The board then asserted work was running that was not.
//
// Why the app could not tell: `terminal_list` reported which ptys EXIST, and the bridge
// hardcoded `alive: true` on every row, so nothing ever asked whether a child was running.
// `TerminalTab.ended` was therefore sourced only from the `terminal:exit` event — and this
// renderer misses events, because WebKit kills and respawns WebContent under memory pressure
// (measured: 737MB resting on a project with eight mounted terminals). `routeDispatch` keys off
// `ended`, so a stale flag routes a dispatch into a corpse.
//
// terminal-liveness.test.ts proves the RULE. It cannot prove the thing that was missing, which
// is that anything calls it — the same gap that let the rescue-CR bug survive a green suite.
// This driver is the only proof of the wiring: it boots with a lane whose child is dead, waits
// for the reconcile, and watches the real dispatch path choose launch over send.
//
// Run: `npx vite --port 1441 --strictPort` then `MOCK_PORT=1441 node dev/drive-terminal-liveness.mjs`
import { webkit } from 'playwright'

const PORT = process.env.MOCK_PORT || 1441
const DEAD = 't1'          // the `code` lane (session s-code)
const RECONCILE_MS = 5000  // DashboardView's reconcile interval
const SETTLE_MS = 2500

let failed = 0
const ok = (label, pass, detail) => {
  if (!pass) failed++
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`)
}

const boot = async (b, query) => {
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
  p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))
  await p.goto(`http://localhost:${PORT}/dev/mock.html${query}`, { waitUntil: 'load' })
  await p.waitForTimeout(3000)
  return p
}

/** Writes the app made into a pty. A dispatch that SENDS is a bracketed paste. */
const submitsTo = (p, id) => p.evaluate((tid) => window.__calls
  .filter((c) => c.fn === 'terminalWrite' && c.id === tid && String(c.data).startsWith('[200~')).length, id)

const spawns = (p) => p.evaluate(() => window.__calls.filter((c) => c.fn === 'terminalSpawn').length)

/** The real OPERATOR-DISPATCH path through DashboardView — roster resolution and all. */
const dispatch = (p, n) => p.evaluate((i) => {
  window.__mockDispatch({ id: `live-${i}`, terminalId: 't0', role: 'code', task: `task number ${i}` })
}, n)

const b = await webkit.launch()

// ── 1. CONTROL: the lane is alive → the dispatch is typed into it ───────────────────────────
// Without this, "no write" below proves nothing: it is also what a broken dispatch path looks
// like. Sending to a live lane must keep working.
{
  const p = await boot(b, '')
  const before = await submitsTo(p, DEAD)
  await dispatch(p, 1)
  await p.waitForTimeout(SETTLE_MS)
  const after = await submitsTo(p, DEAD)
  ok('CONTROL: a live lane still receives the dispatch', after > before, { before, after })
  await p.close()
}

// ── 2. The child is dead → nothing is typed into it, and a launch happens instead ───────────
{
  const p = await boot(b, `?deadLane=${DEAD}`)
  // The reconcile runs on mount and every 5s; wait past one full tick.
  await p.waitForTimeout(RECONCILE_MS + SETTLE_MS)

  const endedNow = await p.evaluate((tid) => {
    // The lane's row carries its ended state in the DOM; fall back to the pane overlay.
    const row = document.querySelector(`[data-session-row="s-code"]`)
    return { rowFound: !!row, deadMarked: !!document.querySelector(`[data-terminal-ended="${tid}"], [data-session-ended="s-code"]`) }
  }, DEAD)

  const beforeWrites = await submitsTo(p, DEAD)
  const beforeSpawns = await spawns(p)
  await dispatch(p, 2)
  await p.waitForTimeout(SETTLE_MS)
  const afterWrites = await submitsTo(p, DEAD)
  const afterSpawns = await spawns(p)

  ok('a dead lane is NOT typed into', afterWrites === beforeWrites, { beforeWrites, afterWrites })
  ok('…and the dispatch launches a fresh session instead', afterSpawns > beforeSpawns, { beforeSpawns, afterSpawns })
  console.log('   (ended markers seen:', JSON.stringify(endedNow), ')')
  await p.close()
}

await b.close()
console.log(failed ? `\n${failed} FAILED` : '\nall checks passed')
process.exit(failed ? 1 : 0)
