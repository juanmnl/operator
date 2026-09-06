// QA driver for dev/briefs/qa-simplify-batch.md item 3 — the Dev servers panel
// (WorktreesSection.tsx), against dev/qa-devservers.html's fixture: all four owner classes
// (dead-app, abandoned-lane, untagged, live-lane) plus the postgres-with-tags case the module's
// own comment warns about (a Homebrew postgres carrying an inherited OPERATOR_TERMINAL_ID with
// no OPERATOR_APP_PID, which must classify as the safest-to-assume-nothing `untagged`, never as
// something the UI calls "safe to stop"). The fixture (dev/qa-devservers-fixture.json) was
// produced by running the REAL classifier (electron/src/main/dev-servers.ts's
// devServerInventory) over a fabricated ps table — see the vitest one-off that generated it.
//
// Asserts: the confirm dialog's wording (count + the live-lane risk callout), that Cancel calls
// devServerKill zero times, that confirming calls it with exactly the picked pids, and that no
// select-all control exists anywhere in the panel.
//
// Run: `npx vite --port <free>` (repo root) then `node dev/drive-devservers.mjs` (or
// MOCK_PORT=<port> against a server already up).
import { webkit } from 'playwright'
import { readFileSync } from 'node:fs'

const PORT = process.env.MOCK_PORT || 1440
const fixture = JSON.parse(readFileSync(new URL('./qa-devservers-fixture.json', import.meta.url), 'utf8'))
let failed = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed++
}

const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 800, height: 900 }, colorScheme: 'dark' })
p.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 200)))
await p.goto(`http://localhost:${PORT}/dev/qa-devservers.html`, { waitUntil: 'load' })
await p.waitForTimeout(800)

// ---- all four owner classes + postgres-with-tags are present and correctly labelled ----------
const rows = await p.evaluate(() => Array.from(document.querySelectorAll('label')).map((l) => ({
  text: l.textContent.trim(),
  pid: l.querySelector('input')?.closest('label') ? l.textContent.match(/^\d+/)?.[0] : null,
})))
console.log(`rows rendered: ${rows.length}`)
for (const r of rows) console.log('  ' + r.text.replace(/\s+/g, ' '))

const owners = ['dead-app', 'abandoned-lane', 'untagged', 'live-lane']
check('all four owner classes are represented in the fixture', new Set(fixture.map((r) => r.owner)).size === 4, JSON.stringify([...new Set(fixture.map((r) => r.owner))]))

const postgresLabel = await p.evaluate(() => {
  const l = Array.from(document.querySelectorAll('label')).find((el) => el.title?.includes('postgres'))
  return l?.textContent.replace(/\s+/g, ' ').trim()
})
check('postgres-with-tags row is listed (tagged rows bypass the dev-server-shape filter)', !!postgresLabel, postgresLabel ?? 'not found')
check('postgres-with-tags is classified "No Operator tag", NOT a safe-to-kill class', /No Operator tag/.test(postgresLabel ?? ''), postgresLabel)
check('postgres-with-tags note reads unprovable, not "safe to stop"', await p.evaluate(() =>
  document.body.textContent.includes('nothing proves Operator started it')))

const mcpServeRow = fixture.some((r) => /mcp-serve/.test(r.command))
check('the --mcp-serve helper (tagged, NOT_A_SERVER_RE) is excluded from the fixture entirely', !mcpServeRow)

// ---- no select-all -----------------------------------------------------------------------------
const selectAllLike = await p.evaluate(() => {
  const candidates = Array.from(document.querySelectorAll('button, input, [role="checkbox"]'))
  return candidates
    .map((el) => (el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim())
    .filter((t) => /select all|check all|all\b.*select/i.test(t))
})
check('no select-all control anywhere in the Dev servers panel', selectAllLike.length === 0, JSON.stringify(selectAllLike))
// Every checkbox is independently addressable — count matches row count, none pre-checked.
const checkboxState = await p.evaluate(() => Array.from(document.querySelectorAll('input[type="checkbox"]')).map((c) => c.checked))
check('every row has its own checkbox, none pre-checked', checkboxState.length === fixture.length && checkboxState.every((c) => c === false), JSON.stringify(checkboxState))

// ---- pick one dead-app + the live-lane row, open confirm, check wording -----------------------
const deadPid = fixture.find((r) => r.owner === 'dead-app').pid
const livePid = fixture.find((r) => r.owner === 'live-lane').pid
await p.locator(`label[title*="${deadPid}"]`).locator('input').click().catch(async () => {
  // fall back to pid-text match if title doesn't carry it
  await p.evaluate((pid) => {
    const row = Array.from(document.querySelectorAll('label')).find((l) => l.textContent.includes(String(pid)))
    row?.querySelector('input')?.click()
  }, deadPid)
})
await p.evaluate((pid) => {
  const row = Array.from(document.querySelectorAll('label')).find((l) => l.textContent.includes(String(pid)))
  const input = row?.querySelector('input')
  if (input && !input.checked) input.click()
}, deadPid)
await p.evaluate((pid) => {
  const row = Array.from(document.querySelectorAll('label')).find((l) => l.textContent.includes(String(pid)))
  const input = row?.querySelector('input')
  if (input && !input.checked) input.click()
}, livePid)
await p.waitForTimeout(150)

const stopBtnLabel = await p.evaluate(() => Array.from(document.querySelectorAll('button')).find((b) => /^Stop \d+ selected$/.test(b.textContent.trim()))?.textContent)
check('the trigger button counts the picks, not "all"', stopBtnLabel === 'Stop 2 selected', stopBtnLabel)

await p.locator('button', { hasText: /^Stop 2 selected$/ }).click()
await p.waitForTimeout(150)
const confirmText = await p.evaluate(() => document.body.textContent)
check('confirm names the exact count', /2 processes and everything under them will be stopped/.test(confirmText))
check('confirm calls out the live-lane risk by count', /1 belongs to a lane that is open right now — its preview will stop working/.test(confirmText), confirmText.match(/\d belongs? to a lane[^.]*\./)?.[0])

// ---- Cancel kills nothing -----------------------------------------------------------------------
await p.locator('button', { hasText: 'Cancel' }).click()
await p.waitForTimeout(150)
let calls = await p.evaluate(() => window.__calls)
check('Cancel calls devServerKill zero times', calls.filter((c) => c.fn === 'devServerKill').length === 0)
check('Cancel leaves both rows still checked (nothing was reset)', await p.evaluate((pids) =>
  pids.every((pid) => {
    const row = Array.from(document.querySelectorAll('label')).find((l) => l.textContent.includes(String(pid)))
    return row?.querySelector('input')?.checked
  }), [deadPid, livePid]))

// ---- Confirming kills exactly the picked pids, nothing else ------------------------------------
await p.locator('button', { hasText: /^Stop 2 selected$/ }).click()
await p.waitForTimeout(150)
await p.locator('button', { hasText: 'Stop them' }).click()
await p.waitForTimeout(150)
calls = await p.evaluate(() => window.__calls)
const killCall = calls.find((c) => c.fn === 'devServerKill')
const killedPids = killCall?.args?.[0]
check('devServerKill is called exactly once', calls.filter((c) => c.fn === 'devServerKill').length === 1)
check('devServerKill is called with exactly the two picked pids, nothing else', JSON.stringify([...(killedPids ?? [])].sort()) === JSON.stringify([deadPid, livePid].sort()), JSON.stringify(killedPids))

await b.close()

if (failed) { console.log(`\n${failed} FAILURE(S)`); process.exit(1) }
console.log('\nAll Dev servers panel checks passed.')
