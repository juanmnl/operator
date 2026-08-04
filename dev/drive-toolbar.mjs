// Drive the SessionToolbar's header row. Two things this guards, both invisible to
// typecheck and to the unit tests:
//
//  1. The right cluster (localhost · MCP · effort · permission · panel toggle) must share ONE
//     box height and one vertical centre at EVERY width. They used to be sized two different
//     ways — badges by padding + line-height (20px), the toggle by a fixed 22×22 — with no
//     flexShrink/nowrap, so under pressure the badges wrapped to two lines (36px tall) and the
//     icon squashed to 17px wide.
//  2. The two clusters must never overlap: the right side is fixed, the left clips.
//
// Also asserts:
//  3. THE TWO HEADER BANDS LAND ON ONE Y. When the right panel opens, its Plan/Diff/Chat tab row
//     draws a `borderBottom` beside the toolbar's — and they were 44 and 36, so one window had two
//     horizontal rules 8px apart. Both take `TOOLBAR_BAND_H` now, and this measures the RULES
//     (each band's bottom edge), not the boxes, at more than one width.
//  4. The collapsed rail carries exactly ONE show-sidebar affordance (the toolbar owns that
//     control; the rail's duplicate copy was removed).
//
// Run against a vite dev server: `npx vite --port 1440` then `node dev/drive-toolbar.mjs`
// (or MOCK_PORT=<port> against one that is already up).
import { webkit } from 'playwright'
import { readFileSync, readdirSync } from 'node:fs'
const PORT = process.env.MOCK_PORT || 1440
const b = await webkit.launch()
let failed = 0

// ---- ONE DEFINITION, asserted in the SOURCE ---------------------------------------------------
// The runtime check below proves the two bands agree today; this proves they cannot drift apart
// tomorrow. A band that types its own height is the whole defect — two numbers that happen to
// match, under a comment claiming they are one.
{
  const offenders = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${e.name}`
      if (e.isDirectory()) { walk(path); continue }
      if (!e.name.endsWith('.tsx')) continue
      const src = readFileSync(path, 'utf8')
      for (const line of src.split('\n')) {
        // A header band = a literal height on a row that also draws a bottom rule.
        if (/borderBottom:\s*'1px solid var\(--border\)'/.test(line) && /height:\s*\d+/.test(line)) {
          offenders.push(`${path.replace(/^.*\/src\//, 'src/')}: ${line.trim().slice(0, 90)}`)
        }
      }
    }
  }
  walk('src/renderer')
  console.log(offenders.length
    ? `FAIL header bands with a literal height:\n  ${offenders.join('\n  ')}`
    : 'ok   every header band takes its height from lib/chrome (TOOLBAR_BAND_H)')
  if (offenders.length) failed++
}

const readRow = (p) => p.evaluate(() => {
  const clusters = Array.from(document.querySelectorAll('.drag-region > div'))
  const right = clusters[clusters.length - 1]
  const left = clusters[clusters.length - 2]
  const lr = left.getBoundingClientRect()
  const rr = right.getBoundingClientRect()
  const items = Array.from(right.children).map((el) => {
    const inner = el.querySelector('button') || el
    const r = inner.getBoundingClientRect()
    return {
      label: (inner.textContent || inner.getAttribute('title') || 'icon').trim().slice(0, 12) || 'icon',
      h: +r.height.toFixed(1),
      mid: +((r.top + r.bottom) / 2).toFixed(2),
      w: +r.width.toFixed(1),
    }
  })
  return { items, overlap: +(lr.right - rr.left).toFixed(1) }
})

