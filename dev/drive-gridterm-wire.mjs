// THE GRID TERMINAL IS REACHABLE AGAIN — the wiring, and only the wiring.
// dev/briefs/2026-08-04-gridterm-wire.md
//
// `terminal_spawn` has accepted `grid: Option<bool>` since 2026-06-30 and nothing ever passed it,
// so the alacritty core was never created and `GridTerminalPane` was imported by nothing. This
// driver checks the wire that was missing, at both ends:
//
//   G1. PREF OFF (the default) mounts the xterm pane and NOTHING about the grid runs. This is the
//       assertion that matters most — the grid is an opt-in escape hatch and a default install
//       must be untouched by it.
//   G2. PREF ON mounts `GridTerminalPane` instead, per session.
//   G3. LIFECYCLE: attach on becoming active, resize on a pane resize, set_theme on a theme
//       change, detach on unmount. The brief asks for these four by name.
//   G4. PER SESSION, NOT PER APP: flipping the pref while a session runs must not swap the pane
//       under it — the core is created at spawn, so the renderer is bound there.
//
// WHAT THIS DRIVER DOES NOT AND CANNOT PROVE. The mock emits no `gridterm:update`, deliberately
// (see the `?grid=1` note in dev/mock-bridge.ts): the snapshots come from an alacritty core in
// Rust, and faking a stream here would paint text and let this report claim "the grid renders"
// when nothing of the actual renderer had run. Painting, typing, scrollback, selection and copy
// are UNVERIFIED here and are the user's live-session test.
//
// Run: `./node_modules/.bin/vite --port 1437 --strictPort` then `node dev/drive-gridterm-wire.mjs`
import { webkit } from 'playwright'

const PORT = process.env.MOCK_PORT || 1437

const out = []
const check = (ok, line) => { out.push(`${ok ? '  ok  ' : ' FAIL '} ${line}`); return ok }
let pass = true

async function open({ grid }) {
  const browser = await webkit.launch()
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('operator.theme', 'mission-control-dark')
      localStorage.setItem('operator.sidebarCollapsed', '1')
    } catch { /* quota */ }
    // RECORD every gridterm call. These are noops in the mock bridge, so the call itself is the
    // only observable — and the call IS the lifecycle the brief asks about.
    window.__grid = []
    let real
    Object.defineProperty(window, 'operator', {
      configurable: true, get: () => real,
      set: (v) => {
        real = v
        for (const fn of ['gridtermAttach', 'gridtermResize', 'gridtermScroll', 'gridtermSetTheme', 'gridtermDetach']) {
          v[fn] = (...args) => { window.__grid.push({ fn, args }) }
        }
      },
    })
  })
  const p = await ctx.newPage()
  p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))
  await p.goto(`http://localhost:${PORT}/dev/mock.html${grid ? '?grid=1' : ''}`, { waitUntil: 'load' })
  await p.waitForSelector('[data-rail]')
  await p.waitForTimeout(1200)
  await p.click('[data-rail-session]')
  await p.waitForTimeout(900)
  return { browser, p }
}

/** Which pane is mounted, asked of the DOM rather than of a prop.
 *
 *  `.xterm-screen` ALONE CANNOT ANSWER THIS: the grid pane's key encoder is itself a real xterm
 *  and paints a screen of its own, so a naive count finds one in grid mode too and every
 *  assertion below would pass on the wrong evidence. An xterm PANE is an `.xterm-screen` that is
 *  not inside a `[data-grid-pane]`. (`.gt-row` cannot answer it either: no `gridterm:update` is
 *  ever emitted here, so a correctly-mounted grid pane has zero rows.) */
const panes = (p) => p.evaluate(() => ({
  xterm: [...document.querySelectorAll('.xterm-screen')].filter((el) => !el.closest('[data-grid-pane]')).length,
  grid: document.querySelectorAll('[data-grid-pane]').length,
  gridRows: document.querySelectorAll('.gt-row').length,
}))
const calls = (p) => p.evaluate(() => window.__grid.map((c) => c.fn))

// ── G1: the default install ─────────────────────────────────────────────────────────────────
{
  const { browser, p } = await open({ grid: false })
  const seen = await calls(p)
  const dom = await panes(p)
  pass = check(seen.length === 0, `G1 pref OFF: no gridterm call of any kind — ${seen.length} made`) && pass
  pass = check(dom.xterm > 0 && dom.grid === 0,
    `G1 pref OFF: the xterm pane is mounted and no grid pane exists (${dom.xterm} xterm panes, ${dom.grid} grid)`) && pass
  await browser.close()
}

