// RESTART PUTS YOU BACK WHERE YOU WERE — and does NOT start anything (2026-08-03).
//
// "if i restart the app, everything should open where it was, can we do that?"
//
// Settled shape: restore the UI exactly, never auto-spawn. The assertion that matters most is
// therefore a NEGATIVE one — nothing spawns — and it is asserted on `terminalSpawn` calls, not
// on what the screen looks like, because "no new lane appeared" and "a lane appeared and then
// something removed it" are indistinguishable by appearance.
//
// The restore decision itself is a pure function with its own unit tests (lib/workspace.test.ts);
// what this driver proves is the WIRING: that a snapshot is written as you move, that it is read
// at launch, and that the setting gates the spawn.
//
// Run against a vite dev server: `npx vite --port 1440` then `node dev/drive-restore-workspace.mjs`.
import { webkit } from 'playwright'

const PORT = process.env.MOCK_PORT || 1440
const WORKSPACE_KEY = 'operator.workspace'
const RESUME_KEY = 'operator.resumeOnLaunch'

let failed = 0
const ok = (label, pass, detail) => {
  if (!pass) failed++
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`)
}

const b = await webkit.launch()
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
const p = await ctx.newPage()
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 250)))

const boot = () => p.waitForTimeout(3200)
const workspace = () => p.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), WORKSPACE_KEY)
const spawns = () => p.evaluate(() => window.__calls.filter((c) => c.fn === 'terminalSpawn').length)
const view = () => p.evaluate(() => document.querySelector('[data-toolbar-header]')?.getAttribute('data-toolbar-header'))
const tab = () => p.evaluate(() => document.querySelector('[data-project-tab-active]')?.getAttribute('data-project-tab'))
/** Toasts auto-dismiss, so a single read after a fixed wait is a coin flip — poll for it. */
const waitForText = async (source, ms = 9000) => {
  const deadline = Date.now() + ms
  for (;;) {
    const hit = await p.evaluate((src) => document.body.innerText.match(new RegExp(src))?.[0] ?? null, source)
    if (hit || Date.now() > deadline) return hit
    await p.waitForTimeout(200)
  }
}

await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await boot()

// ── 1. The snapshot is written AS YOU MOVE, not at quit ────────────────────────────────
// An app that records your place only on a clean exit loses it to exactly the stop this
// feature exists to survive, so there is nothing to "flush" and no quit hook to trust.
await p.locator('[data-session-row="s-code"]').click()
await p.waitForTimeout(1200)
const inSession = await workspace()
console.log('1 snapshot while a lane is focused:', JSON.stringify(inSession))
ok('the snapshot records the focused LANE and the live set',
  inSession?.mode === 'session' && !!inSession?.focusedKey && inSession.liveKeys.length > 0,
  { mode: inSession?.mode, focusedKey: !!inSession?.focusedKey, live: inSession?.liveKeys?.length })
ok('…keyed durably, not by a pty id',
  typeof inSession?.focusedKey === 'string' && !inSession.focusedKey.startsWith('local-') && !/^t\d+$/.test(inSession.focusedKey),
  inSession?.focusedKey)

await p.locator('button[aria-label="Add an agent on the roster"]').click()
await p.waitForTimeout(900)
const onTeam = await workspace()
ok('it follows you to Project Home and records the tab',
  onTeam?.mode === 'project' && onTeam?.projectTab === 'team', { mode: onTeam?.mode, tab: onTeam?.projectTab })

// ── 2. RELAUNCH with the setting OFF: back where you were, and NOTHING spawns ──────────
// The mock re-attaches live ptys on boot, which is a RELOAD, not a restart. Clear them so the
// page comes up with no terminals — the actual restart condition.
await p.evaluate((k) => localStorage.setItem(k, '0'), RESUME_KEY)
await p.addInitScript(() => {
  // No pty survives a restart. `terminalList` is what the re-attach reads.
  const patch = () => { if (window.operator) { window.operator.terminalList = async () => []; return true } return false }
  if (!patch()) { const t = setInterval(() => { if (patch()) clearInterval(t) }, 5) }
})
await p.reload({ waitUntil: 'load' })
await boot()
const spawnsAfter = await spawns()
const restored = { view: await view(), tab: await tab(), rows: await p.locator('[data-session-row]').count() }
console.log('2 after relaunch:', JSON.stringify(restored), 'spawns:', spawnsAfter)
ok('NOTHING is spawned when "Resume agents on launch" is off', spawnsAfter === 0, { spawns: spawnsAfter })
ok('you land back in the project, on the tab you left',
  restored.view === 'project' && restored.tab === 'team', restored)
ok('and no session is faked into looking live', restored.rows === 0, { sessionRows: restored.rows })
await p.screenshot({ path: '/tmp/restore-1-off.png' })

// ── 3. A focused LANE restores as Project Home, and says so ────────────────────────────
await p.evaluate((k) => {
  const w = JSON.parse(localStorage.getItem(k))
  localStorage.setItem(k, JSON.stringify({ ...w, mode: 'session', projectTab: 'board' }))
}, WORKSPACE_KEY)
await p.reload({ waitUntil: 'load' })
await boot()
ok('a focused lane comes back as Project Home, never as a live-looking session',
  (await view()) === 'project' && (await p.locator('[data-session-row]').count()) === 0)
const toastText = await waitForText('Picked up where you left off[\\s\\S]{0,120}')
console.log('3 toast:', JSON.stringify(toastText))
ok('…and the user is TOLD what is one press away', !!toastText && /ready to resume/.test(toastText), toastText)
await p.screenshot({ path: '/tmp/restore-2-was-in-lane.png' })

// ── 4. The setting ON: the same launch resumes, through the EXISTING per-project path ──
await p.evaluate((k) => localStorage.setItem(k, '1'), RESUME_KEY)
await p.reload({ waitUntil: 'load' })
await boot()
await p.waitForTimeout(2500)
const resumedSpawns = await spawns()
console.log('4 spawns with the setting on:', resumedSpawns)
ok('with the setting ON, the lanes you had are resumed', resumedSpawns > 0, { spawns: resumedSpawns })
const resumeOpts = await p.evaluate(() => window.__calls.filter((c) => c.fn === 'terminalSpawn').map((c) => !!c.opts?.resumeSessionId))
ok('…as RESUMES of the saved conversation, not fresh sessions', resumeOpts.length > 0 && resumeOpts.every(Boolean), resumeOpts)
await p.screenshot({ path: '/tmp/restore-3-on.png' })

// ── 5. FAILURE MODE: the folder is gone → named, and never spawned into ────────────────
await p.evaluate((k) => localStorage.setItem(k, '0'), RESUME_KEY)
await p.addInitScript(() => {
  // Stage a deleted folder without deleting one: the mock's `pathExists` consults this.
  window.__missingPaths = ['/Users/dev/operator']
})
await p.reload({ waitUntil: 'load' })
const goneToast = await waitForText('folder gone')
ok('a lane whose folder is gone is NAMED, not silently skipped', goneToast === 'folder gone', goneToast)
ok('…and still nothing spawned', (await spawns()) === 0)
await p.screenshot({ path: '/tmp/restore-4-folder-gone.png' })

// ── 6. FIRST RUN: no snapshot at all → the gallery, no noise ───────────────────────────
await p.evaluate((k) => localStorage.removeItem(k), WORKSPACE_KEY)
await p.evaluate(() => localStorage.removeItem('operator.activeProjectId'))
await p.reload({ waitUntil: 'load' })
await boot()
ok('first run lands at the gallery with nothing spawned',
  (await p.getByText(/^Projects ·/).count()) > 0 && (await spawns()) === 0)

await b.close()
console.log(failed ? `\n${failed} FAILED` : '\nall checks passed')
process.exit(failed ? 1 : 0)
