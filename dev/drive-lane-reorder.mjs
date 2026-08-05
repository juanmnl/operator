// REORDERING AGENTS — the regression, and the rules around it.
// dev/briefs/2026-08-05-restore-lane-reorder.md
//
// The v0.13.7 rail/sidebar join dropped `onReorderLane` — prop, call site and handler — so a LANE
// row (any agent with a `roleId`, i.e. every agent) became undraggable while ad-hoc sessions kept
// their drag. That is why it read as half-working rather than gone.
//
//   R1. EXPANDED: dragging one lane onto another reorders them, and the new order is written to
//       the durable ROSTER — which is the real acceptance test, since that is what survives a
//       restart and what the Team screen reads.
//   R2. COLLAPSED: the same drag works on the orbs (see the RESULT for why this was taken past
//       the regression), and the member PITCH does not move when a drop line is showing.
//   R3. AD-HOC rows still reorder among themselves — the half that never broke.
//   R4. CROSS-KIND is refused, not silently dropped: a lane dragged over an ad-hoc row (and the
//       reverse) previews NO drop line, so `drop` never fires.
//   R5. CROSS-PROJECT is refused the same way — role ids repeat across projects (`code` is in
//       most of them), so this would land in the wrong roster or self-drop.
//   R6. The row still SELECTS on click and still opens its menu on right-click. A draggable row
//       that stops being clickable is the trade this project has made before.
//
// Run: `./node_modules/.bin/vite --port <free> --strictPort` then
//      `MOCK_PORT=<free> node dev/drive-lane-reorder.mjs`
import { webkit } from 'playwright'

const PORT = process.env.MOCK_PORT || 1440

const out = []
const check = (ok, line) => { out.push(`${ok ? '  ok  ' : ' FAIL '} ${line}`); return ok }
let pass = true

async function open({ collapsed }) {
  const browser = await webkit.launch()
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await ctx.addInitScript((c) => {
    try {
      localStorage.setItem('operator.theme', 'mission-control-dark')
      localStorage.setItem('operator.sidebarCollapsed', c ? '1' : '0')
    } catch { /* quota */ }
    // CAPTURE WHAT IS PERSISTED. `saveProjects` is the durable write — asserting the DOM order
    // alone would pass on a reorder that never reached the roster, which is exactly the class of
    // bug this project has shipped before ("a position that looks saved and isn't").
    window.__saved = []
    let real
    Object.defineProperty(window, 'operator', {
      configurable: true, get: () => real,
      set: (v) => { real = v; v.saveProjects = (list) => { window.__saved.push(list) } },
    })
  }, collapsed)
  const p = await ctx.newPage()
  p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))
  await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
  await p.waitForSelector('[data-rail]')
  await p.waitForTimeout(1500)
  return { browser, p }
}

/** Lane order as the STRIP renders it — by roleId, which is the thing the roster orders. */
const laneOrder = (p, sel) => p.evaluate((s) => [...document.querySelectorAll(s)].map((el) => el.getAttribute(s.slice(1, -1))), sel)
/** Lane order as the durable ROSTER holds it, from the last persisted write. */
const savedRoster = (p) => p.evaluate(() => {
  const last = window.__saved.at(-1)
  if (!last) return null
  const proj = last.find((x) => (x.roster ?? []).length > 1)
  return proj ? proj.roster.map((r) => r.id) : null
})

/** A real HTML5 drag. Playwright's dragTo does not always carry custom dataTransfer types through
 *  WebKit, and the TYPE is the whole same-kind mechanism here — so drive the events directly,
 *  with ONE shared DataTransfer, which is what a browser does. */
async function dragRow(p, fromSel, toSel, { toBottom = false } = {}) {
  return p.evaluate(([a, b, bottom]) => {
    const from = document.querySelector(a), to = document.querySelector(b)
    if (!from || !to) return { ok: false, why: 'selector missed' }
    const dt = new DataTransfer()
    from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
    const r = to.getBoundingClientRect()
    const clientY = bottom ? r.bottom - 2 : r.top + 2
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY, clientX: r.left + 5 })
    to.dispatchEvent(over)
    // `preventDefault` on dragover IS the "I am a drop target" signal. If it was not called, the
    // row refused the drag and no drop line was drawn.
    const accepted = over.defaultPrevented
    to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY, clientX: r.left + 5 }))
    from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
    return { ok: true, accepted, types: [...dt.types] }
  }, [fromSel, toSel, toBottom])
}