// ── G2 + G3: the opt-in path ────────────────────────────────────────────────────────────────
{
  const { browser, p } = await open({ grid: true })
  const mounted = await panes(p)
  pass = check(mounted.grid > 0 && mounted.xterm === 0,
    `G2 pref ON: the GRID pane is mounted in place of the xterm one (${mounted.grid} grid, ${mounted.xterm} xterm)`) && pass
  pass = check(mounted.gridRows === 0,
    `G2 and no rows are painted — the mock emits no gridterm:update, by design (${mounted.gridRows} rows)`) && pass

  let seen = await calls(p)
  pass = check(seen.includes('gridtermAttach'), `G2/G3 attach: fired on becoming active — calls so far [${seen.join(', ')}]`) && pass
  const att = await p.evaluate(() => window.__grid.find((c) => c.fn === 'gridtermAttach')?.args)
  pass = check(att && att[1] > 20 && att[2] > 5,
    `G3 attach carries a measured grid, not a placeholder — ${att?.[1]}×${att?.[2]} cols×rows`) && pass

  // THEME — the brief names set_theme explicitly. ⌘K → the palette action.
  await p.evaluate(() => { window.__grid.length = 0 })
  await p.evaluate(() => {
    const key = localStorage.getItem('operator.theme') === 'mission-control-light' ? 'mission-control-dark' : 'mission-control-light'
    localStorage.setItem('operator.theme', key)
    window.dispatchEvent(new StorageEvent('storage', { key: 'operator.theme', newValue: key }))
  })
  // The app applies the theme from its own state, so drive it the way a person does instead:
  // the toolbar's theme toggle lives in the rail's foot.
  await p.click('[data-rail-theme]')
  await p.waitForTimeout(700)
  seen = await calls(p)
  pass = check(seen.includes('gridtermSetTheme'), `G3 theme: set_theme fired on a theme change — [${seen.join(', ')}]`) && pass

  // RESIZE — the pane's own ResizeObserver drives this; resize the window under it.
  await p.evaluate(() => { window.__grid.length = 0 })
  await p.setViewportSize({ width: 1080, height: 760 })
  await p.waitForTimeout(900)
  seen = await calls(p)
  pass = check(seen.includes('gridtermResize'), `G3 resize: resize fired when the pane changed size — [${seen.join(', ')}]`) && pass

  // G4 — flipping the pref must NOT swap the pane under a running session.
  await p.evaluate(() => { window.__grid.length = 0; localStorage.setItem('operator.terminal.renderer', 'xterm') })
  await p.waitForTimeout(600)
  const dom = await panes(p)
  pass = check(dom.grid > 0 && dom.xterm === 0,
    `G4: the pref flipped to xterm mid-session and the live pane did NOT change (${dom.grid} grid, ${dom.xterm} xterm)`) && pass
  const detached = (await calls(p)).includes('gridtermDetach')
  pass = check(!detached, `G4: nothing detached the live grid core on a pref change`) && pass

  // DETACH on unmount — by CLOSING the lane, which is the only thing that actually unmounts a
  // pane (every terminal stays mounted across mode switches, by design). It has to be driven
  // through the real control: the close button lives on the expanded sidebar's row, appears on
  // hover, and takes two clicks — the second confirms. Navigating away instead would tear down
  // the JS context without ever running React's cleanup, so it could not observe this at all.
  await p.keyboard.press('Meta+b')          // expand the strip — the rail's orbs have no close
  await p.waitForTimeout(700)
  await p.evaluate(() => { window.__grid.length = 0 })
  const row = await p.$('[data-rail-orb]')
  await row?.hover()
  await p.waitForTimeout(250)
  await p.click('button[title="Close session"]')
  await p.waitForTimeout(250)
  await p.click('button[title="Click again to confirm"]')
  await p.waitForTimeout(900)
  seen = await calls(p)
  const left = await panes(p)
  pass = check(seen.includes('gridtermDetach'),
    `G3 detach: detach fired when the pane unmounted — [${seen.join(', ')}], ${left.grid} grid panes left`) && pass
  await browser.close()
}

console.log(out.join('\n'))
console.log(pass ? '\nGRIDTERM WIRE: all assertions pass' : '\nGRIDTERM WIRE: FAILED')
process.exit(pass ? 0 : 1)
