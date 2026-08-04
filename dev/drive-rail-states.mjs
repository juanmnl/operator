// THE STATES A GEOMETRY SWEEP CANNOT SEE — dev/briefs/2026-08-04-rail-join/BUILD-D1.md §6.
//
// `drive-rail-invariant.mjs` measures painted ink in one steady state. These are the states where
// the strip is asked to do something it might not have a shape for: a group whose membership has
// not arrived yet, a project with no lanes at all, the gallery with nothing live, a roster long
// enough to scroll, and a name too long to fit. Each of them has produced a real defect in some
// version of this strip, and none of them is a contrast measurement.
//
// Run: `node dev/drive-rail-states.mjs` against a vite dev server (MOCK_PORT).
import { webkit } from 'playwright'
import { mkdirSync } from 'node:fs'

const PORT = process.env.MOCK_PORT || 1436
const OUT = '/tmp/operator-shots/rail-d1'
mkdirSync(OUT, { recursive: true })

const fails = []
const notes = []

/** One scene. `fixture` shapes what the mock bridge answers with, so each state is produced by
 *  DATA rather than by poking the DOM into a shape the app would never reach on its own. */
async function scene(name, { projects = [], sessions = [], collapsed = true, slowSessions = false, open = null, act }) {
  const browser = await webkit.launch()
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', deviceScaleFactor: 2 })
  await ctx.addInitScript(([ps, ss, col, slow, openId]) => {
    try {
      localStorage.setItem('operator.theme', 'mission-control-dark')
      localStorage.setItem('operator.sidebarCollapsed', col ? '1' : '0')
      // Which project is OPEN is durable state, so the scene sets it the way the app stores it
      // rather than clicking its way there — the point of each scene is the strip's shape, not
      // the navigation that reached it.
      if (openId) localStorage.setItem('operator.activeProjectId', openId)
      else localStorage.removeItem('operator.activeProjectId')
    } catch { /* quota */ }
    let real
    Object.defineProperty(window, 'operator', {
      configurable: true, get: () => real,
      set: (v) => {
        real = v
        v.loadProjects = async () => ps
        v.saveProjects = () => {}
        v.terminalList = async () => ss.map((s, i) => ({ id: `tx${i}`, pid: 0, cwd: s.cwd, command: 'claude', alive: true }))
        // HYDRATION: projects resolve, sessions arrive later. That ordering is the real one — the
        // store reads are separate awaits — and it is the window in which a group can exist with
        // no members yet.
        v.loadSessions = async () => {
          if (slow) await new Promise((r) => setTimeout(r, 2500))
          return ss.map((s, i) => ({
            key: `key-tx${i}`, cwd: s.cwd, projectName: s.projectName, projectId: s.projectId,
            claudeSessionId: `s-${i}`, terminalId: `tx${i}`, lastActiveAt: '2026-07-20T00:00:00.000Z',
          }))
        }
      },
    })
  }, [projects, sessions, collapsed, slowSessions, open])
  const p = await ctx.newPage()
  p.on('pageerror', (e) => fails.push(`${name} PAGEERROR ${String(e).slice(0, 160)}`))
  await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
  await p.waitForSelector('[data-rail]')
  const out = await act(p)
  await p.screenshot({ path: `${OUT}/state-${name}.png`, clip: { x: 0, y: 0, width: 320, height: 900 } })
  await browser.close()
  return out
}

const proj = (id, name, extra = {}) => ({
  id, name, path: `/Users/x/${name}`,
  createdAt: '2026-07-01T00:00:00.000Z', lastActiveAt: '2026-07-20T00:00:00.000Z', ...extra,
})
const lanes = (n) => Array.from({ length: n }, (_, i) => ({ id: `lane${i}`, name: `Lane ${i + 1}`, accent: '#7ee787' }))

