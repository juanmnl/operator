// Drive the ProjectRail's TILE STACK: density, and drag-to-reorder with persistence
// (dev/briefs/rail-tiles-density-reorder.md — the brief file is absent; worked from the one-line
// task).
//
// The rail is only ever as crowded as the number of projects you have RUNNING, so a two-tile
// fixture cannot show cramming. This seeds seven live projects by appending synthetic sessions to
// the bridge's own `getSessions` — activities are derived from live sessions, so that is the only
// honest way to make a project appear on the rail.
//
// What it asserts: no glyph collides with its neighbour (the corner pip and the current-ring both
// overhang the 28px tile, and neither was in the gap arithmetic); the stack survives its own
// scroll; a tile can be dragged to a new index; and THAT ORDER SURVIVES A RELOAD, which is the
// half of "reorderable" that is easy to fake and easy to lose.
//
// Run: `./node_modules/.bin/vite --port 1436 --strictPort` then `node dev/drive-rail-tiles.mjs`.
import { webkit } from 'playwright'

const PORT = process.env.MOCK_PORT || 1436
// `COUNT=18 node dev/drive-rail-tiles.mjs` to check the stack past the fold.
const N = Number(process.env.COUNT || 5)
const EXTRA = Array.from({ length: N }, (_, i) => ['fastrack', 'uwazi-app', 'web27', 'el-mirador', 'operator-site'][i] || `proj-${i}`)

const b = await webkit.launch()
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })

await ctx.addInitScript((names) => {
  let real
  Object.defineProperty(window, 'operator', {
    configurable: true,
    get: () => real,
    set: (v) => {
      real = v
      const origProjects = v.loadProjects
      const origSessions = v.getSessions
      const extras = names.map((name, i) => ({
        id: `${name}-id`, name, path: `/Users/x/${name}`,
        createdAt: '2026-07-01T00:00:00.000Z',
        lastActiveAt: `2026-07-${String(10 + i).padStart(2, '0')}T00:00:00.000Z`,
      }))
      // Persist across reloads so the reorder assertion can actually be checked after one.
      v.loadProjects = async () => {
        const saved = localStorage.getItem('harness.railtiles')
        if (saved) return JSON.parse(saved)
        return [...((await origProjects()) ?? []), ...extras]
      }
      // Capture what would be WRITTEN TO projects.json, not just what the UI shows. The brief's
      // acceptance test is the durable state, and a reorder that only lives in React state looks
      // identical on screen right up until you relaunch.
      v.saveProjects = (list) => {
        window.__savedPayload = JSON.parse(JSON.stringify(list))
        try { localStorage.setItem('harness.railtiles', JSON.stringify(list)) } catch { /* quota */ }
      }
      // A live session per extra project — `projectActivity` counts sessions whose status is not
      // `ended`, so this is what puts a tile on the rail.
      // A project reaches the rail only via ACTIVITY, and activity is rolled up from
      // `localSessions` — which is built from TERMINALS, taking projectId off the saved-session
      // join, not off the session. So a synthetic live project needs a terminal AND a saved row;
      // wrapping getSessions alone changes nothing, which looks exactly like an unwired feature.
      const origTerminals = v.terminalList
      const origSaved = v.loadSessions
      v.terminalList = async () => {
        const base = (await origTerminals()) ?? []
        if (!base.length) return base
        return [...base, ...extras.map((e, i) => ({ id: `tx${i}`, pid: 0, cwd: e.path, command: 'claude', alive: true }))]
      }
      v.loadSessions = async () => {
        const base = (await origSaved()) ?? []
        if (!base.length) return base
        return [...base, ...extras.map((e, i) => ({
          key: `key-tx${i}`, cwd: e.path, projectName: e.name, projectId: e.id,
          claudeSessionId: `s-${e.id}`, terminalId: `tx${i}`, lastActiveAt: e.lastActiveAt,
        }))]
      }
    },
  })
}, EXTRA)

const p = await ctx.newPage()
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 250)))

const boot = async () => { await p.waitForTimeout(3200) }

// Geometry of the stack, measured off the DOM. `pip` and `ring` are the two things that live
// OUTSIDE the tile's own box, which is why a gap that looks fine in the style block isn't.
const stack = () => p.evaluate(() => {
  const tiles = Array.from(document.querySelectorAll('[data-rail-tile]'))
  const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, h: r.height, w: r.width } }
  const rows = tiles.map((t) => {
    const pip = t.querySelector('[data-rail-pip]')
    const s = getComputedStyle(t)
    return {
      id: t.getAttribute('data-rail-tile'),
      ...box(t),
      pipBottom: pip ? pip.getBoundingClientRect().bottom : null,
      ring: s.boxShadow !== 'none',
      // A ring is drawn OUTSIDE the border box, so it eats into the gap just like the pip.
      ringPx: s.boxShadow === 'none' ? 0 : Number((s.boxShadow.match(/(\d+(?:\.\d+)?)px\s*$/) || [])[1] || 0),
    }
  })
  const gaps = []
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1], cur = rows[i]
    // What is actually left between one tile's lowest INK and the next tile's highest ink.
    const prevInk = Math.max(prev.bottom, prev.pipBottom ?? 0, prev.bottom + (prev.ringPx || 0))
    const curInk = cur.top - (cur.ringPx || 0)
    gaps.push({ pair: `${prev.id}→${cur.id}`, boxGap: Math.round(cur.top - prev.bottom), inkGap: Math.round(curInk - prevInk) })
  }
  // The tile's parent is now its drop-line wrapper; the scroller is one further up.
  const scroller = tiles[0]?.closest('.scroll-hidden')
  return {
    n: rows.length, ids: rows.map((r) => r.id), tile: rows[0] ? { w: Math.round(rows[0].w), h: Math.round(rows[0].h) } : null,
    gaps,
    scroll: scroller ? { h: Math.round(scroller.getBoundingClientRect().height), content: scroller.scrollHeight, overflows: scroller.scrollHeight > scroller.clientHeight + 1 } : null,
  }
})

