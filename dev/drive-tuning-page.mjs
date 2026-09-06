// QA driver for dev/briefs/qa-2-simplify-batch.md item 2 — the Tuning page, through the REAL
// renderer against dev/qa-tuning.html's fully-synthetic bridge (dev/qa-tuning-bridge.ts).
//
// Four `getTuning`/`planLimits` fixtures (?case=a|b|c|d), each isolating one branch of
// `biggestChange` (lib/tuning.ts) or the plan-reading state:
//   a — top lane above 25% share, a step down exists           -> "change" card
//   b — top lane below 25% share                                -> "nothing" card, plain %
//   c — top lane above 25% but already at the bottom of the      -> "nothing" card, "already at"
//       effort ladder (`low`), so no step exists
//   d — plan percentage unavailable (`planLimits` returns {})    -> ProjectShare "no reading"
// Plus the Not-attributed row and a populated Context-pressure row (case a), and the three
// navigation entry points (rail foot, plan-meter popover footer link, ⌘K palette).
//
// Run: `npx vite --port <free>` (repo root) then `node dev/drive-tuning-page.mjs` (or
// MOCK_PORT=<port> against a server already up).
import { webkit } from 'playwright'

const PORT = process.env.MOCK_PORT || 1440
let failed = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed++
}

const b = await webkit.launch()

async function openCase(kase) {
  const p = await b.newPage({ viewport: { width: 1100, height: 1000 }, colorScheme: 'dark' })
  p.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 200)))
  await p.goto(`http://localhost:${PORT}/dev/qa-tuning.html?case=${kase}`, { waitUntil: 'load' })
  await p.waitForTimeout(1200)
  await p.locator('[data-rail-tuning]').click()
  await p.waitForTimeout(600)
  return p
}

const bodyText = (p) => p.evaluate(() => document.body.innerText)

// ---- Case (a): top lane above 25%, a step down exists -> "change" card ------------------------
{
  const p = await openCase('a')
  const text = await bodyText(p)
  check('(a) page title is Tuning', /^Tuning$/m.test(await p.evaluate(() => document.querySelector('[data-page-title]')?.textContent ?? '')))
  check('(a) headline names the top lane, model, effort and share', /Code on Opus at High took 80% of the last 7 days/.test(text), text.match(/Code on Opus[^\n]*/)?.[0])
  check('(a) detail proposes the one-step-down move, never a forecasted saving', /Dropping it one step to Medium is the smallest change/.test(text))
  check('(a) card never claims a predicted saving', !/%\s*(saving|savings|reduction)/i.test(text))
  check('(a) "estimate" chip and roster CTA render for a change card', /estimate/i.test(text) && /Open Code in the roster/.test(text))
  check('(a) Not attributed row is present and named exactly that', /Not attributed/.test(text))
  check('(a) Context pressure row shows real compaction/re-read/median numbers, not all dashes', /50k/.test(text) && /120k/.test(text))
  await p.close()
}

// ---- Case (b): top lane below 25% -> "nothing" card, plain percentage -------------------------
{
  const p = await openCase('b')
  const text = await bodyText(p)
  check('(b) "Nothing stands out" headline', /Nothing stands out\./.test(text))
  check('(b) detail states a plain percentage, not "already at"', /24% of the last 7 days/.test(text) && !/already at/i.test(text), text.match(/The top lane is[^\n]*/)?.[0])
  check('(b) no roster CTA on a "nothing" card (nothing to open)', !/Open Code in the roster/.test(text))
  await p.close()
}

// ---- Case (c): top lane above 25% but already at the bottom of the ladder ---------------------
{
  const p = await openCase('c')
  const text = await bodyText(p)
  check('(c) "Nothing stands out" headline', /Nothing stands out\./.test(text))
  check('(c) detail says "already at Low", not a percentage', /already at Low\./.test(text), text.match(/The top lane is[^\n]*/)?.[0])
  await p.close()
}

// ---- Case (d): plan percentage unavailable -> ProjectShare "no reading" -----------------------
{
  const p = await openCase('d')
  const text = await bodyText(p)
  check('(d) plan section shows "no reading" rather than a stale/zero percentage', /no reading/i.test(text))
  check('(d) explains the percentage comes from Claude Code and is unavailable right now', /not available right now/.test(text))
  check('(d) the local split still renders despite the plan reading being absent', /Acme/.test(text) && /project share of the window/i.test(text))
  check('(d) never fabricates a 0% plan reading', !/0%\s*used/.test(text))
  await p.close()
}

// ---- Entry point 1: rail foot (already exercised above, confirm explicitly) --------------------
{
  const p = await b.newPage({ viewport: { width: 1100, height: 1000 }, colorScheme: 'dark' })
  await p.goto(`http://localhost:${PORT}/dev/qa-tuning.html?case=a`, { waitUntil: 'load' })
  await p.waitForTimeout(1200)
  await p.locator('[data-rail-tuning]').click()
  await p.waitForTimeout(500)
  check('entry point: rail foot navigates to Tuning', (await p.evaluate(() => document.querySelector('[data-page-title]')?.textContent)) === 'Tuning')
  await p.close()
}

// ---- Entry point 2: plan-meter popover footer link ("What's driving this →") ------------------
{
  const p = await b.newPage({ viewport: { width: 1100, height: 1000 }, colorScheme: 'dark' })
  await p.goto(`http://localhost:${PORT}/dev/qa-tuning.html?case=a`, { waitUntil: 'load' })
  await p.waitForTimeout(1200)
  await p.locator('[data-rail-usage]').click()
  await p.waitForTimeout(400)
  const linkVisible = await p.locator('[data-usage-tuning]').isVisible().catch(() => false)
  check('plan-meter popover opens and offers the Tuning link', linkVisible)
  await p.locator('[data-usage-tuning]').click()
  await p.waitForTimeout(500)
  check('entry point: plan-meter footer link navigates to Tuning', (await p.evaluate(() => document.querySelector('[data-page-title]')?.textContent)) === 'Tuning')
  await p.close()
}

// ---- Entry point 3: ⌘K palette ------------------------------------------------------------------
{
  const p = await b.newPage({ viewport: { width: 1100, height: 1000 }, colorScheme: 'dark' })
  await p.goto(`http://localhost:${PORT}/dev/qa-tuning.html?case=a`, { waitUntil: 'load' })
  await p.waitForTimeout(1200)
  await p.keyboard.press('Meta+k')
  await p.waitForTimeout(400)
  await p.keyboard.type('Tuning')
  await p.waitForTimeout(300)
  const row = p.locator('[data-row]', { hasText: 'Tuning — where the window went' })
  check('palette lists the Tuning action when filtered', await row.count() > 0)
  await row.first().click()
  await p.waitForTimeout(500)
  check('entry point: ⌘K palette navigates to Tuning', (await p.evaluate(() => document.querySelector('[data-page-title]')?.textContent)) === 'Tuning')
  await p.close()
}

await b.close()

if (failed) { console.log(`\n${failed} FAILURE(S)`); process.exit(1) }
console.log('\nAll Tuning-page checks passed.')
