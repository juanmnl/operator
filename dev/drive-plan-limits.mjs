// Drive the PLAN LIMITS meter (dev/briefs/plan-limits-always-visible.md).
//
// The claim: session and weekly limits are permanently visible — including at the gallery, with
// nothing running, which is exactly when you're deciding what to launch. And the distinction the
// whole feature turns on: ABSENT IS NOT ZERO.
//
// Run against a vite dev server: `npx vite --port 1440` then `node dev/drive-plan-limits.mjs`.
import { webkit } from 'playwright'

const PORT = process.env.MOCK_PORT || 1440
const b = await webkit.launch()
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: 'dark' })
const p = await ctx.newPage()
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))

const meter = () => p.evaluate(() => {
  const b = document.querySelector('[data-rail-usage]')
  if (!b) return null
  const arc = b.querySelector('[data-usage-arc]')
  return {
    label: b.getAttribute('aria-label'),
    pct: b.getAttribute('data-usage-pct'),
    hasArc: !!arc,
    dash: arc?.getAttribute('stroke-dasharray') ?? null,
    stroke: arc ? getComputedStyle(arc).stroke : null,
  }
})

await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await p.waitForTimeout(3200)

// ---- 1. It is in the rail foot, and it read the plan --------------------------------------
console.log('1 meter:', JSON.stringify(await meter()))
const sweep = () => p.evaluate(() => {
  const arc = document.querySelector('[data-usage-arc]')
  if (!arc) return null
  const [dash] = (arc.getAttribute('stroke-dasharray') ?? '').split(' ').map(Number)
  const c = 2 * Math.PI * Number(arc.getAttribute('r'))
  return Math.round((dash / c) * 100)
})
console.log('1 the ring is swept to the BINDING figure — here the session, 66 > 39:', await sweep(), '(expect 66)')
console.log('1 …and it did NOT block first paint:', await p.evaluate(() =>
  window.__calls.filter((c) => c.fn === 'planLimits').length), '(expect 1 — one deferred read, not a poll)')

// ---- 2. The popover reads the numbers -----------------------------------------------------
await p.locator('[data-rail-usage]').click()
await p.waitForTimeout(500)
const pop = await p.evaluate(() => {
  const el = document.querySelector('[data-usage-popover]')
  if (!el) return null
  return {
    rows: Array.from(el.querySelectorAll('[data-usage-row]')).map((r) => ({
      key: r.getAttribute('data-usage-row'),
      label: r.querySelector('span')?.textContent?.trim(),
      value: r.querySelector('[data-usage-value]')?.textContent?.trim(),
      width: r.querySelector('[data-usage-bar]')?.style.width,
      tone: r.querySelector('[data-usage-bar]')?.getAttribute('data-usage-tone'),
      resets: r.querySelector('p')?.textContent?.trim(),
    })),
    updated: el.querySelector('[data-usage-updated]')?.textContent?.trim(),
  }
})
console.log('2 popover rows:', JSON.stringify(pop?.rows, null, 0))
console.log('2 bar widths match the percentages:', pop?.rows.every((r) => r.width === `${parseInt(r.value)}%`), '(expect true)')
console.log('2 the per-model row carries the CLI label, not a hardcoded name:', pop?.rows[2]?.label, '(expect "Current week (Fable)")')
console.log('2 reset text is verbatim, timezone intact:', pop?.rows[0]?.resets)
console.log('2 footer:', pop?.updated)
// The bar must carry NO border — its colour changes at the thresholds.
// borderWIDTH, not borderStyle: Tailwind's preflight sets `border: 0 solid` on every element, so
// style is "solid" everywhere and only the width says whether anything is painted.
console.log('2 no border on a colour-changing bar (WKWebView rule):', await p.evaluate(() => {
  const bar = document.querySelector('[data-usage-bar]')
  return bar ? getComputedStyle(bar).borderWidth : null
}), '(expect 0px)')

// ---- 3. Escape closes it and focus returns ------------------------------------------------
await p.keyboard.press('Escape')
await p.waitForTimeout(400)
console.log('3 Escape closes it:', await p.evaluate(() => !document.querySelector('[data-usage-popover]')), '(expect true)')
console.log('3 …and focus returns to the button:', await p.evaluate(() =>
  document.activeElement?.hasAttribute('data-rail-usage')), '(expect true)')

