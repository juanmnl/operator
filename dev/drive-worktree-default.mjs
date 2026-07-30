// Drive the worktree-default flip: `operator` and `research` now seed to ON, and an EXISTING
// `~/.operator/role-defaults.json` is migrated up to it once, with an Undo toast.
//
// The migration is the load-bearing half. `seedGlobalDefaults()` only ever runs against an EMPTY
// store, so everyone who has already launched the app has all six roles written to disk — without
// the migration a changed default reaches nobody, and the flip would look like it did nothing.
//
// Fixture: `?worktree=` (dev/mock-bridge) loads the store verbatim as it stood before the flip.
// `?worktree=1` also clears the one-shot flag so the migration runs; any other value keeps it.
//
// Run against a vite dev server: `npx vite --port 1440` then `node dev/drive-worktree-default.mjs`.
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
// Read what the app PERSISTED through the bridge, not what it rendered — the migration's whole
// job is to change the durable store, and a screen that looks right over an unwritten file is the
// bug rather than the proof.
const stored = () => p.evaluate(() => window.__roleDefaults ?? null)
// …and the UI's own answer, so the two can't quietly disagree.
const shown = () => p.evaluate(() => Object.fromEntries(
  Array.from(document.querySelectorAll('[data-default-worktree]')).map((btn) => [
    btn.getAttribute('data-default-worktree'),
    btn.getAttribute('aria-pressed'),
  ]),
))
// The hub opens on Fleet; Defaults is a sibling tab — the toast names that path, so the driver
// walks it rather than deep-linking, which is what proves the path in the copy actually exists.
const openDefaults = async () => {
  await p.locator('[data-rail-agents]').click()
  await p.waitForTimeout(900)
  await p.locator('button', { hasText: /^Defaults$/ }).first().click()
  await p.waitForTimeout(700)
}

// ---- 1. It migrates the stored file on hydrate ----------------------------------------
await boot('worktree=1')
const after = await stored()
console.log('1 stored defaults after migration:', JSON.stringify(after))
console.log('1 operator + research flipped ON:', after?.operator?.useWorktree === true && after?.research?.useWorktree === true)
console.log('1 review + qa untouched (their seed never moved):', after?.review?.useWorktree === false && after?.qa?.useWorktree === false)
console.log('1 code + design still on:', after?.code?.useWorktree === true && after?.design?.useWorktree === true)

// ---- 2. It says so, and offers the way back -------------------------------------------
const banner = p.locator('text=/now run in their own worktree/').first()
console.log('2 toast shown:', await banner.count() > 0)
console.log('2 toast text:', JSON.stringify(await banner.textContent().catch(() => null)))
console.log('2 offers Undo:', await p.locator('button', { hasText: 'Undo' }).count() > 0)
await p.screenshot({ path: '/tmp/operator-shots/worktree-default-toast.png' })

// ---- 3. The Agents → Defaults screen agrees with the file ------------------------------
await openDefaults()
console.log('3 worktree toggles as drawn:', JSON.stringify(await shown()))
await p.screenshot({ path: '/tmp/operator-shots/worktree-default-agents.png' })

// ---- 4. Undo restores the stored posture ----------------------------------------------
await boot('worktree=1')
await p.locator('button', { hasText: 'Undo' }).first().click()
await p.waitForTimeout(800)
const undone = await stored()
console.log('4 stored after Undo:', JSON.stringify(undone))
console.log('4 back to off:', undone?.operator?.useWorktree === false && undone?.research?.useWorktree === false)
console.log('4 flag STAYS set — undo means keep it:', await p.evaluate(() => !!localStorage.getItem('operator.worktreeSeedMigratedAt')))

// ---- 5. The flag gates it: same store, flag set, nothing moves -------------------------
// Without this the migration would re-run every launch and overwrite the user's own choice —
// the same trap the seeded-lane prune's flag exists for.
await boot('worktree=2')
const second = await stored()
console.log('5 stored on a flagged boot:', JSON.stringify(second))
console.log('5 did not run again:', second?.operator?.useWorktree === false && second?.research?.useWorktree === false)
console.log('5 no toast:', await p.locator('text=/now run in their own worktree/').count() === 0)

// ---- 6. A FIRST-RUN install seeds straight to the new posture --------------------------
await boot('empty=1&worktree=1')
const seeded = await stored()
console.log('6 first-run seed:', JSON.stringify(seeded))
console.log('6 seeds operator + research ON:', seeded?.operator?.useWorktree === true && seeded?.research?.useWorktree === true)
console.log('6 no migration toast on a fresh install:', await p.locator('text=/now run in their own worktree/').count() === 0)

await b.close()
