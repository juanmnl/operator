// THE FOLD IS GONE — asserted against the rendered strip, not against the source.
// dev/briefs/2026-08-04-rail-fold.md
//
// `FOLD = 4` was a CONSTANT PRETENDING TO BE A MEASUREMENT: a group with five live agents drew
// `O C D Q` and a `+1` while the lower half of the rail was empty. Nothing was gained by hiding
// that agent, and the `+1` that counted it called `onOpenProject` — a control that looked like an
// expander and performed navigation.
//
// This driver seeds what the bug needed and the shipped fixtures never had: SEVERAL live agents in
// ONE project. `drive-rail-invariant.mjs` gives each synthetic project exactly one, so every fold
// case was invisible to it.
//
//   F1. a group with 6 live agents renders 6 members — at BOTH widths — and no `[data-rail-fold]`
//       exists anywhere in the strip.
//   F2. NAVIGATION IS UNTOUCHED by rendering the extra members: the active project after the
//       strip settles is the one that was active before. (The old `+N`'s click did exactly this
//       and that is what made it the two-verbs trap.)
//   F3. with enough agents to genuinely overflow, the scroller SCROLLS — `scrollHeight >
//       clientHeight` — and every member is reachable: each one's `offsetTop` lands inside the
//       scrollable range, so nothing is stranded past the end.
//   F4. THE SCROLL-INTO-VIEW STILL LANDS ON THE HEADER (the brief's one constraint). A group
//       taller than the viewport must top-align at its own name, not scroll past it.
//
// Run: `./node_modules/.bin/vite --port 1437 --strictPort` then `node dev/drive-rail-fold.mjs`.
import { webkit } from 'playwright'

const PORT = process.env.MOCK_PORT || 1437

/** The fixture. `big` carries six live agents — one more than the observed defect — and the two
 *  singles are here so the count is asserted PER GROUP rather than over the whole strip. */
const FIXTURE = [
  { name: 'fastrack', id: 'fastrack-id', lanes: 6 },
  { name: 'uwazi-app', id: 'uwazi-app-id', lanes: 1 },
  { name: 'web27', id: 'web27-id', lanes: 1 },
]
/** F3/F4's scene: enough that the strip cannot possibly fit at 900px tall. */
const FLOOD = [
  { name: 'fastrack', id: 'fastrack-id', lanes: 14 },
  { name: 'uwazi-app', id: 'uwazi-app-id', lanes: 9 },
  { name: 'web27', id: 'web27-id', lanes: 9 },
]

async function scene(fixture, { collapsed, activeId }) {
  const browser = await webkit.launch()
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await ctx.addInitScript(([spec, isCollapsed, active]) => {
    try {
      localStorage.setItem('operator.theme', 'mission-control-dark')
      localStorage.setItem('operator.sidebarCollapsed', isCollapsed ? '1' : '0')
      if (active) localStorage.setItem('operator.activeProjectId', active)
    } catch { /* quota */ }
    let real
    Object.defineProperty(window, 'operator', {
      configurable: true, get: () => real,
      set: (v) => {
        real = v
        const oP = v.loadProjects, oS = v.loadSessions, oT = v.terminalList
        const stampOf = (i) => `2026-07-${String(10 + i).padStart(2, '0')}T00:00:00.000Z`
        const projects = spec.map((e, i) => ({
          id: e.id, name: e.name, path: `/Users/x/${e.name}`,
          createdAt: '2026-07-01T00:00:00.000Z',
          lastActiveAt: stampOf(i),
        }))
        // A live agent needs BOTH halves — a terminal and a saved session joined by `terminalId`.
        // Several per project is the whole point of this fixture. Every row carries a stamp: the
        // saved list is sorted by it, so one undefined takes the whole view down.
        const rows = spec.flatMap((e, i) => Array.from({ length: e.lanes }, (_, k) => ({
          tid: `t-${e.id}-${k}`, project: e, stamp: stampOf(i),
        })))
        v.getVersion = async () => '0.13.7'
        v.loadProjects = async () => [...((await oP()) ?? []), ...projects]
        v.saveProjects = () => {}
        v.terminalList = async () => [
          ...((await oT()) ?? []),
          ...rows.map((r) => ({ id: r.tid, pid: 0, cwd: `/Users/x/${r.project.name}`, command: 'claude', alive: true })),
        ]
        v.loadSessions = async () => [
          ...((await oS()) ?? []),
          ...rows.map((r) => ({
            key: `key-${r.tid}`, cwd: `/Users/x/${r.project.name}`,
            projectName: r.project.name, projectId: r.project.id,
            claudeSessionId: `s-${r.tid}`, terminalId: r.tid,
            lastActiveAt: r.stamp,
          })),
        ]
      },
    })
  }, [fixture, collapsed, activeId ?? null])
  const p = await ctx.newPage()
  p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))
  await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
  await p.waitForSelector('[data-rail]')
  await p.waitForTimeout(2500)
  return { browser, p }
}

/** Members of one group, at whichever width is rendered: a disc collapsed, a `SessionItem` row
 *  expanded. Both carry `data-rail-orb` — the same hook `drive-rail-invariant.mjs` measures
 *  across the two states, and the reason ONE selector can count members at either width.
 *  `data-rail-session` would have been collapsed-only and silently counted 0 at 264. */
