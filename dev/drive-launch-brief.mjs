// Drive the launch brief: "What do you want done?" on the roster's launch row must ride into
// the spawned agent as its FIRST MESSAGE, and an empty brief must launch exactly as before.
// The claim is end-to-end, so it is asserted on the real spawn options (`initialPrompt`),
// not on component state.
//
// It also pins the two guards that make the field safe to put a Return key on:
//   · Return NEVER fans out without a selection (it used to spawn six agents and six worktrees
//     from a single keystroke on an empty field);
//   · the brief CLEARS after a launch, so it can't ride into one you didn't mean.
//
// That second one has to be read IN PLACE, immediately after the launch click. An earlier
// version of this driver navigated to the gallery and back first, which unmounts RosterPanel —
// the remount gives `brief` its useState('') initial value, so the assertion passed whether or
// not setBrief('') was ever called. It was measuring React, not the feature.
//
// Exits 1 on any failed assertion.
//
// Run against a vite dev server: `npx vite --port 1441` then `node dev/drive-launch-brief.mjs`.
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
await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await p.waitForTimeout(2600)

const spawns = () => p.evaluate(() =>
  window.__calls.filter((c) => c.fn === 'terminalSpawn').map((c) => (c.opts ?? {}).initialPrompt ?? null))
const openRoster = async () => {
  await p.locator('button[aria-label="Open the roster"]').click()
  await p.waitForTimeout(900)
}
const gallery = async () => { await p.locator('[data-rail-gallery]').click(); await p.waitForTimeout(800) }
const enterProject = async (name) => {
  await gallery()
  await p.locator('[data-project-card]').filter({ hasText: name }).first().click()
  await p.waitForTimeout(900)
  await openRoster()
}
const rows = () => p.evaluate(() =>
  Array.from(document.querySelectorAll('[data-roster-row]')).map((r) => r.getAttribute('data-roster-row')))
const briefValue = () => p.locator('[data-launch-brief]').inputValue()
const noteText = () => p.locator('[data-launch-note]').textContent().catch(() => '')
// Earlier steps take lanes live and leave sessions around; a reload gives the next group a
// fresh fixture (and drops the slowed terminalSpawn patched in for the clear assertion).
const reload = async () => {
  await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
  await p.waitForTimeout(2600)
}

// uwazi_app has nothing live in the fixture, so every lane is launchable.
await enterProject('uwazi_app')
ok('the brief field exists on the launch row', await p.locator('[data-launch-brief]').count() === 1)
ok('its placeholder invites the brief', await p.locator('[data-launch-brief]').getAttribute('placeholder') === 'What do you want done?')

// ========================================================================================
// 1. THE 01-A REGRESSION. Click into the field on a fresh project and press Return without
//    typing anything. This used to spawn one session per idle lane — six worktrees, six
//    Claude Code sessions, no confirm and no undo. It must now spawn NOTHING and say why.
// ========================================================================================
const idle1 = await rows()
const before1 = (await spawns()).length
await p.locator('[data-launch-brief]').click()
await p.locator('[data-launch-brief]').press('Enter')
await p.waitForTimeout(1200)
ok('a stray Return on an empty field launches NOTHING', (await spawns()).length === before1,
  { idleLanes: idle1.length, spawned: (await spawns()).length - before1 })
ok('…and it says why rather than dying silently', /Select the lanes to launch/.test(await noteText()))

// A TYPED brief with nothing selected must refuse too: six agents on one instruction is the
// same surprise, and the field is not a target picker.
const BRIEF = 'Fix the timezone drift on the invoice list'
await p.locator('[data-launch-brief]').fill(BRIEF)
const before1b = (await spawns()).length
await p.locator('[data-launch-brief]').press('Enter')
await p.waitForTimeout(1200)
ok('Return with a brief but NO selection also refuses to fan out', (await spawns()).length === before1b)
ok('…and the typed brief survives the refusal', (await briefValue()) === BRIEF)

