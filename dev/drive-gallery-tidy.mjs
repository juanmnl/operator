// Drive the assisted TIDY pass (plan step 6): the stale bar, the pre-checked review sheet,
// bulk shelve with one undo, and the dismissal that survives a restart.
//
// Run against a vite dev server: `npx vite --port 1440` then `node dev/drive-gallery-tidy.mjs`.
import { webkit } from 'playwright'

const PORT = process.env.MOCK_PORT || 1440
const STALE = 6 // pad projects aged past the 14-day line
const FRESH = 2 // …and ones that must NOT be offered

const b = await webkit.launch()
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })

// Same durable-store stand-in as drive-gallery-shelf (mock saveProjects is a noop), plus
// AGEING: the fixture's projects all ran minutes ago, so nothing is stale and the bar could
// never appear. `operator` is aged too — it has live sessions, so it must be excluded from
// the offer no matter how long ago it last ran.
await ctx.addInitScript(({ stale, fresh }) => {
  const day = 86400000
  let real
  Object.defineProperty(window, 'operator', {
    configurable: true,
    get: () => real,
    set: (v) => {
      real = v
      const origLoad = v.loadProjects
      v.loadProjects = async () => {
        const stashed = localStorage.getItem('harness.projects')
        if (stashed) return JSON.parse(stashed)
        const now = Date.now()
        const base = ((await origLoad()) ?? []).map((p) => (p.name === 'operator'
          ? { ...p, lastActiveAt: new Date(now - 40 * day).toISOString() }
          : p))
        const pad = (i, ageDays) => ({
          id: `pad-${i}`, path: `/Users/jane/Developer/pad-${i}`, name: `pad-${i}`,
          createdAt: new Date(now - 120 * day).toISOString(),
          lastActiveAt: new Date(now - ageDays * day).toISOString(),
          roster: [],
        })
        return [
          ...base,
          ...Array.from({ length: stale }, (_, i) => pad(i, 20 + i * 7)),
          ...Array.from({ length: fresh }, (_, i) => pad(stale + i, 3)),
        ]
      }
      v.saveProjects = (list) => { try { localStorage.setItem('harness.projects', JSON.stringify(list)) } catch { /* quota */ } }
    },
  })
}, { stale: STALE, fresh: FRESH })

const p = await ctx.newPage()
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 250)))
p.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 200)) })

const boot = async () => {
  await p.waitForTimeout(2800)
  await p.keyboard.press('Meta+Shift+O')
  await p.waitForTimeout(700)
}
const state = () => p.evaluate(() => ({
  heading: document.querySelector('h2')?.textContent?.trim(),
  bar: document.querySelector('[data-tidy-bar]')?.textContent?.replace('Review →', ' | Review').trim() ?? null,
  sheet: !!document.querySelector('[data-tidy-review-sheet]'),
  rows: document.querySelectorAll('[data-tidy-row]').length,
  checked: Array.from(document.querySelectorAll('[data-tidy-row]')).filter((r) => r.getAttribute('aria-pressed') === 'true').length,
  count: document.querySelector('[data-tidy-count]')?.textContent ?? null,
  shelveBtn: document.querySelector('[data-tidy-shelve]')?.textContent ?? null,
  cards: document.querySelectorAll('[data-project-card]').length,
  previous: document.querySelector('[data-shelf-toggle]')?.textContent?.trim() ?? null,
}))

await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await boot()

// ---- 1. The bar counts only what it should ------------------------------------------
const s1 = await state()
console.log('1 at rest:', JSON.stringify(s1))
console.log(`1 offers the ${STALE} stale ones only:`, s1.bar?.startsWith(`${STALE} projects haven't run in over two weeks.`), '(expect true)')
console.log('1 a LIVE project 40d old is not offered:', !!s1.bar && s1.cards === 3 + STALE + FRESH, '(expect true — operator is live)')

// ---- 2. Escape closes the review without shelving ------------------------------------
await p.locator('[data-tidy-review]').click()
await p.waitForTimeout(400)
const s2 = await state()
console.log('2 sheet, PRE-CHECKED:', JSON.stringify({ rows: s2.rows, checked: s2.checked, count: s2.count, btn: s2.shelveBtn }))
await p.screenshot({ path: '/tmp/operator-shots/tidy-review.png' })
await p.keyboard.press('Escape')
await p.waitForTimeout(400)
const s2b = await state()
console.log('2 Escape closed it, nothing shelved:', !s2b.sheet && s2b.cards === s1.cards && s2b.previous === null, '(expect true)')

// ---- 3. Dismissal survives a restart -------------------------------------------------
await p.locator('[data-tidy-bar] button[aria-label="Dismiss"]').click()
await p.waitForTimeout(400)
console.log('3 dismissed:', (await state()).bar, '(expect null)')
await p.reload({ waitUntil: 'load' })
await boot()
console.log('3 still dismissed after reload:', (await state()).bar, '(expect null)')
console.log('3 what was remembered:', await p.evaluate(() => {
  const v = JSON.parse(localStorage.getItem('operator.tidyDismissed') || 'null')
  return v && { ids: v.ids.length, hasAt: !!v.at }
}))

// ---- 4. …and a NEW quiet project brings it back --------------------------------------
await p.evaluate(() => {
  const v = JSON.parse(localStorage.getItem('operator.tidyDismissed'))
  localStorage.setItem('operator.tidyDismissed', JSON.stringify({ ...v, ids: v.ids.slice(1) }))
})
await p.reload({ waitUntil: 'load' })
await boot()
const s4 = await state()
console.log('4 one un-asked project raises the bar again:', s4.bar, `(expect the ${STALE} count)`)

// ---- 5. Uncheck one, shelve the rest, undo -------------------------------------------
await p.locator('[data-tidy-review]').click()
await p.waitForTimeout(400)
await p.locator('[data-tidy-row]').first().click()
await p.waitForTimeout(250)
const s5 = await state()
console.log('5 after unchecking one:', JSON.stringify({ checked: s5.checked, count: s5.count, btn: s5.shelveBtn }))
await p.locator('[data-tidy-shelve]').click()
await p.waitForTimeout(700)
const s5b = await state()
console.log('5 after shelve:', JSON.stringify(s5b))
console.log(`5 ${STALE - 1} moved to Previous:`, s5b.previous?.startsWith(`Previous · ${STALE - 1}`), '(expect true)')
console.log('5 the unchecked one stayed active:', s5b.cards === s1.cards - (STALE - 1), '(expect true)')
console.log('5 bulk undo offered:', await p.evaluate(() => {
  const t = Array.from(document.querySelectorAll('div')).find((d) => d.textContent?.startsWith('Shelved 5 projects') && d.querySelector('button'))
  return t ? t.textContent.slice(0, 30) : null
}))
console.log('5 bar gone — the pass was made:', s5b.bar, '(expect null)')

await p.screenshot({ path: '/tmp/operator-shots/tidy-after-shelve.png' })
await p.locator('button', { hasText: /^Undo$/ }).first().click()
await p.waitForTimeout(700)
const s6 = await state()
console.log('6 undo restored every one of them:', JSON.stringify({ cards: s6.cards, previous: s6.previous }), `(expect ${s1.cards} cards, no Previous)`)
console.log('6 …and does NOT re-open the nag:', s6.bar, '(expect null)')

await b.close()
