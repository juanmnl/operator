// Drive the gallery card's new description row: snippet + 2-line clamp, the ⋯ editor,
// persistence through the real updateProject path, and the no-description case.
import { webkit } from 'playwright'
const PORT = process.env.MOCK_PORT || 1440
const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))
await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await p.waitForTimeout(2600)
await p.keyboard.press('Meta+Shift+O')
await p.waitForTimeout(800)

const geom = () => p.evaluate(() => Array.from(document.querySelectorAll('[role="button"]')).map((c) => {
  const r = c.getBoundingClientRect()
  const rows = Array.from(c.children).map((el) => el.getBoundingClientRect())
  return {
    name: c.querySelector('span')?.textContent?.trim().slice(0, 14),
    w: Math.round(r.width), h: Math.round(r.height),
    left: Math.round(r.left), top: Math.round(r.top),
    footerBottom: Math.round(rows[rows.length - 1].bottom - r.top),
  }
}))

const g1 = await geom()
console.log('1 cards:', JSON.stringify(g1, null, 0))
console.log('1 same row → equal height:', new Set(g1.map((c) => c.h)).size === 1)
console.log('1 footers aligned:', new Set(g1.map((c) => c.footerBottom)).size === 1)
console.log('1 gutter:', g1[1].left - (g1[0].left + g1[0].w), '(expect 14)')

// The long note must be clamped to exactly 2 rendered lines.
const clamp = await p.evaluate(() => {
  const el = Array.from(document.querySelectorAll('div')).find((d) => d.textContent?.startsWith('Mission control for working agents'))
  if (!el) return null
  const lh = parseFloat(getComputedStyle(el).lineHeight)
  return { h: Math.round(el.getBoundingClientRect().height), lines: Math.round(el.getBoundingClientRect().height / lh), scrollH: el.scrollHeight }
})
console.log('2 long note clamped:', JSON.stringify(clamp), '(expect lines 2, scrollH > h)')

// No-description card renders no snippet row.
const uwaziRows = await p.evaluate(() => {
  const c = Array.from(document.querySelectorAll('[role="button"]')).find((x) => x.textContent?.includes('uwazi_app'))
  return c ? c.children.length : null
})
console.log('3 no-description card block count:', uwaziRows, '(expect 3: headline + add-prompt + footer)')

// The description-less card offers the prompt on HOVER only, and it must not shift layout.
const beforeHover = await p.evaluate(() => {
  const c = document.querySelector('[data-project-card]:has([data-card-add-notes])') || Array.from(document.querySelectorAll('[data-project-card]')).find((x) => x.querySelector('[data-card-add-notes]'))
  const btn = c?.querySelector('[data-card-add-notes]')
  return { h: c ? Math.round(c.getBoundingClientRect().height) : null, opacity: btn ? getComputedStyle(btn).opacity : null }
})
await p.locator('[role="button"]').filter({ hasText: 'uwazi_app' }).first().hover()
await p.waitForTimeout(300)
const afterHover = await p.evaluate(() => {
  const c = Array.from(document.querySelectorAll('[data-project-card]')).find((x) => x.querySelector('[data-card-add-notes]'))
  const btn = c?.querySelector('[data-card-add-notes]')
  return { h: c ? Math.round(c.getBoundingClientRect().height) : null, opacity: btn ? getComputedStyle(btn).opacity : null }
})
console.log('3b add-notes prompt hidden→shown:', beforeHover.opacity, '→', afterHover.opacity)
console.log('3b no layout shift on hover:', beforeHover.h === afterHover.h, `(${beforeHover.h} → ${afterHover.h})`)

// ---- the editor -------------------------------------------------------------------
await p.locator('[role="button"]').filter({ hasText: 'uwazi_app' }).first().hover()
await p.waitForTimeout(200)
await p.locator('button[aria-label="uwazi_app actions"]').click()
await p.waitForTimeout(350)
const items = await p.evaluate(() => Array.from(document.querySelectorAll('button')).map((b) => b.textContent?.trim()).filter((t) => /description/i.test(t || '')))
console.log('4 menu item:', JSON.stringify(items), '(expect "Add description")')
await p.getByText('Add description').first().click()
await p.waitForTimeout(400)
console.log('5 textarea focused:', await p.evaluate(() => document.activeElement?.tagName))
// Clicking inside the editor must NOT open the project.
await p.locator('textarea[placeholder^="What is this project"]').click()
await p.waitForTimeout(300)
console.log('5 still on gallery after click in editor:', (await p.getByText(/^Projects ·/).count()) > 0)
await p.locator('textarea[placeholder^="What is this project"]').fill('Document management for human rights orgs. Node + Elastic.')
await p.keyboard.press('Meta+Enter')
await p.waitForTimeout(600)
const saved = await p.evaluate(() => {
  const c = Array.from(document.querySelectorAll('[role="button"]')).find((x) => x.textContent?.includes('uwazi_app'))
  return c?.textContent?.includes('Document management') ? 'shown' : 'MISSING'
})
console.log('6 committed to card:', saved)
console.log('6 persisted to store:', await p.evaluate(() => {
  const ps = JSON.parse(localStorage.getItem('operator.projects') || '[]')
  return ps.find((x) => x.name === 'uwazi_app')?.contextNotes?.slice(0, 24) ?? 'MISSING'
}))
await p.screenshot({ path: '/tmp/operator-shots/cards-after-edit.png' })

// Escape must cancel, not commit.
await p.locator('button[aria-label="uwazi_app actions"]').click()
await p.waitForTimeout(300)
await p.getByText('Edit description').first().click()
await p.waitForTimeout(350)
await p.locator('textarea[placeholder^="What is this project"]').fill('THROWAWAY')
await p.keyboard.press('Escape')
await p.waitForTimeout(500)
console.log('7 Escape cancelled:', await p.evaluate(() => {
  const c = Array.from(document.querySelectorAll('[role="button"]')).find((x) => x.textContent?.includes('uwazi_app'))
  return !c?.textContent?.includes('THROWAWAY') && c?.textContent?.includes('Document management')
}))
await b.close()
