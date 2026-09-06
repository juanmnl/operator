// QA driver for dev/briefs/qa-2-simplify-batch.md item 4 — the toolbar chips' phase gating,
// added by bca3c7d ("Fix the Review's four blockers... chips are live only at phase idle").
// Reuses pass 1's dev/qa-real bridge (dev/qa-real.html, dev/qa-real-bridge.ts) and its
// `__mockPhase` hook to drive the session through running/waiting/idle without a real pty.
//
// Asserts: both chips are `disabled` (and titled "Wait for the lane to finish its turn") while
// phase is running or waiting; enabled at idle; a pick writes through `submitQueue.submitTyped`
// (still `window.operator.terminalWrite` underneath) as a typed line, never a bracketed paste;
// and the custom-model field commits ONLY on Enter, never on blur.
//
// Run: `npx vite --port <free>` (repo root) then `node dev/drive-toolbar-gating.mjs` (or
// MOCK_PORT=<port> against a server already up). Regenerate the fixture first if missing:
// `node dev/qa-extract-real.mjs`.
import { webkit } from 'playwright'
import { readFileSync } from 'node:fs'

const PORT = process.env.MOCK_PORT || 1440
const fixture = JSON.parse(readFileSync(new URL('./qa-real-fixture.json', import.meta.url), 'utf8'))
const [, BIG] = fixture.sessions
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
await p.locator(`[data-rail-orb="${BIG.id}"]`).click()
await p.waitForTimeout(800)

const setPhase = (phase) => p.evaluate((ph) => window.__mockPhase(window.__bigId, { phase: ph }), phase)
// __mockPhase needs the session id in scope; stash it once.
await p.evaluate((id) => { window.__bigId = id }, BIG.id)

const modelBtn = () => p.locator('[data-popmenu-trigger="model"]')
const effortBtn = () => p.locator('[data-popmenu-trigger="effort"]')

async function checkGated(phase, shouldBeDisabled) {
  await setPhase(phase)
  await p.waitForTimeout(200)
  const modelDisabled = await modelBtn().isDisabled()
  const effortDisabled = await effortBtn().isDisabled()
  check(`phase=${phase}: model chip ${shouldBeDisabled ? 'disabled' : 'enabled'}`, modelDisabled === shouldBeDisabled)
  check(`phase=${phase}: effort chip ${shouldBeDisabled ? 'disabled' : 'enabled'}`, effortDisabled === shouldBeDisabled)
  if (shouldBeDisabled) {
    const title = await modelBtn().getAttribute('title')
    check(`phase=${phase}: disabled chip explains why`, title === 'Wait for the lane to finish its turn', title)
  }
}

await checkGated('running', true)
await checkGated('waiting', true)

// While disabled, a real click must not open the menu or write anything.
await modelBtn().click({ force: true }).catch(() => {})
await p.waitForTimeout(150)
check('a click on a disabled chip opens no menu', await p.evaluate(() => !document.querySelector('[data-popmenu-item]')))
let calls = await p.evaluate(() => window.__calls)
check('a click on a disabled chip writes nothing to the pty', calls.filter((c) => c.fn === 'terminalWrite').length === 0)

await checkGated('idle', false)

// ---- hooks use-dismiss actually reads -----------------------------------------------------
check('model chip carries aria-haspopup=menu', (await modelBtn().getAttribute('aria-haspopup')) === 'menu')
check('model chip aria-expanded reflects the closed menu', (await modelBtn().getAttribute('aria-expanded')) === 'false')
await modelBtn().click()
await p.waitForTimeout(150)
check('model chip aria-expanded flips true once opened', (await modelBtn().getAttribute('aria-expanded')) === 'true')

// ---- the write is a typed line (submitTyped), never a bracketed paste ---------------------
await p.locator('[data-popmenu-item="opus"]').click()
await p.waitForTimeout(200)
calls = await p.evaluate(() => window.__calls)
const write = calls.filter((c) => c.fn === 'terminalWrite').at(-1)
check('the write targets the right terminal', write?.id === BIG.terminalId, write?.id)
check('the write is NOT a bracketed paste', !/\x1b\[200~/.test(write?.data ?? ''), JSON.stringify(write?.data))
check('the write is exactly one typed line + one CR (no double Enter)', write?.data === '/model opus\r', JSON.stringify(write?.data))

// ---- custom model: Enter commits, blur discards --------------------------------------------
await effortBtn().click().catch(() => {}) // close the model menu via outside interaction
await p.waitForTimeout(150)
await modelBtn().click()
await p.waitForTimeout(150)
await p.locator('[data-popmenu-item="other"]').click()
await p.waitForTimeout(150)
const input = p.locator('input[placeholder="model id or alias"]')
await input.fill('custom-blur-id')
await input.blur()
await p.waitForTimeout(200)
calls = await p.evaluate(() => window.__calls)
check('blur DISCARDS a half-typed custom id — no write, no menu commit', !calls.some((c) => c.fn === 'terminalWrite' && /custom-blur-id/.test(c.data ?? '')))

await modelBtn().click()
await p.waitForTimeout(150)
await p.locator('[data-popmenu-item="other"]').click()
await p.waitForTimeout(150)
await p.locator('input[placeholder="model id or alias"]').fill('custom-enter-id')
await p.keyboard.press('Enter')
await p.waitForTimeout(200)
calls = await p.evaluate(() => window.__calls)
const customWrite = calls.filter((c) => c.fn === 'terminalWrite').at(-1)
check('Enter COMMITS the custom id as a typed line', customWrite?.data === '/model custom-enter-id\r', JSON.stringify(customWrite?.data))

await b.close()

if (failed) { console.log(`\n${failed} FAILURE(S)`); process.exit(1) }
console.log('\nAll toolbar-gating checks passed.')
