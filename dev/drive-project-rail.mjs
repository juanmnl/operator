// Drive the PERSISTENT project rail (dev/briefs/shelf-5-project-rail.md): the 44px strip
// outboard of the sidebar that never goes away.
//
// The assertions that matter: it persists at the gallery / expanded / collapsed; membership is
// what you have OPEN plus the current project (NOT the full active shelf — that's ALSO ACTIVE,
// and two copies of one list is what this split avoids); the tile's colour and acronym are
// IDENTITY, stable across reloads and status changes; the tile is a rounded SQUARE while a
// session orb is a circle; state lives in a corner pip that is absent when idle; and the
// current project is ringed with a box-shadow rather than a border.
//
// Run against a vite dev server: `npx vite --port 1440` then `node dev/drive-project-rail.mjs`.
import { webkit } from 'playwright'

const PORT = process.env.MOCK_PORT || 1440
const b = await webkit.launch()
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })

// Durable-store stand-in, so a phase can shelve a project and reload into it.
await ctx.addInitScript(() => {
  let real
  Object.defineProperty(window, 'operator', {
    configurable: true,
    get: () => real,
    set: (v) => {
      real = v
      const origLoad = v.loadProjects
      v.loadProjects = async () => {
        const s = localStorage.getItem('harness.projects')
        return s ? JSON.parse(s) : ((await origLoad()) ?? [])
      }
      v.saveProjects = (list) => { try { localStorage.setItem('harness.projects', JSON.stringify(list)) } catch { /* quota */ } }
    },
  })
})

const p = await ctx.newPage()
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 250)))
p.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 200)) })

const boot = async () => { await p.waitForTimeout(3000) }
const rail = () => p.evaluate(() => {
  const tiles = Array.from(document.querySelectorAll('[data-rail-tile]'))
  const strip = document.querySelector('[data-rail-gallery]')?.closest('div[style*="44px"]')
  return {
    ids: tiles.map((t) => t.getAttribute('data-rail-tile')),
    initials: tiles.map((t) => t.querySelector('[data-rail-initials]')?.textContent),
    labels: tiles.map((t) => t.getAttribute('aria-label')),
    colors: tiles.map((t) => t.getAttribute('data-rail-accent')),
    // The tint/border/ink the declared accent actually painted, so the attribute can't drift
    // from what's on screen.
    painted: tiles.map((t) => {
      const s = getComputedStyle(t)
      return { bg: s.backgroundColor, border: s.borderTopColor, ink: s.color, radius: s.borderTopLeftRadius }
    }),
    pips: tiles.filter((t) => t.querySelector('[data-rail-pip]')).map((t) => t.getAttribute('data-rail-tile')),
    ringed: tiles.filter((t) => getComputedStyle(t).boxShadow !== 'none').map((t) => t.getAttribute('data-rail-tile')),
    width: strip ? Math.round(strip.getBoundingClientRect().width) : null,
    left: strip ? Math.round(strip.getBoundingClientRect().left) : null,
    height: strip ? Math.round(strip.getBoundingClientRect().height) : null,
    gallery: !!document.querySelector('[data-rail-gallery]'),
  }
})

await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await boot()

// ---- 1. It is there, showing what's OPEN ----------------------------------------------
const s1 = await rail()
console.log('1 rail:', JSON.stringify({ w: s1.width, left: s1.left, h: s1.height, ids: s1.ids, initials: s1.initials, gallery: s1.gallery }))
console.log('1 44px strip at the left edge, full height:', s1.width === 44 && s1.height >= 880, '(expect true)')
console.log('1 OPEN projects only — the idle one is NOT here:', !s1.ids.some((i) => i.startsWith('uwazi')), '(expect true: it is in ALSO ACTIVE, not the rail)')
console.log('1 current is RINGED:', JSON.stringify(s1.ringed))
console.log('1 a tile is a rounded SQUARE, a session orb is a circle:', JSON.stringify(s1.painted[0]))
console.log('1 pips only where something is happening:', JSON.stringify(s1.pips), `(of ${s1.ids.length} tiles)`)
console.log('1 all-projects control at the bottom:', s1.gallery, '(expect true)')
await p.screenshot({ path: '/tmp/operator-shots/project-rail.png' })

// ---- 2. Identity: colour + acronym, stable and not derived from status -----------------
const before = s1.colors
await p.reload({ waitUntil: 'load' })
await boot()
const s2 = await rail()
console.log('2 colours survive a restart:', JSON.stringify(s2.colors) === JSON.stringify(before), '(expect true)')
// Drive a phase change on a live lane: the PIP may change, identity must not move.
await p.evaluate(() => window.__mockPhase('s-op', { phase: 'running', lastToolName: null }))
await p.waitForTimeout(700)
const s2b = await rail()
console.log('2 identity is not status:', JSON.stringify(s2b.colors) === JSON.stringify(s2.colors)
  && JSON.stringify(s2b.initials) === JSON.stringify(s2.initials), '(expect true)')