// ---- 1. HYDRATION: sessions resolve AFTER projects ------------------------------------------
// The failure this guards: a group drawn with a hairline and a header and nothing under it,
// because its membership had not arrived. A group must never render empty — with nothing live,
// Home IS the member, which is the same predicate from the other side.
await scene('hydration', {
  projects: [proj('h1', 'operator', { roster: lanes(2) })],
  sessions: [{ cwd: '/Users/x/operator', projectName: 'operator', projectId: 'h1' }],
  slowSessions: true,
  open: 'h1',
  act: async (p) => {
    // Measured DURING the gap, before loadSessions resolves.
    await p.waitForTimeout(600)
    const mid = await p.evaluate(() => ({
      groups: document.querySelectorAll('[data-rail-group]').length,
      empty: [...document.querySelectorAll('[data-rail-group]')]
        .filter((g) => !g.querySelector('[data-rail-session], [data-rail-home], [data-lane-row]')).length,
      homes: document.querySelectorAll('[data-rail-home]').length,
    }))
    notes.push(`hydration (mid-flight): ${mid.groups} group(s), ${mid.empty} empty, ${mid.homes} home row(s)`)
    if (mid.empty) fails.push(`hydration — ${mid.empty} group(s) rendered a header with no members`)
    await p.waitForTimeout(3500)
    const after = await p.evaluate(() => ({
      groups: document.querySelectorAll('[data-rail-group]').length,
      empty: [...document.querySelectorAll('[data-rail-group]')]
        .filter((g) => !g.querySelector('[data-rail-session], [data-rail-home], [data-lane-row]')).length,
      homes: document.querySelectorAll('[data-rail-home]').length,
      orbs: document.querySelectorAll('[data-rail-orb]').length,
    }))
    notes.push(`hydration (settled):    ${after.groups} group(s), ${after.empty} empty, ${after.homes} home, ${after.orbs} orb(s)`)
    if (after.empty) fails.push(`hydration — ${after.empty} group(s) empty after sessions arrived`)
    // Home is the WHOLE point of Option C: it goes when an agent takes its row.
    if (after.orbs && after.homes) fails.push('hydration — Home is still drawn beside a live agent')
    return after
  },
})

// ---- 2. The open project with ZERO lanes -----------------------------------------------------
// A brand-new project: no roster, nothing running. Header + Home + `Add an agent`, and NO orphan
// hairline above a group that is the only one there.
await scene('zero-lanes', {
  projects: [proj('z1', 'brand-new')],
  sessions: [],
  collapsed: false,
  open: 'z1',
  act: async (p) => {
    await p.waitForTimeout(1200)
    const s = await p.evaluate(() => ({
      groups: document.querySelectorAll('[data-rail-group]').length,
      homes: document.querySelectorAll('[data-rail-home]').length,
      lanes: document.querySelectorAll('[data-lane-row]').length,
      add: !!document.querySelector('[data-rail-add-lane]'),
      hairlines: [...document.querySelectorAll('[data-rail-group]')]
        .filter((g) => getComputedStyle(g).boxShadow !== 'none').length,
    }))
    notes.push(`zero-lanes: ${s.groups} group, ${s.homes} home, ${s.lanes} lane rows, add=${s.add}, ${s.hairlines} hairline(s)`)
    if (s.homes !== 1) fails.push(`zero-lanes — expected exactly 1 Home row, got ${s.homes}`)
    if (!s.add) fails.push('zero-lanes — no "Add an agent" in a project with no lanes')
    if (s.hairlines) fails.push(`zero-lanes — ${s.hairlines} orphan hairline(s) on a single group`)
    return s
  },
})

// ---- 3. The GALLERY with nothing live --------------------------------------------------------
// No open project and nothing running: the strip is foot-only. It must not read as broken, and
// the eight app controls must still be there — that is the ⌘B defect from the other direction.
await scene('gallery-empty', {
  projects: [proj('g1', 'quiet')],
  sessions: [],
  act: async (p) => {
    await p.waitForTimeout(1200)
    await p.click('[data-rail-gallery]')
    await p.waitForTimeout(600)
    const s = await p.evaluate(() => ({
      width: Math.round(document.querySelector('[data-rail]').getBoundingClientRect().width),
      groups: document.querySelectorAll('[data-rail-group]').length,
      foot: [
        'data-rail-agents', 'data-rail-usage', 'data-rail-gallery', 'data-rail-open-folder',
        'data-rail-folder-prefs', 'data-rail-global-prefs', 'data-rail-prefs', 'data-rail-theme',
      ].filter((a) => document.querySelector(`[${a}]`)).length,
    }))
    notes.push(`gallery: strip ${s.width}px, ${s.groups} group(s), ${s.foot}/8 foot controls`)
    if (s.width !== 60) fails.push(`gallery — strip is ${s.width}px, expected the collapsed 60`)
    if (s.foot !== 8) fails.push(`gallery — ${s.foot}/8 foot controls`)
    return s
  },
})