for (const w of [1440, 1100, 900, 780, 680]) {
  const p = await b.newPage({ viewport: { width: w, height: 800 }, colorScheme: 'dark' })
  p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 160)))
  await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
  await p.waitForTimeout(2600)
  // The code lane is the fixture carrying effort + permission + a detected dev port, so its
  // toolbar renders the cluster in full.
  // `[data-rail-orb="s-code"]` — D1 replaced the sidebar with the joined strip, and a lane row's
  // only stable hook is its orb (`data-session-row` survives on AD-HOC rows alone). The click
  // bubbles to the row.
  await p.locator('[data-rail-orb="s-code"]').click()
  await p.waitForTimeout(2000)

  const { items, overlap } = await readRow(p)
  const heights = [...new Set(items.map((i) => i.h))]
  const mids = [...new Set(items.map((i) => i.mid))]
  const ok = heights.length === 1 && mids.length === 1 && overlap <= 0
  console.log(
    `w=${String(w).padEnd(4)} ${ok ? 'OK  ' : 'FAIL'} heights ${JSON.stringify(heights)} centres ${JSON.stringify(mids)}`
    + ` clusters ${overlap <= 0 ? 'clear' : `OVERLAP ${overlap}px`} | ${items.map((i) => `${i.label} ${i.h}×${i.w}`).join(' · ')}`,
  )
  if (w === 680) await p.screenshot({ path: '/tmp/toolbar-narrow.png', clip: { x: 0, y: 8, width: w, height: 44 } })

  // ---- the two header bands, with the right panel OPEN ---------------------------------------
  await p.locator('button[title*="side panel"]').click().catch(() => {})
  await p.waitForTimeout(400)
  const bands = await p.evaluate(() => {
    // BY THE HOOK, not by a heuristic. An earlier version of this looked for "a flex row with a
    // bottom border near the top", which also matched the Console/Chat/Preview segmented control
    // inside the toolbar and a panel's own 30px sub-head — two things that are not header bands
    // and must not be dragged onto the toolbar's y. Every band carries `data-toolbar-header`; a
    // new one that forgets it is caught by the SOURCE scan at the top of this file instead.
    return [...document.querySelectorAll('[data-toolbar-header]')].map((el) => {
      const r = el.getBoundingClientRect()
      return {
        label: el.getAttribute('data-toolbar-header'),
        h: +r.height.toFixed(1),
        // THE RULE, not the box: the 1px border sits inside the box, so its y IS the box's bottom.
        rule: +r.bottom.toFixed(1),
      }
    })
  })
  const rules = [...new Set(bands.map((x) => x.rule))]
  const bandsOk = bands.length >= 2 && rules.length === 1
  console.log(`      ${bandsOk ? 'OK  ' : 'FAIL'} header bands ${JSON.stringify(bands.map((x) => `${x.label} h=${x.h} rule@${x.rule}`))}`)
  if (!bandsOk) failed++
  await p.close()
}

// The rail must offer exactly one way back to the full sidebar (the project badge), and no
// show-sidebar toggle of its own.
const p = await b.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' })
await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await p.waitForTimeout(2600)
await p.locator('[data-rail-orb="s-code"]').click()
await p.waitForTimeout(1200)
await p.keyboard.press('Meta+b') // collapse to the rail
await p.waitForTimeout(900)
const railToggles = await p.evaluate(() => {
  // `[data-rail]`, not a width-keyed lookup: that was '64px' and the strip is 60 since D1 — a
  // harness that loses its subject on a legitimate change is worse than none.
  const rail = document.querySelector('[data-rail]')
  return Array.from(rail?.querySelectorAll('button') ?? []).map((b) => (b.getAttribute('aria-label') || b.getAttribute('title') || '').slice(0, 30))
})
console.log('rail buttons:', JSON.stringify(railToggles))
console.log('no duplicate show-sidebar toggle in the rail:', !railToggles.some((t) => /^Show sidebar$/.test(t)))
await p.screenshot({ path: '/tmp/toolbar-rail.png', clip: { x: 0, y: 0, width: 360, height: 240 } })
await b.close()
if (failed) { console.log(`\n${failed} FAILURE(S)`); process.exit(1) }
console.log('\nAll toolbar checks passed.')
