// Measure what moves while the left rail (⌘B) and the right side panel collapse and expand.
//
// For each toggle it records, frame by frame for 700ms:
//   - the rect of the rail, the content card, the session toolbar, the terminal pane and the
//     right panel, and how many frames each one changed width in;
//   - how many rail rows and panel text blocks changed HEIGHT (a height change on a fixed-content
//     block is text rewrapping);
//   - every pty resize the renderer sent (`terminalResize`), with its time from the toggle;
//   - Chromium's own layout counters (LayoutCount / LayoutDuration) across the toggle.
// The app is Electron, i.e. Chromium, so this runs in Playwright's Chromium.
//
// Run: `npx vite --port 1431` then `node dev/drive-panel-collapse-shift.mjs`.
// Env: MOCK_PORT, W (viewport width, default 1440), SCHEME (dark|light), REDUCED=1, SHOTS=dir,
// TRACE=1 (per-frame card width and panel left in the output).
import { chromium } from 'playwright'

const PORT = process.env.MOCK_PORT || 1431
const W = Number(process.env.W || 1440)
const H = 900
const SCHEME = process.env.SCHEME || 'dark'
const REDUCED = process.env.REDUCED === '1'
const SHOTS = process.env.SHOTS || ''

const b = await chromium.launch()
const ctx = await b.newContext({
  viewport: { width: W, height: H }, colorScheme: SCHEME,
  reducedMotion: REDUCED ? 'reduce' : 'no-preference',
})
await ctx.addInitScript((SCHEME) => {
  try {
    localStorage.removeItem('operator.sidebarCollapsed')
    localStorage.removeItem('operator.sessionLayouts')
    // The app's theme is its own setting, not the browser's colour scheme.
    localStorage.setItem('operator.theme', SCHEME === 'light' ? 'mission-control-light' : 'mission-control-dark')
  } catch { /* quota */ }
  window.__ptyResizes = []
  let real
  Object.defineProperty(window, 'operator', {
    configurable: true,
    get: () => real,
    set: (v) => {
      real = v
      const log = (kind) => (id, cols, rows) => window.__ptyResizes.push({ kind, id, cols, rows, t: performance.now() })
      const orig = v.terminalResize
      v.terminalResize = (...a) => { log('pty')(...a); return orig?.(...a) }
      const origG = v.gridtermResize
      v.gridtermResize = (...a) => { log('grid')(...a); return origG?.(...a) }
    },
  })
}, SCHEME)

const p = await ctx.newPage()
p.on('pageerror', (e) => console.log('ERR', String(e).slice(0, 200)))
const cdp = await ctx.newCDPSession(p)
await cdp.send('Performance.enable')
await p.goto(`http://localhost:${PORT}/dev/mock.html`, { waitUntil: 'load' })
await p.waitForTimeout(2500)

// Into a session: open the operator project, then ⌘1 for its first lane.
if (!(await p.$('[data-toolbar-header="session"]'))) {
  await p.keyboard.press('Meta+Shift+O'); await p.waitForTimeout(600)
  await p.locator('[data-project-card]').filter({ hasText: 'operator' }).first().click()
  await p.waitForTimeout(900)
  await p.keyboard.press('Meta+1'); await p.waitForTimeout(1200)
}
if (!(await p.$('[data-toolbar-header="session"]'))) { console.log('FAIL could not reach a session'); await b.close(); process.exit(1) }

// Some lines in the terminal so a rewrap would show.
await p.evaluate(() => {
  const line = 'The quick brown fox jumps over the lazy dog, and the rail collapses underneath it. '
  for (const id of ['t0', 't1', 't2', 't3']) window.__mockTerminalData?.(id, (line.repeat(3) + '\r\n').repeat(12))
})
await p.waitForTimeout(400)

const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]))

