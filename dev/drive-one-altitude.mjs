// ONE ALTITUDE — model, effort and worktree are set on the lane, and nowhere else.
//
// The global per-role tier (`~/.operator/role-defaults.json`, edited on Agents → Defaults) is
// deleted. Deleting a tier is only safe if nothing that resolved THROUGH it changes answer, so
// this drives the migration against the real legacy store and asserts the thing that actually
// matters: what reaches `terminalSpawn` / `worktreeCreate` is unchanged.
//
// `?worktree=1` loads role-defaults.json verbatim as it stood before the operator/research flip:
//
//     code:true  design:true  operator:FALSE  qa:false  research:FALSE  review:false
//
// The presets now carry the posture, and they say operator and research isolate. So those two
// lanes are exactly where the collapse would have silently changed behaviour — the migration has
// to pin `false` onto them, and a lane launched from that store must still NOT get a worktree.
//
// Exits 1 on any failed assertion.
//
// Run against a vite dev server: `npx vite --port 1441` then `node dev/drive-one-altitude.mjs`.
import { webkit } from 'playwright'
const PORT = process.env.MOCK_PORT || 1441

let failed = 0
const ok = (label, pass, detail) => {
  if (!pass) failed++
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`)
}

const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
p.on('pageerror', (e) => { console.log('ERR', String(e).slice(0, 200)); failed++ })
await p.addInitScript(() => { try { localStorage.removeItem('operator.activeProjectId') } catch { /* quota */ } })
await p.goto(`http://localhost:${PORT}/dev/mock.html?worktree=1`, { waitUntil: 'load' })
await p.waitForTimeout(3200)

const roster = (name) => p.evaluate((n) => (JSON.parse(localStorage.getItem('operator.projects') || '[]')
  .find((x) => x.name === n)?.roster ?? []).map((r) => [r.id, r.useWorktree ?? null, r.model ?? null]), name)
const calls = (fn) => p.evaluate((f) => window.__calls.filter((c) => c.fn === f).length, fn)

// ---- 1. The migration ran, and wrote the legacy answer down as pins ---------------------
ok('the one-shot stamp is recorded, so this never runs twice',
  !!(await p.evaluate(() => localStorage.getItem('operator.oneAltitudeMigratedAt'))))

const after = await roster('operator')
console.log('   roster after migration [id, useWorktree, model]:', JSON.stringify(after))
const wt = Object.fromEntries(after.map(([id, w]) => [id, w]))
ok('operator was pinned OFF — its preset says isolate, the legacy store said do not', wt.operator === false)
ok('research was pinned OFF for the same reason', wt.research === false)
ok('code was NOT pinned — legacy and preset already agree (minimal by construction)', wt.code === null || wt.code === true)

// ---- 2. THE POINT: a lane launched from that store still does not get a worktree ---------
// operator is live in the fixture, so drive an idle one. Whichever lane we pick, the assertion
// is the same shape: what the OLD cascade said, the launch still does.
await p.locator('[data-rail-gallery]').click()
await p.waitForTimeout(800)
await p.locator('[data-project-card]').filter({ hasText: 'uwazi_app' }).first().click()
await p.waitForTimeout(900)
await p.locator('button[aria-label="Open the roster"]').click()
await p.waitForTimeout(900)
// "Open the roster" lands on the BOARD since it became project home; the roster is one tab
// across. Without this step every read below comes back empty — the same break QA found in
// drive-roster.mjs, and for the same reason: the move that displaced the roster landed after
// the move that last ran this.
await p.locator('[data-toolbar-header="project"] button', { hasText: /^Team$/ }).click().catch(() => {})
await p.waitForTimeout(700)

const rows = await p.evaluate(() =>
  Array.from(document.querySelectorAll('[data-roster-row]')).map((r) => r.getAttribute('data-roster-row')))
console.log('   idle lanes in uwazi_app:', JSON.stringify(rows))
const target = rows.includes('operator') ? 'operator' : rows[0]
const uwaziWt = Object.fromEntries((await roster('uwazi_app')).map(([id, w]) => [id, w]))
const beforeWt = await calls('worktreeCreate')
await p.locator(`[data-roster-row="${target}"] button`, { hasText: 'Launch' }).last().click()
await p.waitForTimeout(1800)
const madeWorktree = (await calls('worktreeCreate')) > beforeWt
// The legacy store said operator does NOT isolate; the new preset says it does. The migration
// pinned `false`, so the launch must still create no worktree. This is the single assertion the
// whole migration exists for — if the pin were missing, this flips to true.
ok(`launching ${target} creates NO worktree, exactly as before the collapse`,
  uwaziWt[target] === false && madeWorktree === false,
  { lane: target, pinnedUseWorktree: uwaziWt[target] ?? null, worktreeCreated: madeWorktree })

// ---- 3. The Defaults screen is gone, and nothing links to it ----------------------------
await p.locator('[data-rail-agents]').click()
await p.waitForTimeout(900)
const tabs = await p.evaluate(() =>
  Array.from(document.querySelectorAll('[data-page-tab]')).map((t) => t.getAttribute('data-page-tab')))
ok('the Agents hub no longer offers a Defaults tab', !tabs.includes('defaults'), tabs)

// ---- 4. The roster card still shows pinned vs inherited, with no "inherited from" ---------
await p.locator('[data-rail-gallery]').click()
await p.waitForTimeout(800)
await p.locator('[data-project-card]').filter({ hasText: 'operator' }).first().click()
await p.waitForTimeout(900)
await p.locator('button[aria-label="Open the roster"]').click()
await p.waitForTimeout(900)
// "Open the roster" lands on the BOARD since it became project home; the roster is one tab
// across. Without this step every read below comes back empty — the same break QA found in
// drive-roster.mjs, and for the same reason: the move that displaced the roster landed after
// the move that last ran this.
await p.locator('[data-toolbar-header="project"] button', { hasText: /^Team$/ }).click().catch(() => {})
await p.waitForTimeout(700)

const titles = await p.evaluate(() =>
  Array.from(document.querySelectorAll('[data-segment][aria-checked="true"]')).map((e) => e.getAttribute('title')))
ok('a selected option explains itself as pinned-here or from-the-preset', titles.length > 0, titles.slice(0, 2))
ok('no control claims a value is "inherited from" a layer that no longer exists',
  !titles.some((t) => /inherited from/i.test(t || '')))
ok('both origins are still drawn — the pin ring survives the collapse',
  (await p.evaluate(() => document.querySelectorAll('[data-segmented-origin]').length)) > 0)

await b.close()
console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
