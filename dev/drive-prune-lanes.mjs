// Drive the ONE-TIME seeded-lane prune (lib/prune-seeded-lanes + DashboardView's hydrate
// effect): projects made before seeding was removed still carry six lanes nobody asked for, so
// the ones that were never launched and never edited are dropped once, with an Undo toast.
//
// What the unit tests can't reach is the WIRING — that the migration fires during hydrate at all,
// that it announces itself, that Undo puts the lanes back, and that the one-shot flag stops it
// running a second time (without which every "+ Add agent" would be undone at the next launch).
//
// Fixture: `?prune=` (dev/mock-bridge PRUNE_PROJECTS) — six lanes, one per verdict:
//   operator  stock, RETIRED charter, unused  → KEPT: the coordinator is the FLOOR. A project
//                                              the migration empties has no entry point left
//                                              (dev/briefs/operator-is-the-floor.md).
//   research  stock, unused                   → DROP
//   code      stock, but launched once        → keep
//   review    stock, but carries a done task  → keep
//   design    stock except a custom accent    → keep
//   perf      not a preset at all             → keep
// `?prune=1` clears the one-shot flag so the migration runs; any other value keeps it.
//
// Run against a vite dev server: `npx vite --port 1440` then `node dev/drive-prune-lanes.mjs`.
import { webkit } from 'playwright'
const PORT = process.env.MOCK_PORT || 1440
const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))
await p.addInitScript(() => { try { localStorage.removeItem('operator.activeProjectId') } catch { /* quota */ } })

const boot = async (query) => {
  await p.goto(`http://localhost:${PORT}/dev/mock.html?${query}`, { waitUntil: 'load' })
  await p.waitForTimeout(2600)
}
// Read the roster the app PERSISTED, not the one it rendered — the prune is a durable-store
// change, and a board that merely looks right over an unwritten store is the bug, not the proof.
const lanes = () => p.evaluate(() => {
  const raw = localStorage.getItem('operator.projects')
  return (JSON.parse(raw || '[]')[0]?.roster ?? []).map((r) => r.id)
})
const flagSet = () => p.evaluate(() => !!localStorage.getItem('operator.seededLanePrunedAt'))

// ---- 1. It fires on hydrate, and drops exactly the unused stock lanes ------------------
await boot('prune=1')
const after = await lanes()
console.log('1 lanes after prune:', JSON.stringify(after), '(expect operator, code, review, design, perf)')
console.log('1 dropped the unused stock lane:', !after.includes('research'))
console.log('1 NEVER leaves a project without its coordinator:', after.includes('operator'))
console.log('1 kept launched/tasked/edited/custom:', ['code', 'review', 'design', 'perf'].every((id) => after.includes(id)))

// ---- 2. It says so, and offers the way back -------------------------------------------
const banner = p.locator('text=/Tidied \\d+ unused lanes? from/').first()
console.log('2 toast shown:', await banner.count() > 0)
console.log('2 toast text:', JSON.stringify((await banner.textContent().catch(() => null))))
console.log('2 offers Undo:', await p.locator('button', { hasText: 'Undo' }).count() > 0)
await p.screenshot({ path: '/tmp/operator-shots/prune-toast.png' })

// ---- 3. Undo restores the pre-prune roster, and does NOT re-arm the migration ----------
await p.locator('button', { hasText: 'Undo' }).first().click()
await p.waitForTimeout(800)
const undone = await lanes()
console.log('3 lanes after Undo:', JSON.stringify(undone), '(expect all six back)')
console.log('3 restored:', undone.length === 6 && undone.includes('operator') && undone.includes('research'))
console.log('3 flag STAYS set — undo means keep them:', await flagSet())
await p.screenshot({ path: '/tmp/operator-shots/prune-undone.png' })

// ---- 4. The flag gates it: same fixture, flag already set, nothing is touched ----------
// The load-bearing case. The predicate cannot tell a leftover seeded lane from one the user
// just added back and hasn't launched yet, so if hydrate pruned unconditionally, "+ Add agent"
// would be silently undone at every launch.
await boot('prune=2')
const second = await lanes()
console.log('4 lanes on a flagged boot:', JSON.stringify(second), '(expect all six, untouched)')
console.log('4 did not run again:', second.length === 6)
console.log('4 no toast:', await p.locator('text=/Tidied \\d+ unused/').count() === 0)

await b.close()
