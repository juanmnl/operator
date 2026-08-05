// ⌘B: IS IT A RELOAD, A REMOUNT, OR NEITHER? — and does agent order survive it?
// dev/briefs/2026-08-05-forget-and-sidebar-restart.md, bugs 2 and 3.
//
// The brief asks for evidence before a fix, and names three candidates: a renderer crash +
// WKWebView reload, a remount cascade that re-runs hydration, or neither. Each leaves a different
// fingerprint, so this measures all three at once rather than arguing from the code:
//
//   RELOAD     — an init script runs again. `window.__boot` counts page loads; >1 is a reload,
//                full stop, whatever caused it.
//   REHYDRATE  — `loadProjects` / `loadSessions` / `terminalList` are the hydrate path's IPC. A
//                remount cascade that re-runs hydration calls them again; a pure re-render does
//                not. This is the one that would make bugs 1–3 the same bug.
//   REORDER    — the rendered lane order, sampled before and after every toggle. An order that is
//                stable within a render but not across a rehydrate looks exactly like "agents
//                randomly move".
//
// Run: `./node_modules/.bin/vite --port <free> --strictPort` then
//      `MOCK_PORT=<free> node dev/drive-sidebar-toggle-stability.mjs`
import { webkit } from 'playwright'

const PORT = process.env.MOCK_PORT || 1440
const TOGGLES = Number(process.env.TOGGLES || 20)

const browser = await webkit.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })

const errors = []
await ctx.addInitScript(() => {
  // Runs on EVERY document load — so a second increment is proof of a reload.
  window.__boot = (window.__boot || 0) + 1
  window.__ipc = {}
  let real
  Object.defineProperty(window, 'operator', {
    configurable: true, get: () => real,
    set: (v) => {
      real = v
      for (const fn of ['loadProjects', 'loadSessions', 'terminalList', 'saveProjects', 'saveSessions']) {
        const orig = v[fn]?.bind(v)
        if (!orig) continue
        v[fn] = (...args) => { window.__ipc[fn] = (window.__ipc[fn] || 0) + 1; return orig(...args) }
      }
    },
  })
})

const p = await ctx.newPage()
p.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 160)))
p.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 160)) })
p.on('crash', () => errors.push('PAGE CRASHED'))

await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await p.waitForSelector('[data-rail]')
await p.waitForTimeout(2500)

// Expanded, so lane rows (and their roleIds) are rendered and comparable.
const collapsed = () => p.evaluate(() => !!document.querySelector('[data-rail][data-rail-collapsed]'))
if (await collapsed()) { await p.keyboard.press('Meta+b'); await p.waitForTimeout(700) }

/** The rendered agent order, in DOM order, BY SESSION ID.
 *
 *  `data-rail-orb` is the one hook that exists at both widths — collapsed it is on the disc,
 *  expanded it is on `SessionItem`'s disc, deliberately the same attribute so a driver compares
 *  one element across the toggle. Reading `data-lane-row` / `data-lane-orb` instead compares 4
 *  items against 3: an AD-HOC member has no roleId, so it has no lane hook, and the collapsed
 *  list silently drops it. That is a driver artifact that reads exactly like a reshuffle — which
 *  is worth writing down, because it is also how this bug could be misdiagnosed by hand. */
const order = () => p.evaluate(() => [...document.querySelectorAll('[data-rail-orb]')]
  .map((el) => el.getAttribute('data-rail-orb')))

const ipc = () => p.evaluate(() => ({ ...window.__ipc }))
const boots = () => p.evaluate(() => window.__boot)

const baseline = { order: await order(), ipc: await ipc(), boot: await boots() }
console.log(`baseline  boot:${baseline.boot}  ipc:${JSON.stringify(baseline.ipc)}`)
console.log(`          order: [${baseline.order.join(', ')}]`)

const orders = new Set([JSON.stringify(baseline.order)])
let sawReload = false
for (let i = 0; i < TOGGLES; i++) {
  await p.keyboard.press('Meta+b')
  await p.waitForTimeout(420)          // past the 260ms width transition + the 320ms settle
  const o = await order()
  orders.add(JSON.stringify(o))
  if ((await boots()) !== baseline.boot) { sawReload = true; break }
}

const after = { order: await order(), ipc: await ipc(), boot: await boots() }
console.log(`after ${TOGGLES}  boot:${after.boot}  ipc:${JSON.stringify(after.ipc)}`)
console.log(`          order: [${after.order.join(', ')}]`)

const out = []
const check = (ok, line) => { out.push(`${ok ? '  ok  ' : ' FAIL '} ${line}`); return ok }
let pass = true
pass = check(!sawReload && after.boot === baseline.boot,
  `B1 NO RELOAD — the init script ran ${after.boot}× (a reload would increment it)`) && pass
for (const fn of ['loadProjects', 'loadSessions']) {
  pass = check((after.ipc[fn] ?? 0) === (baseline.ipc[fn] ?? 0),
    `B2 NO REHYDRATE — ${fn} called ${after.ipc[fn] ?? 0}× total, unchanged by ${TOGGLES} toggles`) && pass
}
// `terminalList` is on a POLLING interval (the liveness reconcile), so it is expected to climb
// with wall-clock time whether or not anything is toggled. Compared against an idle control of
// the same duration rather than against zero — otherwise this reports the clock as a defect.
out.push(`        (terminalList ${baseline.ipc.terminalList ?? 0} → ${after.ipc.terminalList ?? 0}; polled, see the idle control below)`)
pass = check(orders.size === 1,
  `B3 ORDER STABLE across every toggle — ${orders.size} distinct order(s) seen`) && pass
pass = check(JSON.stringify(after.order) === JSON.stringify(baseline.order),
  `B3 and identical at the end — [${after.order.join(', ')}]`) && pass
pass = check(errors.length === 0, `B4 console clean — ${errors.length} error(s)`) && pass
for (const e of errors.slice(0, 6)) out.push(`        ${e}`)

// A RESTART would also lose the writes: if the app re-persisted projects/sessions on every
// toggle, that is its own defect even without a reload.
out.push(`        (saveProjects ${after.ipc.saveProjects ?? 0}× · saveSessions ${after.ipc.saveSessions ?? 0}× over ${TOGGLES} toggles)`)

// THE IDLE CONTROL: sit for the same wall-clock time touching nothing. Whatever `terminalList`
// does here is the clock, not the toggle.
const idleStart = await ipc()
await p.waitForTimeout(420 * TOGGLES)
const idleEnd = await ipc()
const polled = (idleEnd.terminalList ?? 0) - (idleStart.terminalList ?? 0)
const toggled = (after.ipc.terminalList ?? 0) - (baseline.ipc.terminalList ?? 0)
out.push(`        idle control: terminalList +${polled} over the same duration, vs +${toggled} while toggling`)
pass = check(toggled <= polled + 1,
  `B2 terminalList is the POLLER, not the toggle — +${toggled} toggling vs +${polled} idle`) && pass
pass = check(JSON.stringify(await order()) === JSON.stringify(baseline.order),
  `B3 order still identical after the idle period too`) && pass

console.log('\n' + out.join('\n'))
console.log(pass ? '\nSIDEBAR TOGGLE: stable' : '\nSIDEBAR TOGGLE: FAILED')
await browser.close()
process.exit(pass ? 0 : 1)