// ── R1 + R4 + R6, expanded ──────────────────────────────────────────────────────────────────
{
  const { browser, p } = await open({ collapsed: false })
  const before = await laneOrder(p, '[data-lane-row]')
  pass = check(before.length > 1, `R1 setup: ${before.length} lane rows — [${before.join(', ')}]`) && pass

  const d = await dragRow(p, `[data-lane-row="${before[0]}"]`, `[data-lane-row="${before[2] ?? before[1]}"]`, { toBottom: true })
  await p.waitForTimeout(500)
  const after = await laneOrder(p, '[data-lane-row]')
  pass = check(d.accepted, `R1 a lane row accepts a lane drag (types [${d.types?.join(', ')}])`) && pass
  pass = check(JSON.stringify(after) !== JSON.stringify(before),
    `R1 the rendered order CHANGED — [${before.join(', ')}] → [${after.join(', ')}]`) && pass

  const roster = await savedRoster(p)
  pass = check(roster !== null, `R1 the reorder was PERSISTED — saveProjects fired`) && pass
  pass = check(roster && before.every((id) => roster.includes(id)) && JSON.stringify(roster.filter((id) => before.includes(id))) === JSON.stringify(after),
    `R1 the durable roster agrees with the strip — roster [${roster?.join(', ')}]`) && pass

  // R4 — cross-kind. The fixture's one ad-hoc session is the only row of its kind, so it carries
  // no drag of its own (the "nothing to drop onto" guard) — but it still carries its identity
  // hook, which is the point of the wrapper being unconditional. Dragging a LANE over it must be
  // refused, and a saved-count baseline proves the refusal changed nothing durable.
  const adhoc = await p.evaluate(() => document.querySelector('[data-session-row]')?.getAttribute('data-session-row') ?? null)
  pass = check(!!adhoc, `R4 the lone ad-hoc row still carries [data-session-row] though it cannot drag`) && pass
  if (adhoc) {
    const savedBefore = await p.evaluate(() => window.__saved.length)
    const x1 = await dragRow(p, `[data-lane-row="${after[0]}"]`, `[data-session-row="${adhoc}"]`)
    pass = check(x1.accepted === false, `R4 lane → ad-hoc: refused, no drop line (accepted=${x1.accepted})`) && pass
    const stillThere = await laneOrder(p, '[data-lane-row]')
    pass = check(JSON.stringify(stillThere) === JSON.stringify(after), `R4 and nothing moved — [${stillThere.join(', ')}]`) && pass
    const savedAfter = await p.evaluate(() => window.__saved.length)
    pass = check(savedAfter === savedBefore, `R4 and nothing was persisted (${savedBefore} → ${savedAfter} saves)`) && pass
  }

  // R6 — the row is still a control.
  const clicked = await p.evaluate((id) => {
    const row = document.querySelector(`[data-lane-row="${id}"]`)
    row?.querySelector('[role="button"], button, div')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return !!row
  }, after[1])
  await p.waitForTimeout(600)
  const selected = await p.evaluate(() => !!document.querySelector('[data-rail-session][aria-current], [aria-current="true"]'))
  pass = check(clicked && selected, `R6 clicking a draggable lane row still selects it`) && pass
  await browser.close()
}

