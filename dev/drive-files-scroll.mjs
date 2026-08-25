// THE FILES VIEW SCROLLS — asserted against the rendered boxes, not against the source.
//
// The bug: Files (main view) could not be scrolled vertically. The overlay that carries the
// main-view surfaces is a PLAIN BLOCK (`position:absolute; inset:0; overflow:hidden`), and
// `FilesView`'s root asked for its height with `flex: 1` — which means nothing to a block parent.
// The root therefore sized to its CONTENT, grew past the overlay, and the overflow:hidden clipped
// the excess. Neither inner scroller ever got a bounded height, so neither could scroll: the tree
// and the file below the fold were simply unreachable. `CanvasConversation` (Chat) says
// `height: '100%'`, which is why Chat never showed it.
//
//   S1. THE ROOT FITS ITS OVERLAY — `FilesView`'s box is no taller than the overlay that clips it.
//       This is the bug itself; every other check is downstream of it.
//   S2. THE TREE SCROLLS — `scrollHeight > clientHeight`, a wheel over it moves `scrollTop`, and
//       the last row is reachable.
//   S3. THE VIEWER SCROLLS — CodeMirror's `.cm-scroller` overflows, a wheel moves it, and it
//       comes back to the top.
//   S4. KEYBOARD SCROLL — click to focus, then `PageDown`/`End` move each scroller. Both are
//       `tabIndex = -1` (CM sets its own; the tree column matches it), so a click focuses them
//       without putting either into the tab order.
//   S5. NOTHING ELSE MOVED — Console still shows the terminal, Chat and Preview still fill the
//       same overlay exactly.
//
// The mock bridge has no `fileTree`/`fileRead`, so this driver supplies them: a root listing long
// enough to overflow 900px, and a 400-line file. Both are shaped like the real backend's replies.
//
// Run: `./node_modules/.bin/vite --port 1460 --strictPort` then `node dev/drive-files-scroll.mjs`.
import { webkit } from 'playwright'

const PORT = process.env.MOCK_PORT || 1460

const b = await webkit.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))

// The file APIs the mock does not have. Wrapping the `window.operator` SETTER (rather than
// assigning after load) is how the other drivers patch the bridge — the renderer installs it
// during module evaluation, before any script we could run afterwards.
await p.addInitScript(() => {
  const TOP = Array.from({ length: 60 }, (_, i) => (
    i < 8
      ? { path: `dir-${i}`, name: `dir-${i}`, dir: true }
      : { path: `file-${i}.ts`, name: `file-${i}.ts`, dir: false, size: 1200 + i }
  ))
  const LINES = Array.from({ length: 400 }, (_, i) => `const line${i} = ${i} // a line long enough to be worth reading`)
  let real
  Object.defineProperty(window, 'operator', {
    configurable: true,
    get: () => real,
    set: (v) => {
      real = v
      v.fileTree = async (_root, dir) => (dir ? [] : TOP)
      v.fileRead = async (_root, path) => ({
        path, text: LINES.join('\n'), lines: LINES.length,
        bytes: LINES.join('\n').length, truncated: false, binary: false, language: 'TypeScript',
      })
      v.onFileChange = () => () => {}
    },
  })
})

const box = () => p.evaluate(() => {
  const view = document.querySelector('[data-files-view]')
  const overlay = view?.parentElement ?? null
  const tree = document.querySelector('[data-files-tree]')
  const scroller = document.querySelector('.cm-scroller')
  const r = (el) => (el ? Math.round(el.getBoundingClientRect().height) : null)
  const s = (el) => (el ? { h: el.clientHeight, sh: el.scrollHeight, top: Math.round(el.scrollTop) } : null)
  return { view: r(view), overlay: r(overlay), tree: s(tree), scroller: s(scroller) }
})

const wheel = async (sel, dy) => {
  const el = p.locator(sel).first()
  const bb = await el.boundingBox()
  await p.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2)
  await p.mouse.wheel(0, dy)
  await p.waitForTimeout(400)
}

