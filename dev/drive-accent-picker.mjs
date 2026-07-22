// Drive the orb colour picker on all three surfaces: right-click an orb → popover →
// pick a swatch → the orb AND the label recolour, and the choice persists to the right
// place (roster Role.accent for a lane, operator.sessionAccents for a lane-less session).
import { webkit } from 'playwright'

const theme = process.argv[2] || 'mission-control-dark'
const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: theme.endsWith('light') ? 'light' : 'dark' })
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))
await p.addInitScript((t) => localStorage.setItem('operator.theme', t), theme)
await p.goto('http://localhost:1429/dev/mock.html', { waitUntil: 'load' })
await p.waitForTimeout(2500)

const PICK = '#fb7185' // rose, from the extension row — not any lane's default
let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? '  — ' + detail : ''}`)
  if (!ok) failures++
}

// ---------------------------------------------------------------- expanded sidebar row
const row = p.locator('[data-session-row]').first()
const rowId = await row.getAttribute('data-session-row')
const orb = row.locator('[data-accent-orb]').first()
check('sidebar row exposes an orb handle', await orb.count() === 1)

// Left-click must still SELECT the session, not open the picker.
await orb.click()
await p.waitForTimeout(300)
check('left-click does not open the picker', await p.locator('[data-accent-swatch]').count() === 0)

await orb.click({ button: 'right' })
await p.waitForTimeout(400)
check('right-click opens the picker', await p.locator('[data-accent-swatch]').count() > 0,
  `${await p.locator('[data-accent-swatch]').count()} swatches`)

// Esc closes.
await p.keyboard.press('Escape')
await p.waitForTimeout(300)
check('Esc closes the picker', await p.locator('[data-accent-swatch]').count() === 0)

// Re-open, then click away to close.
await orb.click({ button: 'right' })
await p.waitForTimeout(300)
await p.mouse.click(900, 700)
await p.waitForTimeout(300)
check('click-away closes the picker', await p.locator('[data-accent-swatch]').count() === 0)

// Re-open and actually pick.
const labelColorOf = (id) => p.evaluate((rid) => {
  const r = document.querySelector(`[data-session-row="${rid}"]`)
  const spans = Array.from(r.querySelectorAll('span')).filter((el) => el.children.length === 0 && el.textContent.trim())
  return spans.length ? getComputedStyle(spans[0]).color : null
}, id)
const orbFillOf = (id) => p.evaluate((rid) => {
  const r = document.querySelector(`[data-session-row="${rid}"]`)
  const c = r.querySelector('[data-accent-orb] svg circle, [data-accent-orb] svg rect')
  return c ? getComputedStyle(c).fill : null
}, id)

const beforeLabel = await labelColorOf(rowId)
await orb.click({ button: 'right' })
await p.waitForTimeout(300)
await p.locator(`[data-accent-swatch="${PICK}"]`).click()
await p.waitForTimeout(500)
check('picker closes after choosing', await p.locator('[data-accent-swatch]').count() === 0)
const afterLabel = await labelColorOf(rowId)
check('row label recolours', beforeLabel !== afterLabel, `${beforeLabel} → ${afterLabel}`)
console.log(`       orb fill now ${await orbFillOf(rowId)}`)

// Persistence: this row is a LANE (mock sessions carry roleIds) → roster is source of truth.
const persisted = await p.evaluate(() => ({
  projects: JSON.parse(localStorage.getItem('operator.projects') || '[]')
    .flatMap((pr) => (pr.roster || []).map((r) => ({ id: r.id, accent: r.accent }))),
  overrides: JSON.parse(localStorage.getItem('operator.sessionAccents') || '{}'),
}))
const hitRole = persisted.projects.find((r) => (r.accent || '').toLowerCase() === PICK)
check('lane pick persisted onto Role.accent', !!hitRole, hitRole ? `role "${hitRole.id}"` : JSON.stringify(persisted.projects))
check('lane pick did NOT write a per-session override', Object.keys(persisted.overrides).length === 0,
  JSON.stringify(persisted.overrides))

// Every surface follows the roster: the dashboard row for the same lane recolours too.
await p.getByTitle('Active sessions').click()
await p.waitForTimeout(700)
const dashColors = await p.evaluate(() => Array.from(document.querySelectorAll('[data-dash-title]'))
  .map((el) => ({ text: el.textContent.trim(), color: getComputedStyle(el).color })))
console.log('       dashboard titles:', JSON.stringify(dashColors))

// ------------------------------------------------- lane-LESS session → per-session override
// The other half of the spec: a session with no roster lane has nowhere on the roster to
// store a colour, so it must land in operator.sessionAccents keyed by its SAVED key.
await p.evaluate(() => { localStorage.removeItem('operator.sessionAccents') })
const laneless = await p.evaluate(() => {
  // A row whose title is NOT tracked-uppercase is a session with no lane.
  const rows = Array.from(document.querySelectorAll('[data-session-row]'))
  for (const r of rows) {
    const span = Array.from(r.querySelectorAll('span')).find((el) => el.children.length === 0 && el.textContent.trim().length > 2)
    if (span && getComputedStyle(span).textTransform !== 'uppercase') return r.getAttribute('data-session-row')
  }
  return null
})
console.log(`       lane-less row: ${laneless}`)
if (!laneless) {
  check('found a lane-less session to test the override path', false, 'fixture has none')
} else {
  const lrow = p.locator(`[data-session-row="${laneless}"]`)
  const lorb = lrow.locator('[data-accent-orb]').first()
  // The LABEL of a lane-less row stays neutral by design (only a lane gets an accent
  // label), so assert the ORB — that's the surface the override actually paints.
  const orbFill = (id) => p.evaluate((rid) => {
    const r = document.querySelector(`[data-session-row="${rid}"]`)
    const c = r?.querySelector('[data-accent-orb] svg circle, [data-accent-orb] svg rect')
    return c ? getComputedStyle(c).fill : null
  }, id)
  const before = await orbFill(laneless)
  await lorb.click({ button: 'right' })
  await p.waitForTimeout(400)
  check('lane-less orb opens the picker', await p.locator('[data-accent-swatch]').count() > 0)
  await p.locator('[data-accent-swatch="#a78bfa"]').click()
  await p.waitForTimeout(500)
  const store = await p.evaluate(() => JSON.parse(localStorage.getItem('operator.sessionAccents') || '{}'))
  check('lane-less pick persisted to operator.sessionAccents', Object.values(store).some((v) => String(v).toLowerCase() === '#a78bfa'),
    JSON.stringify(store))
  const after = await orbFill(laneless)
  check('lane-less orb recolours', !!after && after !== before, `${before} → ${after}`)
  // The orb is 37 individually-tinted dots on a twinkle animation, so its exact fill
  // jitters frame to frame — compare by DISTANCE to the two known states instead of
  // demanding equality (an equality check here fails for the wrong reason).
  const rgb = (c) => (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number)
  const dist = (a2, b2) => { const x = rgb(a2), y = rgb(b2); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) }
  // And it must SURVIVE a reload — the whole point of keying on the saved key.
  await p.reload({ waitUntil: 'load' })
  await p.waitForTimeout(2500)
  const stillThere = await p.evaluate(() => JSON.parse(localStorage.getItem('operator.sessionAccents') || '{}'))
  check('override survives a reload', Object.values(stillThere).some((v) => String(v).toLowerCase() === '#a78bfa'),
    JSON.stringify(stillThere))
  const afterReload = await orbFill(laneless)
  const toPicked = dist(afterReload, after)
  const toNeutral = dist(afterReload, before)
  check('lane-less orb keeps its colour after reload', !!afterReload && toPicked < toNeutral,
    `reloaded ${afterReload}: ${toPicked.toFixed(1)} from picked vs ${toNeutral.toFixed(1)} from un-picked`)
}

// ---------------------------------------------------------------- collapsed rail
await p.evaluate(() => localStorage.setItem('operator.sidebarCollapsed', '1'))
await p.reload({ waitUntil: 'load' })
await p.waitForTimeout(2500)
const railOrb = p.locator('button[aria-label]').filter({ has: p.locator('svg') })
await p.locator('button').filter({ hasText: '' }).first().waitFor().catch(() => {})
const railBtn = p.locator('div > button[aria-label]').nth(1)
await railBtn.click({ button: 'right' })
await p.waitForTimeout(400)
check('rail orb right-click opens the picker', await p.locator('[data-accent-swatch]').count() > 0)
await p.keyboard.press('Escape')

// ---------------------------------------------------------------- roster board
await p.evaluate(() => localStorage.setItem('operator.sidebarCollapsed', '0'))
await p.reload({ waitUntil: 'load' })
await p.waitForTimeout(2500)
await p.keyboard.press('Meta+k'); await p.waitForTimeout(500)
await p.keyboard.type('workspace', { delay: 40 }); await p.waitForTimeout(500)
await p.keyboard.press('Enter'); await p.waitForTimeout(1500)
const cardOrb = p.locator('[data-accent-orb]').first()
check('roster card exposes an orb handle', await cardOrb.count() > 0)
await cardOrb.click({ button: 'right' })
await p.waitForTimeout(400)
check('roster dot right-click opens the picker', await p.locator('[data-accent-swatch]').count() > 0)
const ROSTER_PICK = '#38bdf8'
await p.locator(`[data-accent-swatch="${ROSTER_PICK}"]`).click()
await p.waitForTimeout(600)
const rosterPersisted = await p.evaluate(() => JSON.parse(localStorage.getItem('operator.projects') || '[]')
  .flatMap((pr) => (pr.roster || []).map((r) => ({ id: r.id, accent: (r.accent || '').toLowerCase() }))))
check('roster dot pick persisted onto Role.accent', rosterPersisted.some((r) => r.accent === ROSTER_PICK),
  JSON.stringify(rosterPersisted))

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`)
await b.close()
process.exit(failures === 0 ? 0 : 1)
