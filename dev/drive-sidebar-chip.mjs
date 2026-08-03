// The `previous` chip in the sidebar header — the one cross-project control left in the
// sidebar after the ALSO ACTIVE section was removed.
//
// You can browse into a SHELVED project from the gallery's Previous shelf, and without the
// chip nothing in the sidebar says so, nor offers a way back. Restoring is the chip's whole
// job, so the assertion is: it appears only for a shelved project, and clicking it clears
// `archivedAt` in the durable store.
//
// (Was dev/drive-sidebar-ambient.mjs, whose other six scenarios covered the removed section.
// The "no duplicate cluster in the 64px rail" check it also carried now lives in
// dev/drive-project-rail.mjs step 3.)
//
// Run against a vite dev server: `npx vite --port 1440` then `node dev/drive-sidebar-chip.mjs`.
import { webkit } from 'playwright'

const PORT = process.env.MOCK_PORT || 1440
const b = await webkit.launch()
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })

// Durable-store stand-in: the mock's saveProjects is a noop and loadProjects always returns
// the fixture, so a phase can't otherwise write `archivedAt` and reload into it.
await ctx.addInitScript(() => {
  let real
  Object.defineProperty(window, 'operator', {
    configurable: true,
    get: () => real,
    set: (v) => {
      real = v
      const orig = v.loadProjects
      v.loadProjects = async () => {
        const s = localStorage.getItem('harness.projects')
        return s ? JSON.parse(s) : ((await orig()) ?? [])
      }
      v.saveProjects = (list) => { try { localStorage.setItem('harness.projects', JSON.stringify(list)) } catch { /* quota */ } }
    },
  })
})

const p = await ctx.newPage()
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 250)))
const boot = async () => { await p.waitForTimeout(3000) }
const state = () => p.evaluate(() => ({
  // The switcher trigger this used to read went with the switcher; the header's name span is
  // what carries the scope now, so the field was silently reporting null on every run.
  scoped: document.querySelector('[data-sidebar-project-name]')?.textContent?.trim() ?? null,
  chip: !!document.querySelector('[data-previous-chip]'),
  shelved: JSON.parse(localStorage.getItem('harness.projects') || '[]').filter((x) => x.archivedAt).map((x) => x.name),
}))

await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await boot()
console.log('1 an ACTIVE project shows no chip:', JSON.stringify(await state()), '(expect chip false)')

// Shelve the project we're standing in, then reload into it.
await p.evaluate(() => {
  const base = JSON.parse(localStorage.getItem('operator.projects') || '[]')
  localStorage.setItem('harness.projects', JSON.stringify(base.map((x) => (x.name === 'operator'
    ? { ...x, archivedAt: new Date().toISOString() }
    : x))))
})
await p.reload({ waitUntil: 'load' })
await boot()
const s2 = await state()
console.log('2 inside a SHELVED project the chip appears:', JSON.stringify(s2), '(expect chip true)')

// The chip sits INSIDE the header, and the header is a way home now (2026-08-03) — so the
// chip has to stop its own click. Un-shelving is not a request to navigate: restore from
// inside an agent and you must still be in that agent. Focus one first, because at Project
// Home the header is inert and the trap wouldn't fire.
await p.locator('[data-session-row]').first().click()
await p.waitForTimeout(1000)
// The pty stays mounted behind every surface, so `.xterm` can't tell you which view is up —
// the toolbar header can.
const view = () => p.evaluate(() => document.querySelector('[data-toolbar-header]')?.getAttribute('data-toolbar-header'))
const inSession = await p.evaluate(() => ({
  view: document.querySelector('[data-toolbar-header]')?.getAttribute('data-toolbar-header'),
  headerRole: document.querySelector('[data-sidebar-project]')?.getAttribute('role'),
  headerDisabled: document.querySelector('[data-sidebar-project]')?.getAttribute('aria-disabled'),
}))
console.log('3 in an agent, header is live:', JSON.stringify(inSession), '(expect view=session, role button, disabled false)')

