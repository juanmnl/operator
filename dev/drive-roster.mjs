// Drive the Agents/team board (RosterPanel): only LIVE lanes get a full card; idle lanes
// drop to one compact, launchable row each, with the pinned model/effort still readable and
// the full card one ⌄ away. The case that started this: a project with nothing running must
// NOT open on a wall of identical idle cards.
//
// Run against a vite dev server: `npx vite --port 1440` then `node dev/drive-roster.mjs`.
// (Don't default the port from process.env.PORT — the app's own shell exports PORT.)
import { webkit } from 'playwright'
const PORT = process.env.MOCK_PORT || 1440
const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))
// Scope is persisted, so a previous run leaves the app booting INSIDE a project. Clear it so
// this driver always starts at the gallery rather than wherever it last finished.
await p.addInitScript(() => { try { localStorage.removeItem('operator.activeProjectId') } catch { /* quota */ } })
await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await p.waitForTimeout(2600)
await p.keyboard.press('Meta+Shift+O')
await p.waitForTimeout(700)

const board = () => p.evaluate(() => {
  const cards = Array.from(document.querySelectorAll('[data-role-card]'))
  const rows = Array.from(document.querySelectorAll('[data-roster-row]'))
  const labels = Array.from(document.querySelectorAll('div')).map((d) => d.textContent?.trim())
    .filter((t) => /^(Live|Ready) · \d+$/.test(t || ''))
  return {
    cards: cards.map((c) => c.getAttribute('data-role-card')),
    rows: rows.map((r) => ({
      id: r.getAttribute('data-roster-row'),
      h: Math.round(r.getBoundingClientRect().height),
      config: r.querySelector('[data-lane-config]')?.textContent?.trim(),
      launch: !!Array.from(r.querySelectorAll('button')).find((x) => /Launch/.test(x.textContent || '')),
    })),
    labels: [...new Set(labels)],
  }
})

const openRoster = async () => {
  await p.locator('button[aria-label="Open the roster"]').click()
  await p.waitForTimeout(900)
}

// ---- 1. A project with lanes running: cards for those, rows for the rest ---------------
await p.locator('[data-project-card]').filter({ hasText: 'operator' }).first().click()
await p.waitForTimeout(900)
await openRoster()
const mixed = await board()
console.log('1 sections:', JSON.stringify(mixed.labels))
console.log('1 full cards (live only):', JSON.stringify(mixed.cards))
console.log('1 compact rows (idle):', JSON.stringify(mixed.rows))
await p.screenshot({ path: '/tmp/operator-shots/roster-mixed.png' })

// ---- 2. The complaint: a project with NOTHING live ------------------------------------
await p.locator('.drag-region [role="button"]').first().click()
await p.waitForTimeout(450)
await p.locator('[data-switcher-row]').filter({ hasText: 'uwazi_app' }).click()
await p.waitForTimeout(900)
await openRoster()
const quiet = await board()
console.log('2 full cards on an all-idle project:', JSON.stringify(quiet.cards), '(expect [])')
console.log('2 compact rows:', JSON.stringify(quiet.rows))
console.log('2 sections:', JSON.stringify(quiet.labels), '(expect Ready only)')
const heights = await p.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('[data-roster-row]'))
  const add = Array.from(document.querySelectorAll('button')).find((x) => x.textContent?.includes('+ Add agent'))
  return {
    row: rows[0] ? Math.round(rows[0].getBoundingClientRect().height) : null,
    add: add ? Math.round(add.getBoundingClientRect().height) : null,
  }
})
console.log('2 row height == "+ Add agent" height:', heights.row === heights.add, JSON.stringify(heights))
await p.screenshot({ path: '/tmp/operator-shots/roster-all-idle.png' })

// ---- 4. ⌄ expands the SAME RoleCard in place ------------------------------------------
// Back to `operator` — uwazi_app has no Design lane.
await p.locator('.drag-region [role="button"]').first().click()
await p.waitForTimeout(450)
await p.locator('[data-switcher-row]').filter({ hasText: 'operator' }).first().click()
await p.waitForTimeout(900)
await openRoster()
await p.locator('[data-roster-row="design"]').hover()
await p.waitForTimeout(250)
await p.locator('button[aria-label="Configure Design"]').click()
await p.waitForTimeout(600)
const expandedCards = await p.evaluate(() => Array.from(document.querySelectorAll('[data-role-card]')).map((c) => c.getAttribute('data-role-card')))
console.log('4 expanded → full card present:', expandedCards.includes('design'), JSON.stringify(expandedCards))
console.log('4 its row is gone:', (await p.locator('[data-roster-row="design"]').count()) === 0)
// The expanded card must carry the editors the row deliberately omits.
console.log('4 card carries the editors:', await p.evaluate(() => {
  const txt = document.querySelector('[data-role-card="design"]')?.textContent || ''
  return ['Opus', 'High', 'worktree', 'charter'].filter((t) => txt.includes(t))
}))
await p.screenshot({ path: '/tmp/operator-shots/roster-expanded.png' })
await p.locator('button[aria-label="Collapse Design"]').click()
await p.waitForTimeout(500)
console.log('5 collapsed back to a row:', (await p.locator('[data-roster-row="design"]').count()) === 1)

