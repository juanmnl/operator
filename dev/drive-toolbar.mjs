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
// Also asserts the collapsed rail carries exactly ONE show-sidebar affordance (the toolbar
// owns that control; the rail's duplicate copy was removed).
//
// Run against a vite dev server: `npx vite --port 1440` then `node dev/drive-toolbar.mjs`.
import { webkit } from 'playwright'
const b = await webkit.launch()

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
  await p.goto('http://localhost:1440/dev/mock.html', { waitUntil: 'load' })
  await p.waitForTimeout(2600)
  // The code lane is the fixture carrying effort + permission + a detected dev port, so its
  // toolbar renders the cluster in full.
  await p.locator('[data-session-row="s-code"]').click()
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
  await p.close()
}

// The rail must offer exactly one way back to the full sidebar (the project badge), and no
// show-sidebar toggle of its own.
const p = await b.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' })
await p.goto('http://localhost:1440/dev/mock.html', { waitUntil: 'load' })
await p.waitForTimeout(2600)
await p.locator('[data-session-row="s-code"]').click()
await p.waitForTimeout(1200)
await p.keyboard.press('Meta+b') // collapse to the rail
await p.waitForTimeout(900)
const railToggles = await p.evaluate(() => {
  const rail = Array.from(document.querySelectorAll('div')).find((d) => getComputedStyle(d).width === '64px')
  return Array.from(rail?.querySelectorAll('button') ?? []).map((b) => (b.getAttribute('aria-label') || b.getAttribute('title') || '').slice(0, 30))
})
console.log('rail buttons:', JSON.stringify(railToggles))
console.log('no duplicate show-sidebar toggle in the rail:', !railToggles.some((t) => /^Show sidebar$/.test(t)))
await p.screenshot({ path: '/tmp/toolbar-rail.png', clip: { x: 0, y: 0, width: 360, height: 240 } })
await b.close()
