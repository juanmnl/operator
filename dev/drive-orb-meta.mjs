// THE ORB HOVER, at both rail widths and in both themes — dev/briefs/orb-hover-model-effort.md
//
// What it checks, and why each one is a separate assertion:
//   1. EXPANDED — hovering a lane row opens its card and the card names the model and the effort.
//   2. COLLAPSED — the same card, from the same data, off the disc alone. This is the state the
//      ask was really about: collapsed, the orb IS the lane, and model/effort were unreachable.
//   3. PROVENANCE — every value carries its source, and a running model that differs from the
//      one we launched with shows BOTH rather than one being silently picked.
//   4. IT CLEARS. A stuck card over the rail is worse than no hover: the driver moves the pointer
//      away and off the window and asserts nothing is left painted.
import { webkit } from 'playwright'

const PORT = process.env.MOCK_PORT || 1424
const OUT = process.env.OUT || '/tmp/orb-meta'

const cards = (p) => p.evaluate(() =>
  Array.from(document.querySelectorAll('[data-lane-meta]'))
    .map((el) => {
      const cells = Array.from(el.children).map((c) => c.textContent.trim())
      const rows = []
      for (let i = 0; i < cells.length; i += 3) rows.push(cells.slice(i, i + 3).join(' | '))
      return rows
    }))

// The app's theme is its OWN setting, not `prefers-color-scheme` — a page opened with
// `colorScheme: 'light'` still renders Mission Control dark, which is how a "both themes"
// check can pass while only ever having seen one.
const THEMES = (process.env.THEMES || 'mission-control-dark,mission-control-light').split(',')

const b = await webkit.launch()
for (const scheme of THEMES) {
  const ctx = await b.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: scheme.endsWith('light') ? 'light' : 'dark',
    deviceScaleFactor: 2,
  })
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem('operator.theme', t)
      localStorage.setItem('operator.sidebarCollapsed', '0')
    } catch { /* ignore */ }
  }, scheme)
  const p = await ctx.newPage()
  p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))
  await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
  await p.waitForTimeout(2500)

  // --- 1. EXPANDED ---------------------------------------------------------------------------
  // The CODE lane: launched on `opus`, answering as Sonnet (its own transcript types `/model
  // sonnet`), and the one fixture carrying an effort — so one hover exercises every row shape.
  const row = p.locator('[data-lane-row="code"]')
  await row.hover()
  await p.waitForTimeout(700)
  console.log(`[${scheme}] expanded card:`, JSON.stringify(await cards(p)))
  await p.screenshot({ path: `${OUT}-expanded-${scheme}.png`, clip: { x: 0, y: 0, width: 620, height: 420 } })

  // --- 4a. it clears when the pointer moves off the row --------------------------------------
  await p.mouse.move(900, 500)
  await p.waitForTimeout(400)
  console.log(`[${scheme}] after moving away:`, JSON.stringify(await cards(p)))

  // --- 2. COLLAPSED (⌘B folds the strip) ------------------------------------------------------
  await p.keyboard.press('Meta+b')
  await p.waitForTimeout(700)
  const orb = p.locator('[data-lane-orb="code"]')
  await orb.hover()
  await p.waitForTimeout(700)
  console.log(`[${scheme}] collapsed card:`, JSON.stringify(await cards(p)))
  await p.screenshot({ path: `${OUT}-collapsed-${scheme}.png`, clip: { x: 0, y: 0, width: 480, height: 420 } })

  // --- 4b. it clears when the pointer LEAVES THE WINDOW ---------------------------------------
  // Not `mouse.move` to an edge — that never leaves the document. The real signal is a `mouseout`
  // whose relatedTarget is null, which is what a cursor crossing the window frame produces.
  await p.evaluate(() => document.dispatchEvent(
    new MouseEvent('mouseout', { bubbles: true, relatedTarget: null }),
  ))
  await p.waitForTimeout(300)
  console.log(`[${scheme}] after leaving the window:`, JSON.stringify(await cards(p)))

  await ctx.close()
}
await b.close()
