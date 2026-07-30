// Drive the ACTIVE / PREVIOUS shelf split in the gallery (dev/briefs/shelf-2-partition-gallery.md):
// archive with undo, the collapsed Previous section and its rows, the filter across BOTH
// shelves, restore, persistence across a reload, and click-again-to-confirm on Forget.
//
// Run against a vite dev server: `npx vite --port 1440` then `node dev/drive-gallery-shelf.mjs`.
import { webkit } from 'playwright'

const PORT = process.env.MOCK_PORT || 1440
// The fixture ships 3 projects; the filter only appears past 8, and the real store has 19.
// Pad to 11 so the threshold is reachable — a harness that can't reach it can't test it.
const PAD = 8

const b = await webkit.launch()
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })

// mock-bridge's saveProjects is a noop and loadProjects always returns the fixture, so a
// reload would wipe anything the app wrote and "archive it, restart, still shelved" would
// be untestable. Wrap both through a localStorage key — the stand-in for projects.json —
// and pad the list on first load. The mock assigns window.operator once, so intercept the
// assignment rather than racing it.
await ctx.addInitScript((pad) => {
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
        const base = (await origLoad()) ?? []
        const now = Date.now()
        const extra = Array.from({ length: pad }, (_, i) => ({
          id: `pad-${i}`,
          path: `/Users/jane/Developer/pad-${i}`,
          name: `pad-${i}`,
          createdAt: new Date(now - 90 * 86400000).toISOString(),
          // Staggered so the recency ordering has something to order.
          lastActiveAt: new Date(now - (i + 2) * 86400000).toISOString(),
          roster: [],
        }))
        return [...base, ...extra]
      }
      v.saveProjects = (list) => { try { localStorage.setItem('harness.projects', JSON.stringify(list)) } catch { /* quota */ } }
    },
  })
}, PAD)

const p = await ctx.newPage()
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 250)))
p.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 200)) })

const gallery = async () => {
  await p.keyboard.press('Meta+Shift+O')
  await p.waitForTimeout(700)
}
const shelfState = () => p.evaluate(() => ({
  heading: document.querySelector('h2')?.textContent?.trim(),
  labels: Array.from(document.querySelectorAll('[data-shelf-label]')).map((e) => e.textContent.trim()),
  toggle: document.querySelector('[data-shelf-toggle]')?.textContent?.trim() ?? null,
  cards: document.querySelectorAll('[data-project-card]').length,
  rows: document.querySelectorAll('[data-previous-row]').length,
  noMatch: !!Array.from(document.querySelectorAll('div')).find((d) => d.childElementCount === 0 && d.textContent === 'No match.'),
}))
const menu = async (name) => {
  await p.locator(`[data-project-card] >> nth=0`).first().hover() // wake the grid
  await p.locator(`button[aria-label="${name} actions"]`).first().click()
  await p.waitForTimeout(300)
}

await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await p.waitForTimeout(2800)
await gallery()

// ---- 1. Nothing shelved → zero new chrome -------------------------------------------
const s1 = await shelfState()
console.log('1 at rest:', JSON.stringify(s1))
console.log('1 no section chrome:', s1.labels.length === 0 && s1.toggle === null && s1.rows === 0, '(expect true)')
console.log('1 filter appears past 8:', await p.locator('[data-gallery-filter]').count(), '(expect 1)')

// ---- 2. Archive, with an undo toast --------------------------------------------------
await menu('pad-0')
await p.getByText('Archive project', { exact: true }).first().click()
await p.waitForTimeout(600)
const s2 = await shelfState()
console.log('2 after archive:', JSON.stringify(s2))
console.log('2 headline counts ACTIVE only:', s2.heading, `(expect "Projects · ${2 + PAD}")`)
console.log('2 sections appeared, previous COLLAPSED:', s2.labels.length === 1 && s2.rows === 0, '(expect true)')
console.log('2 toast:', await p.evaluate(() => {
  const t = Array.from(document.querySelectorAll('div')).find((d) => d.textContent?.startsWith('Shelved pad-0') && d.querySelector('button'))
  return t ? { text: t.textContent.slice(0, 40), undo: !!Array.from(t.querySelectorAll('button')).find((x) => x.textContent.trim() === 'Undo') } : null
}))

// ---- 3. Expand → the row, and its geometry ------------------------------------------
await p.locator('[data-shelf-toggle]').click()
await p.waitForTimeout(400)
const row = await p.evaluate(() => {
  const r = document.querySelector('[data-previous-row]')
  if (!r) return null
  const cs = getComputedStyle(r)
  return {
    h: Math.round(r.getBoundingClientRect().height),
    name: r.querySelector('[data-previous-name]')?.textContent,
    path: r.querySelector('[data-previous-path]')?.textContent,
    ran: r.querySelector('[data-previous-ran]')?.textContent,
    border: cs.borderTopWidth, radius: cs.borderTopLeftRadius,
  }
})
console.log('3 previous row:', JSON.stringify(row), '(expect h 30, "last ran …", no border)')

