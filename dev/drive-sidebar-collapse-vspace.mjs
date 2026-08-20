// Brief: dev/briefs/2026-08-20-sidebar-collapse-terminal-vspace.md
//
// "Collapsing the sidebar leaves the terminal with wrong vertical space" — content sits in the
// upper ~half of the pane, a large empty band below the composer, and a partial top row cut
// mid-line. Columns looked right. Verify + report only, no product code changes.
//
// This measures, per renderer path, at t = 0/100/260/320/500/1000/2000ms after the toggle:
//   - the terminal host element's rect vs the content column's rect (LAYOUT hypothesis)
//   - xterm: rendered row count (`.xterm-rows > div`) + every terminalResize call (args + when)
//   - grid: host clientWidth/clientHeight + every gridtermResize/gridtermAttach call
//
// Run: MOCK_PORT=1430 node dev/drive-sidebar-collapse-vspace.mjs
import { webkit } from 'playwright'

const PORT = process.env.MOCK_PORT || 1430
const SAMPLE_TIMES = [0, 100, 260, 320, 500, 1000, 2000]

const out = []
const log = (line) => { out.push(line); console.log(line) }

// ---- shared page setup ------------------------------------------------------------------
async function openPage({ grid, streaming }) {
  const browser = await webkit.launch()
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await ctx.addInitScript(() => {
    window.__calls = [] // {fn, args, t: performance.now()}
    let real
    Object.defineProperty(window, 'operator', {
      configurable: true, get: () => real,
      set: (v) => {
        real = v
        for (const fn of ['terminalResize', 'gridtermResize', 'gridtermAttach']) {
          const orig = v[fn]?.bind(v)
          v[fn] = (...args) => {
            window.__calls.push({ fn, args, t: performance.now() })
            return orig ? orig(...args) : undefined
          }
        }
      },
    })
  })
  const p = await ctx.newPage()
  const pageErrors = []
  p.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)))
  p.on('crash', () => pageErrors.push('PAGE CRASHED'))

  await p.goto(`http://localhost:${PORT}/dev/mock.html${grid ? '?grid=1' : ''}`, { waitUntil: 'load' })
  await p.waitForSelector('[data-rail]')
  await p.waitForTimeout(1200)

  // Sidebar starts EXPANDED by default (no localStorage key set) — the state we're collapsing FROM.
  const collapsedNow = await p.evaluate(() => !!document.querySelector('[data-rail][data-rail-collapsed]'))
  if (collapsedNow) throw new Error('rail unexpectedly collapsed at boot — driver assumption broken')

  // Activate a lane's terminal — mainView defaults to 'terminal', so this alone lands us on it.
  // `[data-rail-session]` only exists on the COLLAPSED rail's orb; expanded (our starting state)
  // renders `[data-lane-row]` (roleId) / `[data-session-row]` (ad-hoc) rows instead.
  await p.click('[data-lane-row], [data-session-row]')
  await p.waitForTimeout(900)
  // The mount path's `ensureInitialFit` calls terminalResize(id, cols, rows) once immediately
  // (xterm) / `gridtermAttach` fires with the id (grid) — read the id back off our own spy
  // rather than guessing the roleId→terminalId mapping.
  const terminalId = await p.evaluate((grid) => {
    const fn = grid ? 'gridtermAttach' : 'terminalResize'
    return window.__calls.find((c) => c.fn === fn)?.args?.[0] ?? null
  }, grid)
  if (!terminalId) throw new Error(`could not learn terminalId from mount-time ${grid ? 'gridtermAttach' : 'terminalResize'} calls`)

  if (!grid) {
    // Fill the pane with enough lines that a rows-vs-content mismatch would be visible in a
    // real screenshot (we can't screenshot the mismatch here, but a short buffer couldn't
    // produce "content in the upper half" even if rows were wrong).
    const fill = Array.from({ length: 80 }, (_, i) => `line ${i} ${'x'.repeat(120)}`).join('\r\n') + '\r\n'
    await p.evaluate(({ id, text }) => window.__mockTerminalData(id, text), { id: terminalId, text: fill })
    await p.waitForTimeout(400) // let it render + quiet down past FIT_QUIET_MS (150ms)
  }

  let streamTimer = null
  if (streaming) {
    // Simulate output actively streaming through the toggle+sampling window, which is what
    // gates fits behind FIT_QUIET_MS (150ms) in TerminalPane's handleResize.
    let n = 0
    streamTimer = setInterval(() => {
      p.evaluate(({ id, i }) => window.__mockTerminalData(id, `tick ${i}\r\n`), { id: terminalId, i: n++ }).catch(() => {})
    }, 60)
  }

  return { browser, p, terminalId, pageErrors, stopStreaming: () => { if (streamTimer) clearInterval(streamTimer) } }
}