const membersOf = (p, id) => p.evaluate((pid) => {
  const g = document.querySelector(`[data-rail-group="${pid}"]`)
  return g ? g.querySelectorAll('[data-rail-orb]').length : -1
}, id)

/** Whichever project the app considers open. The strip does not get to choose it — that is the
 *  point of F2. */
const activeProject = (p) => p.evaluate(() => {
  const el = document.querySelector('[data-rail-project-header][aria-current]')
  return el ? el.getAttribute('data-rail-project-header') : null
})

const foldCount = (p) => p.evaluate(() => document.querySelectorAll('[data-rail-fold]').length)

const out = []
const check = (ok, line) => { out.push(`${ok ? '  ok  ' : ' FAIL '} ${line}`); return ok }
let pass = true

// ── F2's CONTROL: the same scene with one agent per project, so "six agents did not move the
//    active project" is measured against something rather than asserted against a hope. The mock
//    bridge picks the open project itself and ignores a seeded `activeProjectId`, so the control
//    is how this stays a real comparison.
const CONTROL = FIXTURE.map((e) => ({ ...e, lanes: 1 }))
let controlActive = null
{
  const { browser, p } = await scene(CONTROL, { collapsed: true })
  controlActive = await activeProject(p)
  await browser.close()
}

// ── F1 + F2, both widths ────────────────────────────────────────────────────────────────────
for (const collapsed of [true, false]) {
  const w = collapsed ? 'collapsed (60)' : 'expanded (264)'
  const { browser, p } = await scene(FIXTURE, { collapsed })
  const big = await membersOf(p, 'fastrack-id')
  const one = await membersOf(p, 'uwazi-app-id')
  const folds = await foldCount(p)
  const active = await activeProject(p)
  pass = check(big === 6, `F1 ${w}: fastrack renders 6 of 6 live agents — got ${big}`) && pass
  pass = check(one === 1, `F1 ${w}: uwazi-app renders its 1 — got ${one}`) && pass
  pass = check(folds === 0, `F1 ${w}: no [data-rail-fold] in the strip — got ${folds}`) && pass
  pass = check(active === controlActive,
    `F2 ${w}: six members did not change the open project — ${active} == control ${controlActive}`) && pass
  await browser.close()
}

// ── F3 + F4, the flood ──────────────────────────────────────────────────────────────────────
{
  const { browser, p } = await scene(FLOOD, { collapsed: true, activeId: 'fastrack-id' })
  const m = await p.evaluate((seeded) => {
    const box = document.querySelector('[data-rail] .scroll-hidden')
    const groups = [...document.querySelectorAll('[data-rail-group]')]
    const members = [...document.querySelectorAll('[data-rail-orb]')]
    // Counted PER SEEDED GROUP, not over the whole strip: the mock bridge brings its own live
    // projects, and a total would be asserting against the mock's fixture as much as ours.
    const seededMembers = seeded.reduce((n, id) => {
      const g = document.querySelector(`[data-rail-group="${id}"]`)
      return n + (g ? g.querySelectorAll('[data-rail-orb]').length : 0)
    }, 0)
    const open = document.querySelector('[data-rail-group="fastrack-id"]')
    const header = open?.querySelector('[data-rail-project-header]')
    const bx = box.getBoundingClientRect(), hx = header.getBoundingClientRect()
    return {
      scrollH: box.scrollHeight, clientH: box.clientHeight, scrollTop: box.scrollTop,
      groups: groups.length, members: members.length, seededMembers,
      // Reachability: the LAST member's bottom, measured in scroller-content coordinates.
      lastBottom: Math.max(...members.map((el) => el.offsetTop + el.offsetHeight)),
      // The open group's header, relative to the visible box.
      headerTop: hx.top - bx.top, headerBottom: hx.bottom - bx.top,
      folds: document.querySelectorAll('[data-rail-fold]').length,
    }
  }, FLOOD.map((e) => e.id))
  const seeded = FLOOD.reduce((n, e) => n + e.lanes, 0)
  pass = check(m.seededMembers === seeded,
    `F3: all ${seeded} seeded live agents rendered — got ${m.seededMembers} (${m.members} in the whole strip)`) && pass
  pass = check(m.folds === 0, `F3: still no fold under flood — got ${m.folds}`) && pass
  pass = check(m.scrollH > m.clientH, `F3: the rail SCROLLS — scrollHeight ${m.scrollH} > clientHeight ${m.clientH}`) && pass
  pass = check(m.lastBottom <= m.scrollH, `F3: last member reachable — bottom ${Math.round(m.lastBottom)} within content ${m.scrollH}`) && pass
  pass = check(m.headerTop >= -1 && m.headerBottom <= m.clientH + 1,
    `F4: the open group's own header is IN VIEW — top ${Math.round(m.headerTop)}, bottom ${Math.round(m.headerBottom)} in 0..${m.clientH}`) && pass
  out.push(`       (scrollTop ${m.scrollTop}, ${m.groups} groups, content ${m.scrollH}px in a ${m.clientH}px box)`)
  await browser.close()
}

console.log(out.join('\n'))
console.log(pass ? '\nRAIL FOLD: all assertions pass' : '\nRAIL FOLD: FAILED')
process.exit(pass ? 0 : 1)