console.log('2 colours:', JSON.stringify(s2b.colors), '· acronyms:', JSON.stringify(s2b.initials))
console.log('2 tint/hairline/ink all derive from it:', JSON.stringify(s2b.painted[0]))

// ---- 3. It persists in every state ----------------------------------------------------
await p.keyboard.press('Meta+Shift+O')
await p.waitForTimeout(800)
const atGallery = await rail()
console.log('3 at the GALLERY — width:', atGallery.width, '· tiles:', atGallery.ids.length, '· nothing ringed:', atGallery.ringed.length === 0)
const s3 = await p.evaluate(() => {
  const strip = document.querySelector('[data-rail-gallery]').closest('div[style*="44px"]')
  const heading = document.querySelector('h2')?.getBoundingClientRect()
  return { railRight: Math.round(strip.getBoundingClientRect().right), title: heading ? Math.round(heading.left) : null }
})
console.log('3 the gallery still clears the rail:', s3.title > s3.railRight, `(title x=${s3.title} > rail right x=${s3.railRight})`)
await p.screenshot({ path: '/tmp/operator-shots/project-rail-gallery.png' })

// Back into a project, then collapse the sidebar to the 64px variant.
await p.locator('[data-rail-tile]').first().click()
await p.waitForTimeout(900)
console.log('3 clicking a tile entered its project:', await p.evaluate(() =>
  document.querySelector('[data-switcher-trigger] > span')?.textContent?.trim()))
await p.evaluate(() => localStorage.setItem('operator.sidebarCollapsed', '1'))
await p.reload({ waitUntil: 'load' })
await boot()
const collapsed = await rail()
console.log('3 with the sidebar COLLAPSED — width:', collapsed.width, '· tiles:', collapsed.ids.length)
console.log('3 identical in all three states:', collapsed.width === 44 && collapsed.ids.length === atGallery.ids.length, '(expect true)')
console.log('3 no duplicate cluster in the 64px rail:', await p.locator('[data-rail-project]').count(), '(expect 0)')
await p.screenshot({ path: '/tmp/operator-shots/project-rail-collapsed.png' })
await p.evaluate(() => localStorage.setItem('operator.sidebarCollapsed', '0'))

// ---- 4. Hover card ---------------------------------------------------------------------
await p.reload({ waitUntil: 'load' })
await boot()
await p.locator('[data-rail-tile]').nth(1).hover()
await p.waitForTimeout(400)
console.log('4 hover card:', await p.evaluate(() => {
  const c = Array.from(document.querySelectorAll('div')).find((d) => d.style.position === 'fixed' && d.style.zIndex === '60')
  return c ? c.textContent.trim() : null
}))

// ---- 5. A running agent is never hidden, even in a shelved project ----------------------
// Membership is liveness, not the shelf: archiving a project with something live must NOT
// take it off the rail.
await p.evaluate(() => {
  const base = JSON.parse(localStorage.getItem('operator.projects') || '[]')
  localStorage.setItem('harness.projects', JSON.stringify(base.map((x) => (x.name === 'el-encanto'
    ? { ...x, archivedAt: new Date().toISOString() }
    : x))))
})
await p.reload({ waitUntil: 'load' })
await boot()
const s5 = await rail()
console.log('5 a SHELVED but live project stays on the rail:', JSON.stringify(s5.ids), '(expect el-encanto still here)')
console.log('5 …with its identity intact:', s5.ids.every((id, i) => s2b.colors[s2b.ids.indexOf(id)] === s5.colors[i]), '(expect true)')

// ---- 6. Nothing open at all → the rail is still there, carrying just the way out --------
// `?empty=1` is a virgin app: no projects, no saved sessions, no live ptys. It's the only
// reachable "nothing open" state — __mockPhase re-emits from the pristine fixture, so it
// can't end more than one session at a time, and ending a transcript session wouldn't kill
// its pty anyway.
await p.goto(`http://localhost:${PORT}/dev/mock.html?empty=1`, { waitUntil: 'load' })
await boot()
const s6 = await rail()
console.log('6 virgin app — tiles:', s6.ids.length, '(expect 0) · rail still present:', s6.width === 44, '· way out still there:', s6.gallery)
await p.screenshot({ path: '/tmp/operator-shots/project-rail-empty.png' })

await b.close()