async function record(label, trigger, ms = 700) {
  await p.evaluate(() => {
    window.__ptyResizes = []
    const q = (s) => document.querySelector(s)
    const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.width)] }
    const pane = () => {
      const all = Array.from(document.querySelectorAll('.xterm')).filter((x) => x.offsetParent && getComputedStyle(x.closest('[style*="position: absolute"]') || x).visibility !== 'hidden')
      return all[0] || null
    }
    // Every text leaf in the rail, as [left, width] relative to the window. A `nowrap` label that
    // re-truncates changes WIDTH; a centred header or a right-aligned status that follows the edge
    // changes LEFT. Either is the rail's content being re-laid out while it animates.
    const railLeaves = () => Array.from(document.querySelectorAll('[data-rail] *'))
      .filter((e) => e.childElementCount === 0 && e.textContent.trim().length > 0)
      .map((e) => { const b = e.getBoundingClientRect(); return `${Math.round(b.left)}:${Math.round(b.width)}` })
    const railRows = () => Array.from(document.querySelectorAll('[data-rail] button, [data-rail] [role="button"]')).slice(0, 40)
    const panelText = () => {
      const pan = q('[data-side-panel]') || q('[data-toolbar-header="panel"]')?.parentElement
      return pan ? Array.from(pan.querySelectorAll('p, li, span, div')).filter((e) => e.childElementCount === 0 && e.textContent.trim().length > 20).slice(0, 60) : []
    }
    const frames = []
    const t0 = performance.now()
    window.__t0 = t0
    // The toggle's own moment, so every time below is measured from the key/click, not from when
    // recording began (Playwright's click spends ~100ms on actionability checks first).
    window.__tTrigger = null
    const mark = () => { if (window.__tTrigger == null) window.__tTrigger = performance.now() }
    window.addEventListener('keydown', mark, { capture: true, once: true })
    window.addEventListener('mousedown', mark, { capture: true, once: true })
    const tick = () => {
      const now = performance.now()
      const panelEl = q('[data-side-panel]') || q('[data-toolbar-header="panel"]')?.parentElement?.parentElement
      frames.push({
        t: Math.round(now - t0),
        rail: r(q('[data-rail]')),
        card: r(q('[data-term-focus-zone]')),
        toolbar: r(q('[data-toolbar-header="session"]')),
        term: r(pane()),
        panel: r(panelEl),
        railH: railRows().map((e) => Math.round(e.getBoundingClientRect().height)),
        railLeaves: railLeaves(),
        panelH: panelText().map((e) => Math.round(e.getBoundingClientRect().height)),
      })
      if (now - t0 < window.__recordMs) requestAnimationFrame(tick)
    }
    window.__frames = frames
    requestAnimationFrame(tick)
  })
  await p.evaluate((ms) => { window.__recordMs = ms }, ms)
  const before = await metrics()
  await trigger()
  await p.waitForTimeout(ms + 150)
  const after = await metrics()
  const { frames, resizes, t0: tRec, trig } = await p.evaluate(() => ({ frames: window.__frames, resizes: window.__ptyResizes, t0: window.__t0, trig: window.__tTrigger }))
  const t0 = trig ?? tRec
  const off = Math.round(t0 - tRec)
  for (const f of frames) f.t -= off

  // [left, width] per element: how many frames its WIDTH changed on (a relayout of its contents)
  // and how many its LEFT changed on (it moved, which a push layout has to do).
  const changed = (key, idx) => {
    let n = 0; let last
    for (const f of frames) {
      const v = f[key] == null ? 'none' : idx == null ? JSON.stringify(f[key]) : f[key][idx]
      if (last !== undefined && v !== last) n++
      last = v
    }
    return n
  }
  // The window the card's box was in motion, from the toggle.
  const cardMoving = frames.filter((f, i) => i > 0 && JSON.stringify(f.card) !== JSON.stringify(frames[i - 1].card)).map((f) => f.t)
  // Rewrap: a block whose height differs between consecutive frames, counted once per block.
  const rewrapped = (key) => {
    const hit = new Set()
    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1][key]; const c = frames[i][key]
      if (a.length !== c.length) continue
      a.forEach((h, j) => { if (h !== c[j]) hit.add(j) })
    }
    return hit.size
  }
  const first = frames[0]; const last = frames[frames.length - 1]
  const out = {
    label,
    frames: frames.length,
    widthChanges: { rail: changed('rail', 1), card: changed('card', 1), term: changed('term', 1), panel: changed('panel', 1) },
    leftChanges: { card: changed('card', 0), term: changed('term', 0), panel: changed('panel', 0) },
    cardMovingMs: cardMoving.length ? [cardMoving[0], cardMoving[cardMoving.length - 1]] : null,
    start: { rail: first.rail, card: first.card, term: first.term, panel: first.panel },
    end: { rail: last.rail, card: last.card, term: last.term, panel: last.panel },
    rewrapped: { railRows: rewrapped('railH'), panelBlocks: rewrapped('panelH') },
    // Rail text leaves that moved or resized between two frames of the SAME leaf set (the set
    // itself changes once, when \`collapsed\` flips; that frame is not counted).
    railLeavesMoved: (() => {
      const hit = new Set()
      for (let i = 1; i < frames.length; i++) {
        const a = frames[i - 1].railLeaves; const c = frames[i].railLeaves
        if (a.length !== c.length) continue
        a.forEach((v, j) => { if (v !== c[j]) hit.add(j) })
      }
      return hit.size
    })(),
    ptyResizes: resizes.map((x) => ({ kind: x.kind, id: x.id, cols: x.cols, rows: x.rows, atMs: Math.round(x.t - t0) })),
    layouts: after.LayoutCount - before.LayoutCount,
    layoutMs: Math.round((after.LayoutDuration - before.LayoutDuration) * 1000),
    styleRecalcs: after.RecalcStyleCount - before.RecalcStyleCount,
  }
  if (process.env.TRACE) out.trace = frames.map((f) => [f.t, f.card?.[1] ?? null, f.panel?.[0] ?? null])
  console.log(JSON.stringify(out))
  return out
}

const shot = async (name) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}-${SCHEME}-${W}${REDUCED ? '-reduced' : ''}.png` }) }
const panelBtn = () => p.locator('[data-toolbar-header="session"] button[title*="side panel"]').first()

await shot('0-start')
await record('rail collapse (⌘B)', () => p.keyboard.press('Meta+b'))
await shot('1-rail-collapsed')
await record('rail expand (⌘B)', () => p.keyboard.press('Meta+b'))
await record('panel open', () => panelBtn().click())
await shot('2-panel-open')
// Mid-transition frame, for the eye.
if (SHOTS) {
  await panelBtn().click(); await p.waitForTimeout(400)
  await panelBtn().click(); await p.waitForTimeout(90); await shot('3-panel-opening-mid')
  await p.waitForTimeout(600)
  await p.keyboard.press('Meta+b'); await p.waitForTimeout(90); await shot('4-rail-collapsing-mid')
  await p.waitForTimeout(600)
  await p.keyboard.press('Meta+b'); await p.waitForTimeout(600)
}
await record('panel close', () => panelBtn().click())
await b.close()
