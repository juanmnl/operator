// QA driver for dev/briefs/qa-simplify-batch.md item 2 — the session toolbar's model/effort
// chips, through the REAL renderer + REAL project data (dev/qa-real.html / qa-real-bridge.ts),
// not the authored dev/mock.html fixture. Asserts:
//
//  1. Each menu writes the pty a bare typed line + CR — `/model <id>\r` / `/effort <level>\r` —
//     never wrapped in the bracketed-paste sequence submitQueue uses for prose. A pasted slash
//     command is silently ignored by Claude Code, so this is the one thing that must never regress
//     invisibly (see src/renderer/lib/lane-tuning.ts).
//  2. The picked value survives a tab switch (patchActiveTerminal's whole reason to exist).
//  3. The menus are not window-drag handles: PopMenu's floating panel carries `data-no-drag`
//     (required — the toolbar is a DragRegion and -webkit-app-region:drag inherits), and picking
//     a value never calls the drag bridge.
//
// Run: `npx vite --port <free>` (repo root) then `node dev/drive-tuning-chips.mjs` (or
// MOCK_PORT=<port> against a server already up). Regenerate the fixture first if missing:
// `node dev/qa-extract-real.mjs`.
import { webkit } from 'playwright'
import { readFileSync } from 'node:fs'

const PORT = process.env.MOCK_PORT || 1440
const fixture = JSON.parse(readFileSync(new URL('./qa-real-fixture.json', import.meta.url), 'utf8'))
const [LONG, BIG] = fixture.sessions
let failed = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed++
}

const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' })
p.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 200)))
await p.goto(`http://localhost:${PORT}/dev/qa-real.html`, { waitUntil: 'load' })
await p.waitForTimeout(2000)

// Open the BIG session — it is the one carrying a live terminalId in the fixture, so its chips
// render as live controls (`tunable`) rather than static badges.
await p.locator(`[data-rail-orb="${BIG.id}"]`).click()
await p.waitForTimeout(800)

const chipText = (label) => p.evaluate((l) => {
  const btns = Array.from(document.querySelectorAll('button'))
  const b = btns.find((el) => el.title?.startsWith(l))
  return b ? b.textContent.trim() : null
}, label)

// ---- 0. THE GATE. The fixture's phase is `waiting`, which is what a real between-turns lane
// reports — no tracked lane is ever `idle`. On the build whose gate was `phase === 'idle'` the
// chips render disabled with the wait title, so every check below fails to find its button. This
// one names the reason rather than leaving that as a mystery locator failure. ------------------
const gate = await p.evaluate(() => {
  const btns = Array.from(document.querySelectorAll('button'))
  const model = btns.find((el) => el.title?.startsWith('Model for this lane'))
  const waiting = btns.find((el) => el.title === 'Wait for the lane to finish its turn')
  return { enabled: !!model && !model.disabled, disabledCount: waiting ? 1 : 0 }
})
check('chips are ENABLED on a `waiting` lane (the gate is not `idle`-only)', gate.enabled,
  gate.disabledCount ? 'found chips disabled with the wait title — this is the pre-fix build' : '')

// ---- 1. /model — bare line + CR, not a bracketed paste ----------------------------------------
check('Model chip present before pick', (await chipText('Model for this lane')) === 'Model')
await p.locator('button[title^="Model for this lane"]').click()
await p.waitForTimeout(200)
const modelMenuNoDrag = await p.evaluate(() => {
  const panel = document.querySelector('[data-popmenu-item="opus"]')?.closest('[data-no-drag]')
  return !!panel
})
check('Model menu panel carries data-no-drag', modelMenuNoDrag)
await p.locator('[data-popmenu-item="opus"]').click()
await p.waitForTimeout(150)

