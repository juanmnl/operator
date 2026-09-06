// QA driver for dev/briefs/qa-plan-bar-and-bus.md item 2 — the session bottom bar's three cells
// (FooterReading.tsx), through the REAL renderer against dev/qa-real-bridge.ts's real
// project/roster fixture plus a controllable planLimits (dev/qa-planbar-bridge via
// dev/qa-planbar-main.tsx, ?limits=<case>) and the bridge's own `__mockPhase` hook to drive a
// session's contextTokens/model/effort/phase/compactions without a real pty.
//
// Run: `npx vite --port <free>` (repo root) then `node dev/drive-plan-bar.mjs` (or
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

async function openSession(limitsCase, patch) {
  const p = await b.newPage({ viewport: { width: 1400, height: 900 }, colorScheme: 'dark' })
  p.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 200)))
  await p.goto(`http://localhost:${PORT}/dev/qa-planbar.html?limits=${limitsCase}`, { waitUntil: 'load' })
  await p.waitForTimeout(1200)
  await p.locator(`[data-rail-orb="${BIG.id}"]`).click()
  await p.waitForTimeout(800)
  if (patch) {
    await p.evaluate(({ id, patch }) => window.__mockPhase(id, patch), { id: BIG.id, patch })
    await p.waitForTimeout(300)
  }
  return p
}

// The "ctx" label is a leaf span (no children) with that EXACT text — its parent is the context
// cell. `.actions-footer > span` only reaches FooterReading's own OUTER wrapper (a single span
// holding all three cells plus the Rules between them), so cell boundaries have to be found by
// content, not by DOM depth from `.actions-footer`.
const ctxCell = (p) => p.evaluateHandle(() => {
  const label = Array.from(document.querySelectorAll('.actions-footer span'))
    .find((s) => s.children.length === 0 && s.textContent === 'ctx')
  return label.parentElement
})
const ctxText = async (p) => (await ctxCell(p)).evaluate((el) => el.textContent)
// The context Bar is the one 34px-wide track (the plan cell's bars are 44px) — unique within the
// cell, and its own inline `background` is the fill colour.
const ctxBarColor = async (p) => (await ctxCell(p)).evaluate((el) => {
  const track = Array.from(el.querySelectorAll('span')).find((s) => s.style.width === '34px')
  return track?.firstElementChild?.style.background ?? null
})
const planRows = (p) => p.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => b.title?.includes('opens Tuning'))
  if (!btn) return null
  return Array.from(btn.children).map((row) => {
    if (!row.getAttribute) return { chip: row.textContent }
    const numSpan = row.querySelector('span')
    const ruleSpan = row.lastElementChild
    return {
      title: row.getAttribute('title'),
      text: numSpan?.textContent,
      numColor: numSpan ? getComputedStyle(numSpan).color : null,
      ruleBg: ruleSpan ? getComputedStyle(ruleSpan).backgroundColor : null,
    }
  })
})
const planButtonText = (p) => p.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => b.title?.includes('opens Tuning'))
  return btn?.textContent ?? null
})

// ===== 1. Context cell =========================================================================

{
  const p = await openSession('absent', { contextTokens: 12_000, model: 'claude-opus-5', compactions: 0, phase: 'idle' })
  check('12k/200k renders as "12k / 200k"', (await ctxText(p))?.includes('12k / 200k'), await ctxText(p))
  const fg = await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())
  const barColor = await ctxBarColor(p)
  check('12k/200k (6%) bars in the NORMAL tone (--accent)', barColor?.includes(fg) || barColor === 'var(--accent)', barColor)
  await p.close()
}

{
  const p = await openSession('absent', { contextTokens: 184_000, model: 'claude-opus-5', compactions: 0, phase: 'idle' })
  check('184k/200k renders as "184k / 200k"', (await ctxText(p))?.includes('184k / 200k'), await ctxText(p))
  const barColor = await ctxBarColor(p)
  check('184k/200k (92%) bars in the DANGER tone (--color-error)', barColor === 'var(--color-error)', barColor)
  await p.close()
}

{
  // A [1m] model id: 400k of a 1M window is 40%, nowhere near danger — the window must come from
  // the MODEL, not a hardcoded 200k, or this would show as 200% over a full-looking red bar.
  const p = await openSession('absent', { contextTokens: 400_000, model: 'claude-sonnet-5[1m]', compactions: 0, phase: 'idle' })
  check('[1m] model: window is 1.0M, not 200k', (await ctxText(p))?.includes('400k / 1.0M'), await ctxText(p))
  const barColor = await ctxBarColor(p)
  const fg = await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())
  check('[1m] model at 40%: NORMAL tone, not danger', barColor === 'var(--accent)' || barColor?.includes(fg), barColor)
  await p.close()
}

{
  const p = await openSession('absent', { contextTokens: 50_000, model: 'claude-opus-5', compactions: 2, phase: 'compacting' })
  const text = await ctxText(p)
  check('compacting phase swaps the numbers for "compacting…" text, not an animation', text?.includes('compacting…'), text)
  check('the ↺ count still shows next to "compacting…"', text?.includes('↺2'), text)
  await p.close()
}