const results = []
const check = (id, ok, detail) => { results.push({ id, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`) }

await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await p.waitForTimeout(2600)
await p.locator('[data-lane-row="code"], [data-session-row="s-code"]').first().click()
await p.waitForTimeout(900)
await p.locator('button[title="Files view"]').click()
await p.waitForTimeout(900)

// S1 — the root fits the box that clips it.
const initial = await box()
check('S1', initial.view !== null && initial.overlay !== null && initial.view <= initial.overlay + 1,
  `FilesView ${initial.view}px inside a ${initial.overlay}px overlay`)

// S2 — the tree scrolls, and its last row is reachable.
if (initial.tree) {
  check('S2a', initial.tree.sh > initial.tree.h, `tree scrollHeight ${initial.tree.sh} > clientHeight ${initial.tree.h}`)
  await wheel('[data-files-tree]', 400)
  const after = await box()
  check('S2b', after.tree.top > 0, `wheel moved the tree to scrollTop ${after.tree.top}`)
  const reachable = await p.evaluate(() => {
    const t = document.querySelector('[data-files-tree]')
    t.scrollTop = t.scrollHeight
    const rows = t.querySelectorAll('[data-file-row]')
    const last = rows[rows.length - 1]
    if (!last) return null
    const tb = t.getBoundingClientRect(), lb = last.getBoundingClientRect()
    return lb.bottom <= tb.bottom + 1 && lb.top >= tb.top - 1
  })
  check('S2c', reachable === true, `the last tree row lands inside the scroller (${reachable})`)
  await p.evaluate(() => { document.querySelector('[data-files-tree]').scrollTop = 0 })
} else {
  check('S2a', false, 'no [data-files-tree] — the tree column never rendered')
}

// Open a file so the viewer has something taller than the pane.
await p.locator('[data-file-row]').filter({ hasText: 'file-20.ts' }).first().click()
await p.waitForTimeout(1200)

// S3 — the viewer scrolls.
const opened = await box()
if (opened.scroller) {
  check('S3a', opened.scroller.sh > opened.scroller.h, `cm-scroller scrollHeight ${opened.scroller.sh} > clientHeight ${opened.scroller.h}`)
  await wheel('.cm-scroller', 600)
  const after = await box()
  check('S3b', after.scroller.top > 0, `wheel moved the viewer to scrollTop ${after.scroller.top}`)
  await wheel('.cm-scroller', -1200)
  const back = await box()
  check('S3c', back.scroller.top === 0, `and back to the top (${back.scroller.top})`)
} else {
  check('S3a', false, 'no .cm-scroller — the file never opened')
}

// S4 — keyboard. Click to focus (both scrollers are tabIndex -1), then page down.
await p.locator('.cm-scroller').click({ position: { x: 200, y: 40 } })
await p.keyboard.press('PageDown')
await p.waitForTimeout(400)
const kbViewer = await box()
check('S4a', kbViewer.scroller.top > 0, `PageDown moved the viewer to scrollTop ${kbViewer.scroller.top}`)

await p.locator('[data-files-tree]').click({ position: { x: 120, y: 8 } })
await p.keyboard.press('PageDown')
await p.waitForTimeout(400)
const kbTree = await box()
check('S4b', kbTree.tree.top > 0, `PageDown moved the tree to scrollTop ${kbTree.tree.top}`)

// S5 — the other three main views are untouched.
await p.locator('button[title="Console view"]').click()
await p.waitForTimeout(700)
const console_ = await p.evaluate(() => {
  const term = document.querySelector('.xterm, [data-grid-terminal]')
  return { term: !!term, visible: term ? getComputedStyle(term.closest('[style*="visibility"]') ?? term).visibility : null }
})
check('S5a', console_.term, `Console still renders its terminal (visibility ${console_.visible})`)

for (const [label, sel] of [['Chat', 'button[title="Chat view"]'], ['Preview', 'button[title="Preview view"]']]) {
  await p.locator(sel).click()
  await p.waitForTimeout(900)
  const fits = await p.evaluate(() => {
    // The overlay is the same box in every main view; its only child should fill it.
    const overlay = document.querySelector('[data-files-view]')?.parentElement
      ?? [...document.querySelectorAll('div')].find((d) => {
        const s = getComputedStyle(d)
        return s.position === 'absolute' && s.overflow === 'hidden' && d.querySelector('.cm-scroller, canvas, iframe, [data-preview-host]')
      })
    if (!overlay) return null
    const child = overlay.firstElementChild
    if (!child) return null
    return Math.round(child.getBoundingClientRect().height) <= Math.round(overlay.getBoundingClientRect().height) + 1
  })
  check(`S5-${label}`, fits === true, `${label} still fills its overlay without overflowing (${fits})`)
}

// S6 — PLACEMENT B, the right panel's Files tab. The SAME reader, and it turned out to have the
// SAME bug: the panel body it lands in is a `flex: 1` BLOCK, so this root sized to its content
// too and its viewer could not be scrolled either (measured 6831/6831 before the fix).
await p.locator('button[title^="Show side panel"]').click().catch(() => {})
await p.waitForTimeout(700)
await p.locator('button', { hasText: /^FILES$/i }).last().click().catch(() => {})
await p.waitForTimeout(1400)
const panel = await p.evaluate(() => {
  const root = document.querySelector('[data-files-panel]')
  const scrollers = [...document.querySelectorAll('.cm-scroller')]
  const el = scrollers[scrollers.length - 1]
  return {
    mounted: !!root,
    fits: root ? Math.round(root.getBoundingClientRect().height) <= Math.round(root.parentElement.getBoundingClientRect().height) + 1 : null,
    size: el ? `${el.clientHeight}/${el.scrollHeight}` : null,
    scrolls: el ? el.scrollHeight > el.clientHeight : null,
  }
})
check('S6a', panel.mounted && panel.fits === true, `panel Files fits its block slot (${panel.fits})`)
check('S6b', panel.scrolls === true, `and its viewer scrolls (${panel.size})`)

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`)
await b.close()
process.exit(results.every((r) => r.ok) ? 0 : 1)