let calls = await p.evaluate(() => window.__calls)
let writes = calls.filter((c) => c.fn === 'terminalWrite' && c.id === BIG.terminalId)
const modelWrite = writes.at(-1)
check('terminalWrite(model) targets the right terminal', writes.length >= 1, `${writes.length} write(s)`)
check('model command is a bare line + CR, exact string', modelWrite?.data === '/model opus\r', JSON.stringify(modelWrite?.data))
check('model command is NOT a bracketed paste', !/\x1b\[200~/.test(modelWrite?.data ?? ''))
check('Model chip now reads Opus', (await chipText('Model for this lane')) === 'Opus')

// ---- 2. /effort — same two guarantees ----------------------------------------------------------
await p.locator('button[title^="Reasoning effort"]').click()
await p.waitForTimeout(200)
const effortMenuNoDrag = await p.evaluate(() => {
  const panel = document.querySelector('[data-popmenu-item="high"]')?.closest('[data-no-drag]')
  return !!panel
})
check('Effort menu panel carries data-no-drag', effortMenuNoDrag)
await p.locator('[data-popmenu-item="high"]').click()
await p.waitForTimeout(150)

calls = await p.evaluate(() => window.__calls)
writes = calls.filter((c) => c.fn === 'terminalWrite' && c.id === BIG.terminalId)
const effortWrite = writes.at(-1)
check('effort command is a bare line + CR, exact string', effortWrite?.data === '/effort high\r', JSON.stringify(effortWrite?.data))
check('effort command is NOT a bracketed paste', !/\x1b\[200~/.test(effortWrite?.data ?? ''))
check('Effort chip now reads high', (await chipText('Reasoning effort')) === 'high')

// ---- 3. never calls the drag bridge --------------------------------------------------------
const dragCalls = calls.filter((c) => c.fn === 'startWindowDrag')
check('picking a value never starts a window drag', dragCalls.length === 0, `${dragCalls.length} startWindowDrag call(s)`)

// ---- 4a. survives a tab switch: leave the session for Project Home, come back to the SAME one
await p.locator('button[data-back-to-project]').click()
await p.waitForTimeout(500)
await p.locator(`[data-rail-orb="${BIG.id}"]`).click()
await p.waitForTimeout(500)
check('Model chip survives Home round-trip on the SAME session', (await chipText('Model for this lane')) === 'Opus')
check('Effort chip survives Home round-trip on the SAME session', (await chipText('Reasoning effort')) === 'high')

// ---- 4b. BUG: switching to a SIBLING lane in the same cwd (LONG, untuned) leaks BIG's picks.
// `SessionToolbar`'s model-sync effect (`if (modelProp) setModel(modelProp)`) has no branch for
// modelProp going falsy, and the two lanes share one component instance because `key={activeSession
// .workingDirectory}` is identical for every lane in the same directory — so the model chip is
// still reading component-local state from the PREVIOUS lane. Not a script bug: confirmed by
// dumping the active sidebar row (moves correctly to LONG) while the chip stays "Opus". The
// effort chip does NOT show the same symptom, but only by accident — its own effect reloads
// from `folderPrefsLoad` on every `effortLevelProp` change regardless of truthiness, which
// happens to clear it; the model chip has no equivalent fallback.
await p.locator(`[data-rail-orb="${LONG.id}"]`).click()
await p.waitForTimeout(600)
const longModelChip = await chipText('Model for this lane')
const longEffortChip = await chipText('Reasoning effort')
check(
  'Model chip clears when switching to an untuned sibling lane (same cwd)',
  longModelChip === 'Model',
  `BUG: still reads "${longModelChip}" — leaked from the previous lane`,
)
check('Effort chip clears when switching to an untuned sibling lane (same cwd)', longEffortChip === 'Effort', `reads "${longEffortChip}"`)
await p.locator(`[data-rail-orb="${BIG.id}"]`).click()
await p.waitForTimeout(500)

await p.screenshot({ path: '/tmp/tuning-chips.png', clip: { x: 900, y: 0, width: 380, height: 40 } })
await b.close()

if (failed) { console.log(`\n${failed} FAILURE(S)`); process.exit(1) }
console.log('\nAll tuning-chip checks passed.')