// ---- per-frame snapshot -------------------------------------------------------------------
const snapshot = (p, grid) => p.evaluate((grid) => {
  const rail = document.querySelector('[data-rail]')
  const railRect = rail?.getBoundingClientRect()
  const collapsedAttr = rail?.hasAttribute('data-rail-collapsed') ?? null
  const colEl = document.querySelector('[data-term-focus-zone]')
  const colRect = colEl?.getBoundingClientRect()

  if (!grid) {
    const screen = [...document.querySelectorAll('.xterm-screen')]
      .find((el) => !el.closest('[data-grid-pane]') && getComputedStyle(el).visibility !== 'hidden')
    const screenRect = screen?.getBoundingClientRect()
    const xtermRoot = screen?.closest('.terminal.xterm')
    const hostRect = xtermRoot?.parentElement?.getBoundingClientRect()
    const rowsEl = screen?.querySelector('.xterm-rows')
    const rowCount = rowsEl ? rowsEl.children.length : null
    // xterm-rows may carry a transform (scroll offset); a non-zero, non-integer-cell offset
    // is the DOM fingerprint of a "partial row" clip.
    const rowsTransform = rowsEl ? getComputedStyle(rowsEl).transform : null
    return {
      railWidth: railRect?.width ?? null, collapsedAttr,
      colRect: colRect ? { top: colRect.top, left: colRect.left, width: colRect.width, height: colRect.height } : null,
      hostRect: hostRect ? { top: hostRect.top, left: hostRect.left, width: hostRect.width, height: hostRect.height } : null,
      screenRect: screenRect ? { top: screenRect.top, left: screenRect.left, width: screenRect.width, height: screenRect.height } : null,
      rowCount, rowsTransform,
    }
  } else {
    const wrap = document.querySelector('[data-grid-pane]')
    const host = wrap?.children?.[1] // [inputRef, hostRef]
    const hostRect = host?.getBoundingClientRect()
    return {
      railWidth: railRect?.width ?? null, collapsedAttr,
      colRect: colRect ? { top: colRect.top, left: colRect.left, width: colRect.width, height: colRect.height } : null,
      hostRect: hostRect ? { top: hostRect.top, left: hostRect.left, width: hostRect.width, height: hostRect.height } : null,
      hostClientWidth: host?.clientWidth ?? null, hostClientHeight: host?.clientHeight ?? null,
    }
  }
}, grid)

const callsSoFar = (p) => p.evaluate(() => window.__calls.map((c) => ({ fn: c.fn, args: c.args, t: c.t - (window.__toggleT0 ?? 0) })))

