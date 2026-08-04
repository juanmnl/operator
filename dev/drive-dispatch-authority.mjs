// Drive the dispatch AUTHORITY gate (dev/briefs/harden-lane-dispatch-authority.md).
//
// The incident: Research was given a read-only brief, obeyed it literally ("it didn't change
// code"), then wrote an implementation brief and dispatched Code to build it — 348 lines of Rust
// against the user's durable store, unrequested. 23 of 100 dispatches in the real store came
// from non-coordinator lanes. Charter text is advisory; this is the enforcement.
//
// The assertion the brief calls catastrophic if wrong is at the bottom: HISTORICAL
// lane-originated dispatches sitting in projects.json must not re-deliver on hydrate.
//
// Run against a vite dev server: `npx vite --port 1440` then `node dev/drive-dispatch-authority.mjs`.
import { webkit } from 'playwright'

const PORT = process.env.MOCK_PORT || 1440
const b = await webkit.launch()
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: 'dark' })

// Seed the operator project's dispatch log: three HISTORICAL lane-originated records already
// marked delivered (exactly the shape of the real store's 23), plus two held ones.
await ctx.addInitScript(() => {
  let real
  Object.defineProperty(window, 'operator', {
    configurable: true,
    get: () => real,
    set: (v) => {
      real = v
      const orig = v.loadProjects
      v.loadProjects = async () => {
        const list = (await orig()) ?? []
        return list.map((p) => (p.name !== 'operator' ? p : {
          ...p,
          dispatches: [
            { id: 'hist-1', at: '2026-07-28T14:11:28.000Z', fromRoleId: 'research', toRoleId: 'code', task: 'HISTORICAL: scrollbar inset bug', outcome: 'sent' },
            { id: 'hist-2', at: '2026-07-28T14:15:28.000Z', fromRoleId: 'research', toRoleId: 'design', task: 'HISTORICAL: standardize settings pages', outcome: 'sent' },
            { id: 'hist-3', at: '2026-07-29T18:47:43.000Z', fromRoleId: 'research', toRoleId: 'code', task: 'HISTORICAL: implement the OPERATOR-REPLY sentinel', outcome: 'sent' },
            { id: 'hold-1', at: '2026-07-30T09:00:00.000Z', fromRoleId: 'research', toRoleId: 'code', task: 'HELD: build the thing I just specced', outcome: 'pending-approval' },
            { id: 'hold-2', at: '2026-07-30T09:01:00.000Z', fromRoleId: 'qa', toRoleId: 'design', task: 'HELD: restyle the failing screen', outcome: 'pending-approval' },
          ],
        }))
      }
      v.saveProjects = () => {}
    },
  })
})

const p = await ctx.newPage()
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 250)))

const writes = () => p.evaluate(() => window.__calls.filter((c) => c.fn === 'terminalWrite').length)
const spawns = () => p.evaluate(() => window.__calls.filter((c) => c.fn === 'terminalSpawn').length)
const outcomes = () => p.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('[data-dispatch-row]'))
  return Object.fromEntries(rows.map((r) => [
    r.getAttribute('data-dispatch-row'),
    r.querySelector('[data-dispatch-outcome]')?.textContent?.trim(),
  ]))
})
const writesFor = (needle) => p.evaluate((n) => window.__calls
  .filter((c) => c.fn === 'terminalWrite' && String(c.data ?? '').includes(n)).length, needle)

await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await p.waitForTimeout(3200)

// ---- 1. HISTORICAL records do not replay on hydrate ------------------------------------
// The catastrophic case: 23 lane-originated dispatches all firing at once on load.
const afterBootWrites = await writes()
const afterBootSpawns = await spawns()
console.log('1 writes attributable to historical dispatches:', await writesFor('HISTORICAL'), '(expect 0)')
console.log('1 spawns attributable to historical dispatches:', await writesFor('HISTORICAL') === 0 ? 0 : '?', `(boot writes=${afterBootWrites} spawns=${afterBootSpawns})`)
console.log('1 nothing auto-approved the HELD ones:', await writesFor('HELD'), '(expect 0)')

// ---- 2. The held ones are visible and actionable ---------------------------------------
await p.locator('[data-project-card], [data-rail-tile]').first().click().catch(() => {})
await p.waitForTimeout(600)
await p.locator('button[aria-label="Add an agent on the roster"]').click()
await p.waitForTimeout(900)
console.log('2 pending count in the header:', await p.evaluate(() =>
  document.querySelector('[data-dispatch-pending-count]')?.textContent?.trim()), '(expect "· 2 needs approval")')
console.log('2 outcomes as loaded:', JSON.stringify(await outcomes()))
console.log('2 approve/reject offered ONLY on the held rows:', await p.evaluate(() => ({
  approve: Array.from(document.querySelectorAll('[data-dispatch-approve]')).map((b) => b.getAttribute('data-dispatch-approve')),
  reject: Array.from(document.querySelectorAll('[data-dispatch-reject]')).map((b) => b.getAttribute('data-dispatch-reject')),
})))

// ---- 3. Approving delivers ONCE ---------------------------------------------------------
const before = await writes()
await p.locator('[data-dispatch-approve="hold-1"]').click()
await p.waitForTimeout(900)
console.log('3 approving delivered it:', (await writesFor('HELD: build the thing')) === 1, `(writes ${before} → ${await writes()})`)
console.log('3 outcome flipped off pending:', (await outcomes())['hold-1'], '(expect sent/launched)')
console.log('3 the approve button is gone — re-approval has nothing to find:',
  await p.locator('[data-dispatch-approve="hold-1"]').count(), '(expect 0)')

// ---- 4. Rejecting never delivers -------------------------------------------------------
await p.locator('[data-dispatch-reject="hold-2"]').click()
await p.waitForTimeout(700)
console.log('4 rejected outcome:', (await outcomes())['hold-2'], '(expect rejected)')
console.log('4 rejecting wrote nothing:', await writesFor('HELD: restyle'), '(expect 0)')
console.log('4 …and it can no longer be approved:', await p.locator('[data-dispatch-approve="hold-2"]').count(), '(expect 0)')

// ---- 5. LIVE enforcement: a non-coordinator dispatch is held, the coordinator's is not --
const w0 = await writes()
await p.evaluate(() => window.__mockDispatch({ id: 'live-research', terminalId: 't2', role: 'code', task: 'LIVEFROMRESEARCH do the work' }))
await p.waitForTimeout(900)
console.log('5 research → code was NOT delivered:', await writesFor('LIVEFROMRESEARCH'), '(expect 0)')
console.log('5 …and was recorded pending:', (await outcomes())['live-research'], '(expect needs approval)')

await p.evaluate(() => window.__mockDispatch({ id: 'live-operator', terminalId: 't0', role: 'code', task: 'LIVEFROMOPERATOR do the work' }))
await p.waitForTimeout(900)
console.log('5 operator → code WAS delivered, exactly as before:', await writesFor('LIVEFROMOPERATOR'), '(expect 1)')
console.log('5 …recorded as delivered, not held:', (await outcomes())['live-operator'], '(expect sent)')
console.log(`   (total writes ${w0} → ${await writes()})`)

await p.screenshot({ path: '/tmp/operator-shots/dispatch-authority.png' })
await b.close()