// ---- 6. Batch selection still works off the rows --------------------------------------
await p.locator('[data-roster-row="design"]').click({ position: { x: 140, y: 16 } })
await p.waitForTimeout(400)
const headerBtn = await p.locator('button', { hasText: /Launch \d+ →|Launch all →/ }).first().textContent().catch(() => null)
console.log('6 row select drives the header button:', JSON.stringify(headerBtn))
// ---- 7. ONE LEFT EDGE for the column ---------------------------------------------------
// Section label, each lane's first ink (its orb) and "+ Add agent"'s text must share an x.
// An alignment fix without a measurement is a fix that regresses silently.
const edges = await p.evaluate(() => {
  const L = (el) => (el ? Math.round(el.getBoundingClientRect().left) : null)
  const label = Array.from(document.querySelectorAll('div'))
    .find((d) => /^Ready · \d+$/.test(d.textContent?.trim() || ''))
  const row = document.querySelector('[data-roster-row]')
  const orb = row?.querySelector('[data-accent-orb]')
  const add = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('+ Add agent'))
  // The add button's TEXT edge, not its box edge — it has no orb, so its first ink is the label.
  // INK edges, so borders count: a row draws a 1px border, the section label does not.
  const ink = (el) => {
    if (!el) return null
    const cs = getComputedStyle(el)
    return Math.round(L(el) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft))
  }
  return { label: L(label), orb: L(orb), add: ink(add), rowBox: L(row) }
})
const set = [edges.label, edges.orb, edges.add]
console.log('7 left edges — label / orb / add:', JSON.stringify(edges))
console.log('7 one column edge:', new Set(set).size === 1 && !set.includes(null), `(${set.join(' / ')})`)

// The grip is gone, so nothing invisible reserves space: the orb sits at the row's padding.
console.log('7 no phantom gutter (orb == row box + padding):', await p.evaluate(() => {
  const row = document.querySelector('[data-roster-row]')
  const orb = row?.querySelector('[data-accent-orb]')
  if (!row || !orb) return null
  const cs = getComputedStyle(row)
  const inset = parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft)
  return Math.round(orb.getBoundingClientRect().left - row.getBoundingClientRect().left - inset) === 0
}))

// ---- 3. Idle lanes stay launchable ----------------------------------------------------
const before = await p.evaluate(() => window.__calls.filter((c) => c.fn === 'terminalSpawn').length)
await p.locator('[data-roster-row] button.is-primary').first().click()
await p.waitForTimeout(1200)
const after = await p.evaluate(() => window.__calls.filter((c) => c.fn === 'terminalSpawn').length)
console.log('3 row Launch spawned a session:', after === before + 1, `(${before} → ${after})`)

// ---- 7. A NEW lane opens expanded, not as a launchable row ----------------------------
// Step 3's launch focused the new session's console, so come back to Project Home first.
await openRoster()
// Collapsed it would be a LaneRow, which carries its own Launch — so a lane still named
// "New role" on stock sonnet/high could be launched before its config was ever seen. The
// new card must be the editor, with the config pills sitting next to that Launch.
const newIds = await p.evaluate(() => {
  const before = new Set(Array.from(document.querySelectorAll('[data-role-card],[data-roster-row]'))
    .map((e) => e.getAttribute('data-role-card') || e.getAttribute('data-roster-row')))
  window.__beforeAdd = before
  return [...before]
})
// "+ Add agent" now opens the TEMPLATE MENU (rosters start empty and grow on demand), so a
// blank lane is one level deeper. Both paths are asserted: the menu offers the presets not
// already on the board, and "Blank lane…" still yields an unconfigured lane opened as a card.
await p.locator('[data-add-agent]').click()
await p.waitForTimeout(500)
console.log('7 menu offers unused presets:', JSON.stringify(
  await p.evaluate(() => Array.from(document.querySelectorAll('[data-preset]')).map((e) => e.getAttribute('data-preset')))))
await p.locator('button', { hasText: 'Blank lane…' }).click()
await p.waitForTimeout(700)
const added = await p.evaluate(() => {
  const card = Array.from(document.querySelectorAll('[data-role-card]'))
    .find((c) => !window.__beforeAdd.has(c.getAttribute('data-role-card')))
  const row = Array.from(document.querySelectorAll('[data-roster-row]'))
    .find((r) => !window.__beforeAdd.has(r.getAttribute('data-roster-row')))
  const txt = card?.textContent || ''
  return {
    asCard: card?.getAttribute('data-role-card') ?? null,
    asRow: row?.getAttribute('data-roster-row') ?? null,
    // The editors that make config-before-launch possible, and the Launch they now sit beside.
    carries: ['Sonnet', 'High', 'worktree', 'charter', 'Launch'].filter((t) => txt.includes(t)),
  }
})
console.log('7 new lane opens as a CARD (not a row):', !!added.asCard && !added.asRow, JSON.stringify(added))
console.log('7 lanes before add:', JSON.stringify(newIds))
await p.screenshot({ path: '/tmp/operator-shots/roster-new-lane.png' })

await b.close()