// ---- one full run: toggle + sample at every target time -----------------------------------
async function runPass(label, { grid, streaming }) {
  log(`\n=== ${label} ===`)
  const { browser, p, terminalId, pageErrors, stopStreaming } = await openPage({ grid, streaming })

  const baseline = await snapshot(p, grid)
  log(`baseline  rail ${baseline.railWidth}px collapsed=${baseline.collapsedAttr}  col ${JSON.stringify(baseline.colRect)}`)
  log(`baseline  host ${JSON.stringify(baseline.hostRect)}`)
  if (!grid) log(`baseline  screen ${JSON.stringify(baseline.screenRect)}  rows=${baseline.rowCount}`)

  await p.evaluate(() => { window.__calls.length = 0 })
  // `__calls[].t` is `performance.now()` — PAGE time since navigation, not since this toggle.
  // Stamp a page-side zero point atomically with the key press so later offsets are apples-to-
  // apples; a Node-side `Date.now()` compared against page-side `performance.now()` (my first
  // pass at this driver did exactly that) is two different clocks and produces bogus deltas.
  await p.evaluate(() => { window.__toggleT0 = performance.now() })
  const t0 = Date.now()
  await p.keyboard.press('Meta+b') // collapse
  const samples = []
  for (const target of SAMPLE_TIMES) {
    const wait = target - (Date.now() - t0)
    if (wait > 0) await p.waitForTimeout(wait)
    const snap = await snapshot(p, grid)
    const calls = await callsSoFar(p)
    samples.push({ target, actualElapsed: Date.now() - t0, snap, calls })
  }
  stopStreaming()

  for (const s of samples) {
    const { snap } = s
    const resizeCalls = s.calls.filter((c) => c.fn === (grid ? 'gridtermResize' : 'terminalResize'))
    const lastResize = resizeCalls[resizeCalls.length - 1]
    if (!grid) {
      log(`t=${String(s.target).padStart(4)}ms (actual ${s.actualElapsed}ms)  rail=${snap.railWidth?.toFixed(1)}px collapsed=${snap.collapsedAttr}`
        + `  col=${snap.colRect?.width?.toFixed(1)}x${snap.colRect?.height?.toFixed(1)} host=${snap.hostRect?.width?.toFixed(1)}x${snap.hostRect?.height?.toFixed(1)}@top${snap.hostRect?.top?.toFixed(1)}`
        + `  screen=${snap.screenRect?.width?.toFixed(1)}x${snap.screenRect?.height?.toFixed(1)} rows=${snap.rowCount}`
        + `  resizeCalls=${resizeCalls.length}${lastResize ? ` last=[${lastResize.args.join(',')}]@${lastResize.t.toFixed(0)}ms` : ''}`)
    } else {
      log(`t=${String(s.target).padStart(4)}ms (actual ${s.actualElapsed}ms)  rail=${snap.railWidth?.toFixed(1)}px collapsed=${snap.collapsedAttr}`
        + `  col=${snap.colRect?.width?.toFixed(1)}x${snap.colRect?.height?.toFixed(1)} host=${snap.hostRect?.width?.toFixed(1)}x${snap.hostRect?.height?.toFixed(1)} host.clientWH=${snap.hostClientWidth}x${snap.hostClientHeight}`
        + `  resizeCalls=${resizeCalls.length}${lastResize ? ` last=[${lastResize.args.join(',')}]@${lastResize.t.toFixed(0)}ms` : ''}`)
    }
  }

  const allCalls = samples[samples.length - 1].calls
  log(`all IPC calls (fn@t, args) over ${SAMPLE_TIMES[SAMPLE_TIMES.length - 1]}ms window:`)
  for (const c of allCalls) log(`    ${c.t.toFixed(0)}ms  ${c.fn}(${c.args.join(', ')})`)

  // Height across the whole window — did it EVER change? (root is `height: 100vh`, rail only
  // animates width, so the null hypothesis is "never".)
  const heights = samples.map((s) => s.snap.colRect?.height).filter((h) => h != null)
  const heightStable = new Set(heights.map((h) => Math.round(h))).size === 1
  log(`content-column height stable across the whole window: ${heightStable} (values: ${[...new Set(heights.map((h) => h.toFixed(1)))].join(', ')})`)

  if (!grid) {
    const rowCounts = samples.map((s) => s.snap.rowCount)
    const rowsStable = new Set(rowCounts).size === 1
    log(`xterm row COUNT stable across the whole window: ${rowsStable} (values: ${[...new Set(rowCounts)].join(', ')})`)
  }

  if (pageErrors.length) log(`console/page errors: ${JSON.stringify(pageErrors)}`)

  await browser.close()
  return { baseline, samples, terminalId }
}

await runPass('XTERM path — idle (no streaming output during toggle)', { grid: false, streaming: false })
await runPass('XTERM path — STREAMING output during toggle', { grid: false, streaming: true })
await runPass('GRID path — idle', { grid: true, streaming: false })

console.log('\n--- raw log above; see dev/briefs/2026-08-20-sidebar-collapse-terminal-vspace-RESULT.md for the verdict ---')