await p.locator('[data-previous-chip]').click()
await p.waitForTimeout(700)
const s3 = await state()
console.log('3 clicking it restores — chip gone:', !s3.chip, '(expect true)')
console.log('3 …and the record was cleared:', JSON.stringify(s3.shelved), '(expect [])')
console.log('3 …and it did NOT navigate home:', (await view()) === 'session', `(view=${await view()}, expect session)`)

// The section that used to live under the lanes is gone for good.
console.log('4 no ALSO ACTIVE section left:', await p.locator('[data-ambient-header], [data-ambient-row]').count(), '(expect 0)')
console.log('4 …and its localStorage key is unused:', await p.evaluate(() => localStorage.getItem('operator.ambientCollapsed')), '(expect null)')

// --- 5. THE KEYBOARD PATH -------------------------------------------------------
// The chip's whole job is unreachable without a mouse if this is wrong, and it was: while it
// sat INSIDE the header target, the header's bubble-phase `onKeyDown` ran first and
// preventDefault() cancelled the button's own activation — so Enter navigated home and did NOT
// un-shelve. Both of the chip's jobs failed at once. It is a SIBLING now, so the keydown never
// reaches the header at all.
await p.evaluate(() => {
  const base = JSON.parse(localStorage.getItem('operator.projects') || '[]')
  localStorage.setItem('harness.projects', JSON.stringify(base.map((x) => (x.name === 'operator'
    ? { ...x, archivedAt: new Date().toISOString() }
    : x))))
})
await p.reload({ waitUntil: 'load' })
await boot()
// Into a session, so the header is a live control and the trap is armed — then ⌘J to CHAT,
// because with the Console up xterm's helper textarea owns every Tab and the sidebar is not
// keyboard-reachable at all. Chat is where a keyboard user in a live agent reaches this row.
await p.locator('[data-session-row]').first().click()
await p.waitForTimeout(1000)
await p.locator('button[title="Chat view"]').click()   // not ⌘J: that toggles, and a toggle's
await p.waitForTimeout(900)                            // outcome depends on the persisted layout
// Shoot the header while shelved: the chip is a sibling now, so it has to line up with the
// NAME's band rather than centring on the two-line block (align ink, not boxes).
{
  const box = await p.locator('[data-sidebar-project]').boundingBox()
  await p.screenshot({ path: '/tmp/chip-header-shelved.png', clip: { x: box.x - 12, y: box.y - 10, width: box.width + 90, height: box.height + 20 } })
}
console.log('5 shelved + in an agent:', JSON.stringify({ ...(await state()), view: await view() }))

// Tab, don't .focus() — `:focus-visible` is not guaranteed to match programmatic focus.
// Reset the focus NAVIGATION STARTING POINT to a control before the sidebar. `body.focus()`
// does not do this — WebKit keeps walking from wherever focus last was, and if that was a
// terminal, xterm swallows every Tab (it sends \t to the pty) and the loop never moves.
await p.evaluate(() => document.querySelector('[data-rail-gallery]')?.focus())
let tabs = 0
for (; tabs < 25; tabs++) {
  await p.keyboard.press('Tab')
  if (await p.evaluate(() => document.activeElement?.hasAttribute('data-previous-chip'))) break
}
const chipFocus = await p.evaluate(() => {
  const el = document.querySelector('[data-previous-chip]')
  return { isActive: document.activeElement === el, shadow: el ? getComputedStyle(el).boxShadow : null }
})
console.log('5 chip reachable by Tab:', chipFocus.isActive, `(${tabs + 1} presses)`)
console.log('5 chip focus is VISIBLE:', chipFocus.shadow !== 'none' && !!chipFocus.shadow, `(box-shadow: ${chipFocus.shadow})`)
await p.keyboard.press('Enter')
await p.waitForTimeout(800)
const s5 = await state()
console.log('5 Enter UN-SHELVES:', !s5.chip && s5.shelved.length === 0, JSON.stringify(s5))
console.log('5 …and does NOT navigate:', (await view()) === 'session', `(view=${await view()}, expect session)`)

await b.close()
