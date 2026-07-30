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
  scoped: document.querySelector('[data-switcher-trigger] > span')?.textContent?.trim() ?? null,
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

await p.locator('[data-previous-chip]').click()
await p.waitForTimeout(700)
const s3 = await state()
console.log('3 clicking it restores — chip gone:', !s3.chip, '(expect true)')
console.log('3 …and the record was cleared:', JSON.stringify(s3.shelved), '(expect [])')

// The section that used to live under the lanes is gone for good.
console.log('4 no ALSO ACTIVE section left:', await p.locator('[data-ambient-header], [data-ambient-row]').count(), '(expect 0)')
console.log('4 …and its localStorage key is unused:', await p.evaluate(() => localStorage.getItem('operator.ambientCollapsed')), '(expect null)')

await b.close()