// ---- 4. TWENTY lanes, expanded ----------------------------------------------------------------
// The list scrolls; the foot stays pinned and does not get pushed off the bottom.
await scene('twenty-lanes', {
  projects: [proj('t1', 'crowded', { roster: lanes(20) })],
  sessions: [],
  collapsed: false,
  open: 't1',
  act: async (p) => {
    await p.waitForTimeout(1200)
    const s = await p.evaluate(() => {
      const rail = document.querySelector('[data-rail]').getBoundingClientRect()
      const foot = document.querySelector('[data-rail-foot]').getBoundingClientRect()
      const scroller = document.querySelector('[data-rail] .scroll-hidden')
      return {
        lanes: document.querySelectorAll('[data-lane-row]').length,
        scrolls: scroller.scrollHeight > scroller.clientHeight + 1,
        footInside: foot.bottom <= rail.bottom + 0.5 && foot.top >= rail.top,
        firstHeaderVisible: (() => {
          const h = document.querySelector('[data-rail-project-header]')
          return !!h && h.getBoundingClientRect().top >= rail.top - 0.5
        })(),
      }
    })
    notes.push(`twenty-lanes: ${s.lanes} lane rows, scrolls=${s.scrolls}, foot pinned inside=${s.footInside}, header visible=${s.firstHeaderVisible}`)
    if (s.lanes !== 20) fails.push(`twenty-lanes — ${s.lanes} lane rows, expected 20`)
    if (!s.scrolls) fails.push('twenty-lanes — the member list did not become scrollable')
    if (!s.footInside) fails.push('twenty-lanes — the foot was pushed outside the strip')
    // A group taller than the scroll box top-aligns, which must mean its HEADER — scrolling the
    // name of the thing you just opened off the top is the failure the scroll-into-view exists to
    // prevent, not one it is allowed to cause.
    if (!s.firstHeaderVisible) fails.push('twenty-lanes — the open group scrolled past its own header')
    return s
  },
})

// ---- 5. A 40-CHARACTER project name -----------------------------------------------------------
// The ellipsis must FIRE. It could not before: the name was cut to six characters in JS, so CSS
// had nothing left to truncate and `OPERATOR` rendered as `OPERAT` — indistinguishable from a
// project actually called that.
const LONG = 'a-very-long-project-name-that-never-ends'
await scene('long-name', {
  projects: [proj('l1', LONG)],
  sessions: [],
  open: 'l1',
  act: async (p) => {
    await p.waitForTimeout(1200)
    const s = await p.evaluate((long) => {
      const h = document.querySelector('[data-rail-project-header]')
      return {
        text: h.textContent,
        full: h.textContent === long,
        clipped: h.scrollWidth > h.clientWidth,
        title: h.getAttribute('title'),
        overflow: getComputedStyle(h).textOverflow,
      }
    }, LONG)
    notes.push(`long-name: rendered "${s.text.slice(0, 20)}…" full=${s.full} clipped=${s.clipped} textOverflow=${s.overflow}`)
    // The DOM must hold the WHOLE name — that is what makes the ellipsis reachable and what the
    // six-character clip destroyed.
    if (!s.full) fails.push(`long-name — the header holds "${s.text}", not the whole name`)
    if (!s.clipped) fails.push('long-name — the name is not overflowing, so the ellipsis cannot be firing')
    if (s.overflow !== 'ellipsis') fails.push(`long-name — textOverflow is ${s.overflow}`)
    if (!s.title?.includes(LONG)) fails.push('long-name — the tooltip does not carry the whole name')
    return s
  },
})

console.log('\nNOTES')
for (const n of notes) console.log(`  · ${n}`)
console.log(`\nShots → ${OUT}`)
if (fails.length) {
  console.log(`\n${fails.length} FAILURE(S)`)
  for (const f of fails) console.log(`  ✗ ${f}`)
  process.exit(1)
}
console.log('\nAll state checks passed.')