// ========================================================================================
// 2+3. A TYPED BRIEF REACHES THE AGENT, and the field CLEARS — the clear read IN PLACE.
//
// Reading the field after the launch resolves is not possible: a launch focuses the new
// session, which swaps the view and unmounts RosterPanel. That is exactly why the first
// version of this driver navigated to the gallery and back — and why its assertion was
// worthless, since the remount reinitialises `brief` to '' on its own.
//
// So: slow `terminalSpawn` down and watch the live field through the window that opens up.
// `setBrief('')` runs synchronously, before the first await in `launchRoles`, so with the
// backend held for 400ms the field must be observed EMPTY while still mounted. Delete the
// clear and the trace instead reads the brief text right up to the unmount (proven below).
// ========================================================================================
await p.evaluate(() => {
  const orig = window.operator.terminalSpawn
  window.operator.terminalSpawn = async (...a) => {
    await new Promise((r) => setTimeout(r, 400))
    return orig(...a)
  }
})
await p.evaluate(() => {
  window.__briefTrace = []
  window.__briefTimer = setInterval(() => {
    const el = document.querySelector('[data-launch-brief]')
    window.__briefTrace.push(el ? el.value : null) // null = panel unmounted (view swapped)
  }, 10)
})
const before2 = (await spawns()).length
await p.locator(`[data-roster-row="${idle1[0]}"] button`, { hasText: 'Launch' }).last().click()
await p.waitForTimeout(1800)
const trace = await p.evaluate(() => { clearInterval(window.__briefTimer); return window.__briefTrace })
const after2 = (await spawns()).slice(before2)
ok('THE BRIEF REACHES THE AGENT', after2.length === 1 && after2[0].includes(BRIEF))

// The discriminator: was the field ever observed EMPTY while the panel was still mounted?
const unmountAt = trace.indexOf(null)
const mounted = unmountAt === -1 ? trace : trace.slice(0, unmountAt)
ok('the field CLEARS in place — observed empty while still mounted, not reset by a remount',
  mounted.length > 0 && mounted.includes(''),
  { samplesWhileMounted: mounted.length, sawEmpty: mounted.includes(''), sawBriefStill: mounted.includes(BRIEF) })

// ========================================================================================
// 4. RETURN WITH A SELECTION launches it, and ONE brief covers the whole batch.
// ========================================================================================
await enterProject('uwazi_app')
const idle4 = await rows()
await p.locator(`[data-roster-row="${idle4[0]}"]`).click()
await p.locator(`[data-roster-row="${idle4[1]}"]`).click()
await p.waitForTimeout(300)
ok('the batch button names the selection',
  /Launch 2 →/.test(await p.locator('button', { hasText: /Launch \d+ →|Launch all →/ }).first().textContent()))
const BRIEF4 = 'Audit every date format in the repo'
await p.locator('[data-launch-brief]').fill(BRIEF4)
const before4 = (await spawns()).length
await p.locator('[data-launch-brief]').press('Enter')
await p.waitForTimeout(2800)
const after4 = (await spawns()).slice(before4)
ok('Return WITH a selection launches exactly it', after4.length === 2, after4.length)
ok('every lane in the batch carries the SAME brief', after4.length === 2 && after4.every((s) => (s || '').includes(BRIEF4)))

// ========================================================================================
// 5. ⌘Return is the deliberate fan-out — the keyboard twin of `Launch all →`. Reload first:
//    earlier steps have taken uwazi_app's lanes live, and the point of this assertion is
//    that MORE THAN ONE lane goes up from one keystroke.
// ========================================================================================
await reload()
await enterProject('uwazi_app')
const idle5 = await rows()
ok('(precondition) the fan-out target has more than one idle lane', idle5.length > 1, idle5)
const before5 = (await spawns()).length
await p.locator('[data-launch-brief]').fill('Sweep the codebase')
await p.locator('[data-launch-brief]').press('Meta+Enter')
await p.waitForTimeout(1200 + 900 * idle5.length)
ok('⌘Return fans out to every idle lane', (await spawns()).length - before5 === idle5.length,
  { idle: idle5.length, spawned: (await spawns()).length - before5 })

// ========================================================================================
// 6. AN EMPTY BRIEF IS UNCHANGED. The dev-server instruction is PRE-EXISTING (the toggle
//    defaults on) and is the whole of the prompt today, so "unchanged" means that
//    instruction with nothing appended to it.
//
//    The lane must have NO queued tasks: `handleLaunchRole` legitimately appends a task
//    block for a lane with a backlog, which is not the brief and not a defect. A lane whose
//    button reads exactly `Launch →` (rather than `Launch N →`) is one with an empty queue.
// ========================================================================================
await reload()
await enterProject('uwazi_app')
const clean6 = await p.evaluate(() => Array.from(document.querySelectorAll('[data-roster-row]'))
  .find((r) => Array.from(r.querySelectorAll('button')).some((x) => (x.textContent || '').trim() === 'Launch →'))
  ?.getAttribute('data-roster-row') ?? null)
ok('(precondition) found an idle lane with no queued tasks', !!clean6, clean6)
const before6 = (await spawns()).length
await p.locator(`[data-roster-row="${clean6}"] button`, { hasText: 'Launch' }).last().click()
await p.waitForTimeout(1600)
const after6 = (await spawns()).slice(before6)
ok('an EMPTY brief launches with the dev-server instruction and nothing appended',
  after6.length === 1 && (after6[0] || '').trim().endsWith("don't block the terminal on it."),
  (after6[0] || '').slice(-40))

await b.close()
console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
