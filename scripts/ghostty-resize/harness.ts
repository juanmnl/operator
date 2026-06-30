// ghostty resize-stress harness. Mounts a real ghostty-web Terminal + FitAddon
// exactly like GhosttyTerminalPane, fills the scrollback, scrolls UP into it
// (viewportY > 0 — the path the production code comments flag as dangerous), then
// hammers the container size while streaming writes. The goal is to deterministically
// reproduce the "app crashed on resize" fault in headless WebKit (same engine family
// as the app's WKWebView) so we can read the actual error instead of guessing.
//
// It records every error it can see (window error, unhandledrejection, console.error,
// and any throw out of the render/resize calls) onto window.__ghosttyErrors, and sets
// window.__ghosttyDone when the stress loop finishes. Driven by capture.mjs.
import { init, Terminal, FitAddon } from 'ghostty-web'

declare global {
  interface Window {
    __ghosttyErrors: string[]
    __ghosttyDone: boolean
    __ghosttyPhase: string
  }
}

const errors: string[] = []
window.__ghosttyErrors = errors
window.__ghosttyDone = false
window.__ghosttyPhase = 'init'

// Phase 6 deliberately injects faults to prove the loop-death mechanism; ignore those.
const INJECTED = 'injected mid-resize render fault'
const record = (label: string, e: unknown) => {
  const msg = e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ''}` : String(e)
  if (msg.includes(INJECTED)) return
  errors.push(`[${label}] ${msg}`)
}

window.addEventListener('error', (ev) => record('window.error', ev.error ?? ev.message))
window.addEventListener('unhandledrejection', (ev) => record('unhandledrejection', ev.reason))
const origConsoleError = console.error.bind(console)
console.error = (...a: unknown[]) => { record('console.error', a.map(String).join(' ')); origConsoleError(...a) }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  window.__ghosttyPhase = 'ghostty-init'
  await init()

  const host = document.getElementById('host')!
  const pane = document.getElementById('pane')!

  const term = new Terminal({
    fontSize: 13,
    fontFamily: "'SF Mono', Menlo, monospace",
    cursorBlink: true,
    cursorStyle: 'block',
    scrollback: 10000,
    theme: { background: '#0b0d10', foreground: '#d7d7de' },
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(host)
  try { fit.fit() } catch (e) { record('fit.initial', e) }
  try { fit.observeResize() } catch (e) { record('observeResize', e) }

  // Mirror the production clean-repaint nudge so the harness exercises the same
  // lastViewportY invalidation path GhosttyTerminalPane uses.
  const nudge = () => {
    const r = (term as unknown as { renderer?: { lastViewportY?: number } }).renderer
    if (r) { try { r.lastViewportY = -1 } catch { /* renamed */ } }
  }

  term.onResize((d: { cols: number; rows: number }) => { nudge() })

  // 1) Fill the scrollback so viewportY can be > 0.
  window.__ghosttyPhase = 'fill'
  for (let i = 0; i < 600; i++) {
    term.write(`line ${String(i).padStart(4, '0')}  the quick brown fox jumps over the lazy dog  ╭──┤ box ├──╮  ⏺ ⎿ ✔\r\n`)
  }
  await sleep(100)

  // 2) Scroll UP into scrollback — the dangerous state per the production comments.
  window.__ghosttyPhase = 'scroll-up'
  try { term.scrollLines(-200) } catch (e) { record('scrollLines', e) }
  await sleep(50)

  // 3) Hammer the container size while streaming writes — simulate a drag-resize.
  // Shrink toward very small (few cols/rows), then grow back, repeatedly, writing
  // chunks between frames so resize and write interleave with the rAF render loop.
  window.__ghosttyPhase = 'resize-stress'
  const widths = [720, 520, 360, 220, 140, 90, 60, 90, 140, 260, 480, 720]
  const heights = [420, 320, 220, 140, 90, 60, 40, 60, 120, 240, 360, 420]
  for (let pass = 0; pass < 8; pass++) {
    for (let i = 0; i < widths.length; i++) {
      pane.style.width = `${widths[i]}px`
      pane.style.height = `${heights[i]}px`
      // Force the ResizeObserver/fit + a write in the same tick window.
      try { fit.fit() } catch (e) { record('fit.stress', e) }
      try {
        term.write(`pass ${pass} step ${i}  streaming output while resizing… ✦ ✻ ✗ 🚀 🎯\r\n`)
      } catch (e) { record('write.stress', e) }
      nudge()
      // Probe the same liveness export the production watchdog uses.
      try { (term as unknown as { getScrollbackLength(): number }).getScrollbackLength() } catch (e) { record('getScrollbackLength.probe', e) }
      await sleep(16)
    }
    // Occasionally scroll while small, then keep resizing — viewportY clamping
    // across a shrink is a prime out-of-range suspect.
    try { term.scrollLines(-50) } catch (e) { record('scrollLines.stress', e) }
  }

  // 4) Resize while genuinely scrolled UP and IDLE (no writes to snap us back to
  // bottom). This is the state the production code flags: viewportY > 0, then the
  // grid reallocates under the render loop. scrollback rows get re-indexed across
  // a shrink → out-of-range read is the suspect.
  window.__ghosttyPhase = 'scroll-then-resize-idle'
  try { term.scrollToTop() } catch (e) { record('scrollToTop', e) }
  await sleep(30)
  for (let pass = 0; pass < 6; pass++) {
    for (let i = 0; i < widths.length; i++) {
      pane.style.width = `${widths[i]}px`
      pane.style.height = `${heights[i]}px`
      try { fit.fit() } catch (e) { record('fit.idle', e) }
      nudge()
      // Re-anchor near the top after each resize (a shrink clamps viewportY).
      try { term.scrollToTop() } catch (e) { record('scrollToTop.stress', e) }
      try { (term as unknown as { getScrollbackLength(): number }).getScrollbackLength() } catch (e) { record('probe.idle', e) }
      await sleep(16)
    }
  }

  // 5) Huge single write mid-resize — forces ghostty_wasm_alloc to grow WASM
  // memory, which DETACHES memory.buffer; any view the render loop cached over the
  // old buffer then throws on access. Resize in the same frame to maximize overlap.
  window.__ghosttyPhase = 'big-write-resize'
  const big = ('x'.repeat(200) + '  ⏺ ✔ 🚀\r\n').repeat(4000)
  for (let i = 0; i < 6; i++) {
    pane.style.width = i % 2 ? '180px' : '700px'
    pane.style.height = i % 2 ? '120px' : '400px'
    try { fit.fit() } catch (e) { record('fit.bigwrite', e) }
    try { term.write(big) } catch (e) { record('write.big', e) }
    nudge()
    await sleep(8)
  }
  await sleep(100)

  window.__ghosttyPhase = 'settle'
  pane.style.width = '720px'
  pane.style.height = '420px'
  try { fit.fit() } catch (e) { record('fit.settle', e) }
  await sleep(200)

  // 6) Prove, on ghostty's REAL rAF loop, both the death mechanism and the fix.
  // The loop runs `renderer.render()` then re-arms requestAnimationFrame; a single
  // throw out of render() skips the re-arm → loop dies permanently (blank canvas,
  // engine still alive). We measure "frames" by counting render() invocations.
  const renderer = (term as unknown as { renderer: { render: (...a: unknown[]) => unknown } }).renderer
  const REAL = renderer.render.bind(renderer)
  const report = window as unknown as { __wrappedFrames: number; __unwrappedFrames: number }

  // Phase A — WRAPPED (the production fix): the loop calls a try/catch wrapper around
  // a render that throws once. The throw is swallowed, the loop re-arms, frames keep
  // counting. Runs first, while the loop is healthy.
  window.__ghosttyPhase = 'verify-wrapped'
  {
    let frames = 0
    let armed = true
    renderer.render = (...a: unknown[]) => {
      frames += 1
      try {
        if (armed) { armed = false; throw new Error('injected mid-resize render fault') }
        return REAL(...a)
      } catch { return undefined } // production swallow → loop survives
    }
    await sleep(400)
    report.__wrappedFrames = frames
    renderer.render = REAL // restore a clean loop before the destructive phase
    await sleep(60)
  }

  // Phase B — UNWRAPPED (today's behavior): inject one throw with NO swallow. The
  // throw escapes the rAF callback before it re-arms → the loop dies and render()
  // stops being called. Destructive, so it runs LAST.
  window.__ghosttyPhase = 'verify-unwrapped'
  {
    let armed = true
    renderer.render = (...a: unknown[]) => {
      if (armed) { armed = false; throw new Error('injected mid-resize render fault') }
      return REAL(...a)
    }
    await sleep(120) // let the poisoned frame fire and kill the loop
    let frames = 0
    const counting = renderer.render
    renderer.render = (...a: unknown[]) => { frames += 1; return counting(...a) }
    await sleep(400)
    report.__unwrappedFrames = frames // expect ~0 if the loop died
  }

  window.__ghosttyPhase = 'done'
  window.__ghosttyDone = true
}

main().catch((e) => { record('main', e); window.__ghosttyDone = true })