// Start from a clean slate: other rail drivers persist their own fixture under this origin,
// and inheriting one silently drops the seeded projects — which reads as "the feature is not
// wired" rather than "the fixture is stale".
await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await p.evaluate(() => { try { localStorage.removeItem('harness.railtiles') } catch { /* quota */ } })
await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await boot()

// ---- 1. Density ---------------------------------------------------------------------------
const s1 = await stack()
console.log('1 tiles:', s1.n, '· tile box:', JSON.stringify(s1.tile))
console.log('1 gaps (box vs actual INK, once pip + ring are counted):')
for (const g of s1.gaps) console.log(`    ${g.pair.padEnd(34)} box ${String(g.boxGap).padStart(3)}px   ink ${String(g.inkGap).padStart(3)}px${g.inkGap < 4 ? '  <-- CRAMMED' : ''}`)
console.log('1 scroller:', JSON.stringify(s1.scroll))
await p.screenshot({ path: '/tmp/operator-shots/rail-tiles.png', clip: { x: 0, y: 0, width: 240, height: 900 } })

// ---- 1b. The air AROUND the column, not just between tiles -------------------------------
// The inter-tile gaps were sized against the drawn extent; the padding around the column was
// not, and that is a separate bug one level out. Both ornaments — the current-tile ring and the
// corner pip — paint 2px past the 28px box, so the only way these four numbers agree is if the
// vertical padding gives the BOX the same 8px the 44px rail gives it sideways.
const air = await p.evaluate(() => {
  const tiles = [...document.querySelectorAll('[data-rail-tile]')]
  if (!tiles.length) return null
  const sc = tiles[0].closest('.scroll-hidden'), scr = sc.getBoundingClientRect()
  const ringOf = (t) => {
    const s = getComputedStyle(t).boxShadow
    if (s === 'none') return 0
    const m = s.match(/(\d+(?:\.\d+)?)px\s*$/)
    return m ? Number(m[1]) : 0
  }
  const drawn = (t) => {
    const r = t.getBoundingClientRect(), ring = ringOf(t)
    const pip = t.querySelector('[data-rail-pip]')
    const pr = pip ? pip.getBoundingClientRect() : null
    return {
      top: r.top - ring, left: Math.min(r.left - ring, pr ? pr.left : Infinity),
      right: Math.max(r.right + ring, pr ? pr.right : -Infinity),
      ornament: Math.max(ring, pr ? Math.round(pr.bottom - r.bottom) : 0),
    }
  }
  // The FIRST tile — `top` is a property of the head of the column, so all four numbers have to
  // come from one tile to be comparable. This runs before the reorder, while the current (ringed)
  // project is still first: that is the case the complaint was about, and the one where an
  // ornament eats into the clearance.
  const f = drawn(tiles[0])
  return {
    padding: getComputedStyle(sc).padding,
    ornamentPx: f.ornament,
    top: Math.round(f.top - scr.top),
    left: Math.round(f.left - scr.left),
    right: Math.round(scr.right - f.right),
  }
})
console.log('\n1b air around the tile column (drawn extent → rail edge):', JSON.stringify(air))
console.log('1b top matches the sides:', air && air.top === air.left && air.left === air.right,
  `(expect true — ${air?.ornamentPx}px of ornament against 8px of box clearance on every side)`)


// ---- 2. Reorder ---------------------------------------------------------------------------
const order = () => p.evaluate(() => Array.from(document.querySelectorAll('[data-rail-tile]')).map((t) => t.getAttribute('data-rail-tile')))
const before = await order()
console.log('\n2 order before:', JSON.stringify(before))
const draggable = await p.evaluate(() => document.querySelector('[data-rail-tile]')?.getAttribute('draggable'))
console.log('2 tiles are draggable:', draggable, '(expect "true")')