{
  const p = await openSession('absent', { contextTokens: 50_000, model: 'claude-opus-5', compactions: 0, phase: 'idle' })
  const text = await ctxText(p)
  check('↺ is absent entirely at compactions=0 (presence IS the signal)', !text?.includes('↺'), text)
  await p.close()
}

{
  const p = await openSession('absent', { contextTokens: 0, model: 'claude-opus-5', compactions: 0, phase: 'idle' })
  const text = await ctxText(p)
  check('ABSENT IS NOT ZERO: no context yet renders "—", never "0k"', text?.includes('— / 200k') && !text?.includes('0k /'), text)
  await p.close()
}

// ===== 2. Plan cell: each limit binding in turn ===============================================

for (const [kase, expectBindingKey, expectBindingLabel] of [
  ['session-binding', 'session', 'Current session'],
  ['week-binding', 'week', 'Current week'],
  ['model-binding', 'model', 'Current week (Opus)'],
]) {
  const p = await openSession(kase)
  const rows = await planRows(p)
  check(`${kase}: three rows render (session, week, per-model)`, rows?.length === 3, JSON.stringify(rows?.map((r) => r.text)))
  const bindingRow = rows?.find((r) => r.title?.startsWith(expectBindingLabel))
  const others = rows?.filter((r) => r !== bindingRow)
  const fg = await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--fg').trim())
  const fgMuted = await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--fg-muted').trim())
  const toHex = (rgb) => rgb // colors already resolved as rgb(...) by getComputedStyle; compare against the resolved --fg/--fg-muted via a probe element
  const probe = await p.evaluate((vars) => {
    const out = {}
    for (const [k, v] of Object.entries(vars)) {
      const el = document.createElement('span'); el.style.color = v; document.body.appendChild(el)
      out[k] = getComputedStyle(el).color
      el.remove()
    }
    return out
  }, { fg, fgMuted })
  check(`${kase}: ONLY "${expectBindingLabel}" is marked (fg ink)`, bindingRow?.numColor === probe.fg, bindingRow?.numColor)
  check(`${kase}: the other two rows are muted, not marked`, others?.every((r) => r.numColor === probe.fgMuted), JSON.stringify(others?.map((r) => r.numColor)))
  check(`${kase}: only the binding row's rule is painted (not transparent)`, bindingRow?.ruleBg !== 'rgba(0, 0, 0, 0)', bindingRow?.ruleBg)
  check(`${kase}: the other two rows' rules stay transparent`, others?.every((r) => r.ruleBg === 'rgba(0, 0, 0, 0)'), JSON.stringify(others?.map((r) => r.ruleBg)))
  check(`${kase}: the binding row's title carries the reset clause, others don't`, bindingRow?.title?.includes('resets') && others?.every((r) => !r.title?.includes('resets')))
  await p.close()
}

// ===== 3. absent / stale -> "no reading" =======================================================

for (const kase of ['absent', 'stale']) {
  const p = await openSession(kase)
  const text = await planButtonText(p)
  check(`${kase}: plan cell reads "no reading", never a stale/zero percentage`, /no reading/i.test(text ?? ''), text)
  check(`${kase}: no percentage sign leaks into the "no reading" state`, !/%/.test(text ?? ''), text)
  await p.close()
}

// ===== 4. click opens Tuning ====================================================================

{
  const p = await openSession('session-binding')
  await p.locator('button', { hasText: /Current session/ }).click()
  await p.waitForTimeout(500)
  check('clicking the plan cell opens Tuning', (await p.evaluate(() => document.querySelector('[data-page-title]')?.textContent)) === 'Tuning')
  await p.close()
}

{
  // The no-reading state is a button too — must still open Tuning ("what's driving this" applies
  // even when the answer is "we don't know yet").
  const p = await openSession('absent')
  await p.locator('button', { hasText: /no reading/i }).click()
  await p.waitForTimeout(500)
  check('clicking the "no reading" plan cell ALSO opens Tuning', (await p.evaluate(() => document.querySelector('[data-page-title]')?.textContent)) === 'Tuning')
  await p.close()
}

// ===== 5. rail foot: no ring, Tuning in the slot, at both widths ===============================

for (const [label, collapse] of [['expanded (default)', false], ['collapsed (⌘B)', true]]) {
  const p = await openSession('session-binding')
  if (collapse) { await p.keyboard.press('Meta+b'); await p.waitForTimeout(500) }
  const hasUsage = await p.evaluate(() => !!document.querySelector('[data-rail-usage]'))
  const hasTuning = await p.evaluate(() => !!document.querySelector('[data-rail-tuning]'))
  const hasPlanMeterRing = await p.evaluate(() => Array.from(document.querySelectorAll('svg circle')).some((c) => c.getAttribute('stroke-dasharray')))
  check(`${label}: no plan-usage ring in the rail foot`, !hasUsage && !hasPlanMeterRing, `usage=${hasUsage} ringSvg=${hasPlanMeterRing}`)
  check(`${label}: Tuning occupies the resting slot`, hasTuning)
  await p.close()
}

await b.close()

if (failed) { console.log(`\n${failed} FAILURE(S)`); process.exit(1) }
console.log('\nAll plan-bar checks passed.')
