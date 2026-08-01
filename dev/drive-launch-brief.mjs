// Drive the launch brief: "What do you want done?" on the roster's launch row must ride into
// the spawned agent as its FIRST MESSAGE, and an empty brief must launch exactly as before.
// The claim is end-to-end, so it is asserted on the real spawn options (`initialPrompt`),
// not on component state.
//
// Run against a vite dev server: `npx vite --port 1441` then `node dev/drive-launch-brief.mjs`.
import { webkit } from 'playwright'
const PORT = process.env.MOCK_PORT || 1441
const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))
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

// A project with idle lanes to launch. uwazi_app has nothing live in the fixture.
await gallery()
await p.locator('[data-project-card]').filter({ hasText: 'uwazi_app' }).first().click()
await p.waitForTimeout(900)
await openRoster()

console.log('0 the brief field exists on the launch row:', await p.locator('[data-launch-brief]').count())
console.log('0 its placeholder:', JSON.stringify(await p.locator('[data-launch-brief]').getAttribute('placeholder')))

// ---- 1. EMPTY BRIEF — byte-identical to today -----------------------------------------
const rowIds = await p.evaluate(() =>
  Array.from(document.querySelectorAll('[data-roster-row]')).map((r) => r.getAttribute('data-roster-row')))
console.log('1 idle lanes:', JSON.stringify(rowIds))
const before1 = (await spawns()).length
await p.locator(`[data-roster-row="${rowIds[0]}"] button`, { hasText: 'Launch' }).last().click()
await p.waitForTimeout(1600)
const after1 = (await spawns()).slice(before1)
// The dev-server instruction is PRE-EXISTING (the dev-server toggle defaults on) and is the
// whole of the prompt today. So "unchanged" = that instruction and nothing appended to it.
const DEV_INSTR_TAIL = "don't block the terminal on it."
console.log('1 EMPTY BRIEF is unchanged — only the dev-server instruction, nothing appended:',
  after1.length === 1 && (after1[0] || '').trim().endsWith(DEV_INSTR_TAIL))
console.log('1   (the prompt it did send:)', JSON.stringify((after1[0] || '').slice(0, 60) + '…'))

// ---- 2. A TYPED BRIEF reaches the agent -----------------------------------------------
await gallery()
await p.locator('[data-project-card]').filter({ hasText: 'uwazi_app' }).first().click()
await p.waitForTimeout(900)
await openRoster()
const rows2 = await p.evaluate(() =>
  Array.from(document.querySelectorAll('[data-roster-row]')).map((r) => r.getAttribute('data-roster-row')))
const BRIEF = 'Fix the timezone drift on the invoice list'
await p.locator('[data-launch-brief]').fill(BRIEF)
const before2 = (await spawns()).length
await p.locator(`[data-roster-row="${rows2[0]}"] button`, { hasText: 'Launch' }).last().click()
await p.waitForTimeout(1600)
const after2 = (await spawns()).slice(before2)
console.log('2 TYPED BRIEF spawn initialPrompt:', JSON.stringify(after2))
console.log('2 THE BRIEF REACHES THE AGENT:', after2.some((s) => (s || '').includes(BRIEF)))

// ---- 3. It CLEARS after launching, so it can't ride into the next one ------------------
await gallery()
await p.locator('[data-project-card]').filter({ hasText: 'uwazi_app' }).first().click()
await p.waitForTimeout(900)
await openRoster()
console.log('3 the field is empty again after a launch:', JSON.stringify(await p.locator('[data-launch-brief]').inputValue()))

// ---- 4. Return submits, and one brief covers a batch -----------------------------------
const rows4 = await p.evaluate(() =>
  Array.from(document.querySelectorAll('[data-roster-row]')).map((r) => r.getAttribute('data-roster-row')))
// Tick two lanes so the batch is explicit rather than "every idle lane".
await p.locator(`[data-roster-row="${rows4[0]}"]`).click()
await p.locator(`[data-roster-row="${rows4[1]}"]`).click()
await p.waitForTimeout(300)
console.log('4 the batch button now says:', await p.locator('button', { hasText: /Launch \d+ →|Launch all →/ }).first().textContent())
const BRIEF4 = 'Audit every date format in the repo'
await p.locator('[data-launch-brief]').fill(BRIEF4)
const before4 = (await spawns()).length
await p.locator('[data-launch-brief]').press('Enter')
await p.waitForTimeout(2600)
const after4 = (await spawns()).slice(before4)
console.log('4 RETURN launched:', after4.length, 'session(s)')
console.log('4 every one of them carries the SAME brief:', after4.length > 1 && after4.every((s) => (s || '').includes(BRIEF4)), JSON.stringify(after4))

await b.close()