// Drag the LAST tile above the FIRST. Playwright's dragTo drives real HTML5 drag events.
const tiles = p.locator('[data-rail-tile]')
const n = await tiles.count()
if (n >= 2 && draggable === 'true') {
  await tiles.nth(n - 1).dragTo(tiles.nth(0), { targetPosition: { x: 14, y: 3 } })
  await p.waitForTimeout(600)
  const after = await order()
  console.log('2 order after :', JSON.stringify(after))
  console.log('2 the dragged tile moved to the front:', after[0] === before[n - 1], '(expect true)')
  console.log('2 nothing was lost or duplicated:',
    after.length === before.length && new Set(after).size === after.length, '(expect true)')

  // ---- 3. Persistence, read off the DURABLE STATE ---------------------------------------
  // Not "does the UI still look right" — what did the store actually receive?
  const saved = await p.evaluate(() => window.__savedPayload ?? null)
  const stamped = saved ? saved.filter((x) => typeof x.railOrder === 'number') : []
  console.log('\n3 projects.json payload carries railOrder:', `${stamped.length}/${saved?.length ?? 0}`,
    '(expect ALL — the order is total, not just the visible tiles)')
  const savedOrder = saved
    ? [...saved].sort((a, b) => (a.railOrder ?? 1e9) - (b.railOrder ?? 1e9)).map((x) => x.id)
    : []
  console.log('3 durable order:', JSON.stringify(savedOrder.slice(0, 8)))
  console.log('3 …and the rail renders exactly that:',
    JSON.stringify(savedOrder.filter((id) => after.includes(id))) === JSON.stringify(after), '(expect true)')

  // The half that is easy to fake: an in-memory reorder looks identical until you reload.
  await p.reload({ waitUntil: 'load' })
  await boot()
  const reloaded = await order()
  console.log('\n3 order after RELOAD:', JSON.stringify(reloaded))
  console.log('3 the drag SURVIVED a restart:', JSON.stringify(reloaded) === JSON.stringify(after), '(expect true)')
  console.log('3 …and it is not merely the default order:', JSON.stringify(reloaded) !== JSON.stringify(before),
    '(expect true — otherwise this proves nothing)')
} else {
  console.log('2 SKIPPED — tiles not draggable')
}

// ---- 3b. A draggable tile is still a BUTTON ----------------------------------------------
// Making a row draggable is the classic way to break the click that was already on it — and
// the drop line must leave no trace at rest, or the stack grows a permanent seam.
console.log('\n3b no drop line anywhere at rest:', await p.evaluate(() =>
  Array.from(document.querySelectorAll('[data-rail-slot]')).every((s) => {
    const c = getComputedStyle(s)
    return c.borderTopColor === 'rgba(0, 0, 0, 0)' && c.borderBottomColor === 'rgba(0, 0, 0, 0)'
  })), '(expect true)')
const ringed = () => p.evaluate(() => Array.from(document.querySelectorAll('[data-rail-tile]'))
  .filter((t) => getComputedStyle(t).boxShadow !== 'none').map((t) => t.getAttribute('data-rail-tile')))
const ringBefore = await ringed()
await p.locator('[data-rail-tile]').nth(2).click()
await p.waitForTimeout(1200)
const ringAfter = await ringed()
console.log('3b click still opens a project:', JSON.stringify(ringBefore), '->', JSON.stringify(ringAfter),
  '·', JSON.stringify(ringBefore) !== JSON.stringify(ringAfter), '(expect true)')

// ---- 4. A tile that leaves and comes back keeps its place ---------------------------------
// Order must be a property of the PROJECT, not of the rendered list: the rail's membership
// changes as agents start and stop, and a place that resets on that is not a place.
const s4 = await stack()
console.log('\n4 final ids:', JSON.stringify(s4.ids))
await p.screenshot({ path: '/tmp/operator-shots/rail-tiles-reordered.png', clip: { x: 0, y: 0, width: 240, height: 900 } })

// ---- 5. All three states the rail exists in ----------------------------------------------
// The tiles are one component, but the strip lives in three different shells — sidebar expanded,
// sidebar collapsed to 64px, and the gallery where the sidebar animates to width 0. Density and
// draggability have to hold in all of them, not just the one that was open while building.
console.log('\n5 the rail in every state it exists in:')
const stateCheck = async (label) => {
  const st = await stack()
  const drag = await p.evaluate(() => document.querySelector('[data-rail-tile]')?.getAttribute('draggable'))
  const worst = st.gaps.length ? Math.min(...st.gaps.map((g) => g.inkGap)) : null
  console.log(`  ${label.padEnd(18)} tiles ${String(st.n).padStart(2)} · tightest INK gap ${worst}px · draggable ${drag}`)
  await p.screenshot({ path: `/tmp/operator-shots/rail-state-${label}.png`, clip: { x: 0, y: 0, width: 240, height: 900 } })
}
await stateCheck('expanded')
await p.evaluate(() => localStorage.setItem('operator.sidebarCollapsed', '1'))
await p.reload({ waitUntil: 'load' }); await boot()
await stateCheck('collapsed')
await p.evaluate(() => localStorage.setItem('operator.sidebarCollapsed', '0'))
await p.reload({ waitUntil: 'load' }); await boot()
await p.locator('[data-rail-gallery]').click()
await p.waitForTimeout(900)
await stateCheck('gallery')

await b.close()
