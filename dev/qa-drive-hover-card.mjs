// Verifies dev/briefs/hover-card-stuck.md is actually fixed, against the real-data harness
// (dev/qa-real.html / dev/qa-real-bridge.ts — see dev/qa-chat-regression.md for why real data,
// not the mock). Follows the brief's own "Verify" recipe: hover a row, then dispatch a
// `mouseout` with null relatedTarget + a window `blur`, and assert no card survives in the
// DOM. Covers both SessionItem (expanded sidebar) and SidebarRail (collapsed) — the brief's
// whole point was that only one of the two had ANY hardening.
import { webkit } from 'playwright'

const PORT = process.env.QA_PORT || 1440
const BIG_ID = 'a1d8d389-0774-451f-87d1-445a2a2f8863'
const LONG_ID = 'e5893b67-e01f-40ee-b2b4-3e7e52bb3757'

const results = []
const record = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const fixedCardCount = (p) => p.evaluate(() => {
  let n = 0
  document.querySelectorAll('div').forEach((d) => {
    if (getComputedStyle(d).position === 'fixed' && d.style.maxWidth === '260px') n++
  })
  return n
})

const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
const pageErrors = []
p.on('pageerror', (e) => pageErrors.push(String(e)))

await p.addInitScript(() => { try { localStorage.removeItem('operator.activeProjectId'); localStorage.setItem('operator.sidebarCollapsed', '0') } catch { /* quota */ } })
await p.goto(`http://localhost:${PORT}/dev/qa-real.html`, { waitUntil: 'load' })
await p.waitForTimeout(2200)

// ============ Part A: SessionItem (expanded sidebar) ============
{
  const row = p.locator(`[data-session-row="${BIG_ID}"]`)
  await row.hover()
  await p.waitForTimeout(300)
  const upCount = await fixedCardCount(p)
  record('A1. hovering a session row shows exactly one card', upCount === 1, `count=${upCount}`)

  // The brief's own repro: pointer leaves the document (null relatedTarget) + window blur.
  await p.evaluate(() => {
    document.dispatchEvent(new MouseEvent('mouseout', { relatedTarget: null, bubbles: true }))
    window.dispatchEvent(new Event('blur'))
  })
  await p.waitForTimeout(300)
  const afterLeave = await fixedCardCount(p)
  record('A2. mouseout(relatedTarget=null) + window blur dismisses the card', afterLeave === 0, `count=${afterLeave}`)

  // Sanity: re-hovering still works (not permanently broken by the fix).
  await p.locator('body').hover({ position: { x: 5, y: 5 } })
  await row.hover()
  await p.waitForTimeout(300)
  const rehover = await fixedCardCount(p)
  record('A3. re-hovering after a dismiss shows the card again', rehover === 1, `count=${rehover}`)
  await p.locator('body').hover({ position: { x: 5, y: 5 } })
  await p.waitForTimeout(300)
}

// ============ Part B: SidebarRail (collapsed) ============
{
  // The init script above unconditionally sets sidebarCollapsed='0' and re-fires on every
  // navigation (including reload) -- stack a second one that runs after it and flips it to
  // collapsed, or the reload below silently lands back on the expanded view.
  await p.addInitScript(() => { try { localStorage.setItem('operator.sidebarCollapsed', '1') } catch { /* quota */ } })
  await p.reload({ waitUntil: 'load' })
  await p.waitForTimeout(2200)

  // Rail rows are unlabeled session buttons ~40x40 inside the 64px rail; select by geometry
  // (no stable test id exists on them, unlike the expanded rows' data-session-row).
  const railButtons = await p.evaluate(() => {
    const out = []
    document.querySelectorAll('button[aria-label]').forEach((btn, i) => {
      const r = btn.getBoundingClientRect()
      if (r.width === 40 && r.height === 40) out.push(i)
    })
    return out.length
  })
  record('rail buttons are present (collapsed view actually rendered)', railButtons >= 2, `count=${railButtons}`)

  // No stable test id on rail rows, unlike the expanded rows' data-session-row -- get
  // bounding boxes via evaluate and hover by coordinate instead.
  const boxes = await p.evaluate(() => {
    const out = []
    document.querySelectorAll('button[aria-label]').forEach((btn) => {
      const r = btn.getBoundingClientRect()
      if (r.width === 40 && r.height === 40) out.push({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
    })
    return out
  })

  if (boxes.length >= 1) {
    await p.mouse.move(boxes[0].x, boxes[0].y)
    await p.waitForTimeout(300)
    const upCount = await fixedCardCount(p)
    record('B1. hovering a rail button shows exactly one card (rail previously had NO hardening at all)', upCount === 1, `count=${upCount}`)

    await p.evaluate(() => {
      document.dispatchEvent(new MouseEvent('mouseout', { relatedTarget: null, bubbles: true }))
      window.dispatchEvent(new Event('blur'))
    })
    await p.waitForTimeout(300)
    const afterLeave = await fixedCardCount(p)
    record('B2. same mouseout+blur repro dismisses the RAIL card', afterLeave === 0, `count=${afterLeave}`)
  } else {
    record('B1/B2. rail hover repro', false, 'no rail buttons found to hover — selector likely stale')
  }

  // ============ Part C: single-card-app-wide guarantee ============
  if (boxes.length >= 2) {
    // Move away first -- the mouse is already AT boxes[0] from part B, and Playwright/WebKit
    // won't fire a fresh mouseenter for a move to the identical coordinate.
    await p.mouse.move(5, 5)
    await p.waitForTimeout(150)
    await p.mouse.move(boxes[0].x, boxes[0].y)
    await p.waitForTimeout(250)
    const afterFirst = await fixedCardCount(p)
    await p.mouse.move(boxes[1].x, boxes[1].y)
    await p.waitForTimeout(250)
    const afterSecond = await fixedCardCount(p)
    record('C1. hovering row A then row B without a clean leave never shows two cards at once',
      afterFirst === 1 && afterSecond === 1, `afterFirst=${afterFirst} afterSecond=${afterSecond}`)
    await p.mouse.move(5, 5)
    await p.waitForTimeout(250)
  } else {
    record('C1. two-card eviction check', false, `only ${boxes.length} rail row(s) available in fixture`)
  }
}

console.log('\n--- SUMMARY ---')
const failed = results.filter((r) => !r.pass)
console.log(`${results.length - failed.length}/${results.length} passed`)
if (failed.length) console.log('FAILED:', failed.map((r) => r.name))
console.log('page errors observed:', pageErrors.length, pageErrors.slice(0, 5))

await b.close()
process.exit(failed.length ? 1 : 0)