// ── R2, collapsed ───────────────────────────────────────────────────────────────────────────
{
  const { browser, p } = await open({ collapsed: true })
  const before = await laneOrder(p, '[data-lane-orb]')
  pass = check(before.length > 1, `R2 setup: ${before.length} lane orbs — [${before.join(', ')}]`) && pass

  // The member PITCH must not move when a drop line shows — the collapsed orbs are flush, so a
  // bordered drop line would spread the whole column and `drive-rail-invariant` would fail.
  const pitchOf = () => p.evaluate(() => {
    const orbs = [...document.querySelectorAll('[data-rail-session]')].map((el) => el.getBoundingClientRect().top)
    return orbs.length > 1 ? Math.round((orbs[1] - orbs[0]) * 100) / 100 : null
  })
  const restPitch = await pitchOf()
  const held = await p.evaluate(([a, b]) => {
    const from = document.querySelector(`[data-lane-orb="${a}"]`), to = document.querySelector(`[data-lane-orb="${b}"]`)
    const dt = new DataTransfer()
    from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
    const r = to.getBoundingClientRect()
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.top + 2, clientX: r.left + 5 })
    to.dispatchEvent(over)
    return over.defaultPrevented
  }, [before[0], before[1]])
  await p.waitForTimeout(200)
  const draggingPitch = await pitchOf()
  pass = check(held, `R2 an orb accepts a lane drag`) && pass
  pass = check(restPitch === draggingPitch,
    `R2 the member pitch does NOT move while the drop line shows — ${restPitch} → ${draggingPitch}`) && pass
  const lineOnTop = await p.evaluate(() => {
    const el = [...document.querySelectorAll('[data-rail-session] span')].find((s) => getComputedStyle(s).position === 'absolute' && s.getBoundingClientRect().height <= 2)
    return !!el
  })
  pass = check(lineOnTop, `R2 a drop line is actually drawn (out of flow)`) && pass

  const d = await dragRow(p, `[data-lane-orb="${before[0]}"]`, `[data-lane-orb="${before[2] ?? before[1]}"]`, { toBottom: true })
  await p.waitForTimeout(500)
  const after = await laneOrder(p, '[data-lane-orb]')
  pass = check(d.accepted && JSON.stringify(after) !== JSON.stringify(before),
    `R2 the collapsed drag reorders — [${before.join(', ')}] → [${after.join(', ')}]`) && pass
  const roster = await savedRoster(p)
  pass = check(roster !== null, `R2 and it persists to the roster too — [${roster?.join(', ')}]`) && pass
  await browser.close()
}

// ── R5, cross-project ───────────────────────────────────────────────────────────────────────
{
  const { browser, p } = await open({ collapsed: true })
  // Two groups, each with a lane orb. The mock's second project (el-encanto) has a `code` lane —
  // the SAME role id as the first project's, which is precisely the collision this guards.
  const pairs = await p.evaluate(() => {
    const groups = [...document.querySelectorAll('[data-rail-group]')]
      .map((g) => ({ id: g.getAttribute('data-rail-group'), orbs: [...g.querySelectorAll('[data-lane-orb]')].map((o) => o.getAttribute('data-lane-orb')) }))
      .filter((g) => g.orbs.length > 0)
    return groups.length > 1 ? [groups[0], groups[1]] : null
  })
  if (!pairs) {
    // Only one group in this fixture has lane orbs, so the cross-GROUP gesture cannot be staged.
    // Test the guard itself instead, which is the same thing one level down: a lane row accepts
    // exactly one drag type, `operator/lane-<its own project>`. Hand it a drag carrying another
    // project's lane type and it must refuse — that is what stops `code` in project A landing in
    // project B's roster, where a role id of the same name very often exists.
    const r5 = await p.evaluate(() => {
      const group = document.querySelector('[data-rail-group]')
      const orb = group?.querySelector('[data-lane-orb]')
      if (!orb) return null
      const mine = `operator/lane-${group.getAttribute('data-rail-group')}`
      const theirs = 'operator/lane-some-other-project-deadbeef'
      const probe = (type) => {
        const dt = new DataTransfer()
        dt.setData(type, 'code')
        const r = orb.getBoundingClientRect()
        const ev = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.top + 2, clientX: r.left + 5 })
        orb.dispatchEvent(ev)
        return ev.defaultPrevented
      }
      return { own: probe(mine), other: probe(theirs) }
    })
    pass = check(r5 && r5.own === true, `R5 a lane row accepts its OWN project's lane type`) && pass
    pass = check(r5 && r5.other === false, `R5 and REFUSES another project's — a role id repeats across projects`) && pass
  }
  if (pairs) {
    const from = `[data-rail-group="${pairs[0].id}"] [data-lane-orb="${pairs[0].orbs[0]}"]`
    const to = `[data-rail-group="${pairs[1].id}"] [data-lane-orb="${pairs[1].orbs[0]}"]`
    const sameRole = pairs[0].orbs[0] === pairs[1].orbs[0]
    const d = await dragRow(p, from, to)
    pass = check(d.accepted === false,
      `R5 cross-project lane drag refused (${pairs[0].id}/${pairs[0].orbs[0]} → ${pairs[1].id}/${pairs[1].orbs[0]}${sameRole ? ', SAME role id' : ''})`) && pass
    const saved = await p.evaluate(() => window.__saved.length)
    pass = check(saved === 0, `R5 and nothing was persisted — ${saved} saveProjects calls`) && pass
  }
  await browser.close()
}

console.log(out.join('\n'))
console.log(pass ? '\nLANE REORDER: all assertions pass' : '\nLANE REORDER: FAILED')
process.exit(pass ? 0 : 1)