// Hover reveals Restore + ⋯ with NO reflow, and goes 0 → 1 (never a partial fade).
const before = await p.evaluate(() => ({
  h: Math.round(document.querySelector('[data-previous-row]').getBoundingClientRect().height),
  o: getComputedStyle(document.querySelector('[data-previous-restore]')).opacity,
}))
await p.locator('[data-previous-row]').first().hover()
await p.waitForTimeout(300)
const after = await p.evaluate(() => ({
  h: Math.round(document.querySelector('[data-previous-row]').getBoundingClientRect().height),
  o: getComputedStyle(document.querySelector('[data-previous-restore]')).opacity,
}))
console.log('4 restore hidden→shown:', before.o, '→', after.o, '· no reflow:', before.h === after.h)

// ---- 5. The filter searches BOTH shelves --------------------------------------------
await p.locator('[data-shelf-toggle]').click() // collapse it again first
await p.waitForTimeout(300)
await p.locator('[data-gallery-filter]').fill('pad-0')
await p.waitForTimeout(400)
const s5 = await shelfState()
console.log('5 query "pad-0" (a SHELVED project):', JSON.stringify(s5))
console.log('5 previous auto-expanded despite being collapsed:', s5.rows === 1, '(expect true)')
await p.locator('[data-gallery-filter]').fill('operator')
await p.waitForTimeout(400)
console.log('5 query "operator":', JSON.stringify(await shelfState()))
await p.locator('[data-gallery-filter]').fill('zzzz')
await p.waitForTimeout(400)
const s5c = await shelfState()
console.log('5 query "zzzz" → No match.:', s5c.noMatch, '(expect true)')
await p.locator('[data-gallery-filter]').fill('')
await p.waitForTimeout(400)

// ---- 6. Restore from the row ---------------------------------------------------------
await p.locator('[data-shelf-toggle]').click()
await p.waitForTimeout(300)
await p.locator('[data-previous-row]').first().hover()
await p.locator('[data-previous-restore]').first().click()
await p.waitForTimeout(600)
const s6 = await shelfState()
console.log('6 after restore:', JSON.stringify(s6))
console.log('6 chrome gone again:', s6.labels.length === 0 && s6.toggle === null, '(expect true)')

// ---- 7. Archive survives a reload ----------------------------------------------------
await menu('pad-1')
await p.getByText('Archive project', { exact: true }).first().click()
await p.waitForTimeout(700)
console.log('7 written to the store:', await p.evaluate(() => {
  const list = JSON.parse(localStorage.getItem('harness.projects') || '[]')
  return list.filter((x) => x.archivedAt).map((x) => x.name)
}), '(expect ["pad-1"])')
await p.reload({ waitUntil: 'load' })
await p.waitForTimeout(2800)
await gallery()
const s7 = await shelfState()
console.log('7 after reload:', JSON.stringify(s7))
console.log('7 still shelved:', s7.toggle?.startsWith('Previous · 1'), '(expect true)')

// ---- 8. Forget now takes two clicks, and can be undone -------------------------------
await menu('pad-2')
await p.getByText('Forget project', { exact: true }).first().click()
await p.waitForTimeout(300)
const armed = await p.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button')).find((x) => x.textContent?.startsWith('Forget project'))
  return { label: btn?.textContent?.trim(), stillThere: !!Array.from(document.querySelectorAll('[data-project-card]')).find((c) => c.textContent.includes('pad-2')) }
})
console.log('8 first click ARMS, deletes nothing:', JSON.stringify(armed))
await p.getByText('Forget project — click again').first().click()
await p.waitForTimeout(600)
console.log('8 second click deleted it:', await p.evaluate(() => !Array.from(document.querySelectorAll('[data-project-card]')).find((c) => c.textContent.includes('pad-2'))), '(expect true)')
const undo = p.locator('button', { hasText: /^Undo$/ }).first()
console.log('8 undo offered:', await undo.count())
await undo.click()
await p.waitForTimeout(700)
console.log('8 undo restored it:', await p.evaluate(() => !!Array.from(document.querySelectorAll('[data-project-card]')).find((c) => c.textContent.includes('pad-2'))), '(expect true)')

await p.screenshot({ path: '/tmp/operator-shots/shelf-gallery.png' })

// ---- 9. AUTO-LIFT: a shelved project with a live session stays ACTIVE ----------------
// The correctness keystone. Stamp archivedAt on EVERY project in the durable store and
// reload: the two with running sessions (operator, el-encanto) must still draw as cards,
// because a running agent hiding inside a collapsed section is the failure this guards.
await p.evaluate(() => {
  const at = new Date().toISOString()
  const list = JSON.parse(localStorage.getItem('harness.projects') || '[]')
  localStorage.setItem('harness.projects', JSON.stringify(list.map((x) => ({ ...x, archivedAt: at }))))
})
await p.reload({ waitUntil: 'load' })
await p.waitForTimeout(2800)
await gallery()
const s9 = await shelfState()
console.log('9 all records shelved:', JSON.stringify(s9))
console.log('9 the live ones stayed on ACTIVE:', await p.evaluate(() =>
  Array.from(document.querySelectorAll('[data-project-card] [data-card-name]')).map((e) => e.textContent)),
  '(expect the two projects with running sessions)')
// …and its menu offers RESTORE, not Archive: the verb reads off the record, not off which
// list happened to draw it.
await menu('operator')
console.log('9 lifted card offers restore:', await p.evaluate(() =>
  Array.from(document.querySelectorAll('button')).map((x) => x.textContent.trim())
    .filter((t) => /^(Archive project|Restore to active)$/.test(t))),
  '(expect ["Restore to active"])')

await b.close()