// ---- 4. Refresh forces a re-read ----------------------------------------------------------
await p.locator('[data-rail-usage]').click(); await p.waitForTimeout(400)
await p.locator('[data-usage-refresh]').click(); await p.waitForTimeout(700)
console.log('4 Refresh asked the backend to skip its cache:', await p.evaluate(() =>
  window.__calls.filter((c) => c.fn === 'planLimits').map((c) => c.force)), '(expect [false, true])')
await p.keyboard.press('Escape')

// ---- 5. AT THE GALLERY, with nothing scoped ------------------------------------------------
await p.locator('[data-rail-gallery]').click()
await p.waitForTimeout(800)
console.log('5 still there with no project scoped:', JSON.stringify(await meter()))

// ---- 6. THRESHOLD COLOURS ------------------------------------------------------------------
await p.goto(`http://localhost:${PORT}/dev/mock.html?usage=high`, { waitUntil: 'load' })
await p.waitForTimeout(3200)
await p.locator('[data-rail-usage]').click(); await p.waitForTimeout(500)
console.log('6 tones at 93% / 78% / 0%:', JSON.stringify(await p.evaluate(() =>
  Array.from(document.querySelectorAll('[data-usage-bar]')).map((b) => [b.getAttribute('data-usage-bar'), b.getAttribute('data-usage-tone')]))),
  '(expect danger / warn / normal)')
console.log('6 and the three fills are visibly different:', JSON.stringify(await p.evaluate(() =>
  Array.from(document.querySelectorAll('[data-usage-bar]')).map((b) => getComputedStyle(b).backgroundColor))))

// ---- 6b. The ring follows the WEEK when the week is the binding one -------------------------
// The shipped bug: one arc summarising three rows drew the session and nothing else, so a 24%
// ring sat above a 65% week. The glance must never contradict the popover it stands in for.
await p.goto(`http://localhost:${PORT}/dev/mock.html?usage=weekly`, { waitUntil: 'load' })
await p.waitForTimeout(3200)
console.log('6b session 24 / week 65 → the ring draws:', await sweep(), '(expect 65, NOT 24)')
console.log('6b …and it says which limit that is:', JSON.stringify(await meter()))
console.log('6b the ring agrees with the popover it summarises:', await p.evaluate(async () => {
  document.querySelector('[data-rail-usage]').click()
  await new Promise((r) => setTimeout(r, 400))
  const rows = Array.from(document.querySelectorAll('[data-usage-row]'))
    .map((r) => Number(r.querySelector('[data-usage-value]').textContent.match(/\d+/)[0]))
  const arc = document.querySelector('[data-usage-arc]')
  const [dash] = arc.getAttribute('stroke-dasharray').split(' ').map(Number)
  const drawn = Math.round((dash / (2 * Math.PI * Number(arc.getAttribute('r')))) * 100)
  return { rows, drawn, isMax: drawn === Math.max(...rows) }
}), '(expect isMax true)')

// ---- 7. ABSENT IS NOT ZERO -----------------------------------------------------------------
await p.goto(`http://localhost:${PORT}/dev/mock.html?usage=none`, { waitUntil: 'load' })
await p.waitForTimeout(3200)
const none = await meter()
console.log('7 no reading → NO percentage on the button:', JSON.stringify(none), '(expect pct "" and hasArc false)')
console.log('7 the button is still there to click:', !!none, '(expect true)')
await p.locator('[data-rail-usage]').click(); await p.waitForTimeout(500)
console.log('7 the popover EXPLAINS the absence rather than showing 0%:', await p.evaluate(() => ({
  empty: document.querySelector('[data-usage-empty]')?.textContent?.trim().slice(0, 120),
  rows: document.querySelectorAll('[data-usage-row]').length,
  anyZero: /\b0%\b/.test(document.querySelector('[data-usage-popover]')?.textContent ?? ''),
})), '(expect rows 0, anyZero false)')

await p.screenshot({ path: '/tmp/operator-shots/plan-limits.png' })
await b.close()
