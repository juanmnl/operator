// Drive the usage meter's THREE freshness states (dev/briefs/plan-usage-stale.md).
//
// The reported failure: the popover showed `12% used` beside `resets Jul 30 at 9:59am` — after
// 10am. Not stale, provably false, and both halves came from the same cached reading. The hook
// fetched once at mount and never again, so the backend's 5-minute TTL was never exercised.
//
// `?usage=` picks the fixture: (default) fresh · aging (past TTL, window still open) ·
// expired (its own reset clause has passed) · none (an account with no limits).
//
// Run against a vite dev server: `npx vite --port 1440` then `node dev/drive-plan-freshness.mjs`.
import { webkit } from 'playwright'
const PORT = process.env.MOCK_PORT || 1440
const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))

const show = async (mode) => {
  await p.goto(`http://localhost:${PORT}/dev/mock.html${mode ? `?usage=${mode}` : ''}`, { waitUntil: 'load' })
  await p.waitForTimeout(3000)
  await p.locator('[data-rail-usage]').click()
  await p.waitForTimeout(600)
  const out = await p.evaluate(() => {
    const btn = document.querySelector('[data-rail-usage]')
    const pop = document.querySelector('[data-usage-popover]')
    return {
      freshness: btn?.getAttribute('data-usage-freshness'),
      ringPct: btn?.getAttribute('data-usage-pct') ?? null,
      hasArc: !!btn?.querySelector('[data-usage-arc]'),
      rows: Array.from(pop?.querySelectorAll('[data-usage-row]') ?? []).map((r) => r.textContent?.replace(/\s+/g, ' ').trim()),
      aging: pop?.querySelector('[data-usage-aging]')?.textContent?.trim() ?? null,
      empty: pop?.querySelector('[data-usage-empty]')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      emptyKind: pop?.querySelector('[data-usage-empty]')?.getAttribute('data-usage-empty-kind') ?? null,
      updated: pop?.querySelector('[data-usage-updated]')?.textContent?.trim() ?? null,
    }
  })
  console.log(`\n--- ${mode || 'fresh'} ---`)
  console.log('  freshness :', out.freshness, '| ring shows:', JSON.stringify(out.ringPct), '| arc drawn:', out.hasArc)
  console.log('  rows      :', JSON.stringify(out.rows))
  if (out.aging) console.log('  aging     :', JSON.stringify(out.aging))
  if (out.empty) console.log('  empty     :', out.emptyKind, JSON.stringify(out.empty))
  console.log('  footer    :', JSON.stringify(out.updated))
  await p.screenshot({ path: `/tmp/operator-shots/usage-${mode || 'fresh'}.png` })
  return out
}

const fresh = await show(null)
const aging = await show('aging')
const expired = await show('expired')

console.log('\n=== the fix, stated as assertions ===')
console.log('fresh   shows its numbers            :', fresh.rows.length > 0 && fresh.freshness === 'current')
console.log('aging   STILL shows them, and warns  :', aging.rows.length > 0 && aging.freshness === 'aging' && !!aging.aging)
console.log('expired shows NO percentage          :', expired.rows.length === 0 && !expired.hasArc && expired.ringPct === '')
console.log('expired SAYS the window closed       :', expired.emptyKind === 'stale' && /window closed/i.test(expired.empty || ''))
await b.close()
