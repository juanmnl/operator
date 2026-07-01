import { useCallback, useEffect, useRef, useState } from 'react'
import { init, Terminal, FitAddon } from 'ghostty-web'
import type { ITerminalOptions } from 'ghostty-web'
import type { ITheme } from '@xterm/xterm'
import { TERMINAL_FONT_FAMILY } from '../../lib/terminal-options'
import { base64ToBytes } from '../../lib/base64'
import { persistFiles } from '../../lib/paste-image'
import { isAppChord } from '../../lib/key-routing'

// Ghostty terminal pane (SPIKE) — uses ghostty-web: the real Ghostty VT engine
// compiled to WASM, with an xterm.js-compatible API and a Canvas-2D renderer. The
// open question this spike answers: does that Canvas-2D path render cleanly in
// WKWebView (where xterm's WebGL/canvas corrupted)? If yes, this is a drop-in that's
// a more correct + complete terminal than both xterm and our DOM grid.

// WASM loads once for the whole app. We also force-load the bundled symbol fonts:
// ghostty renders to Canvas-2D, and canvas fillText only falls back to fonts that are
// ALREADY loaded — the bundled fonts load lazily, so without this ⏺/⎿/👀/✳ etc. tofu.
const SYMBOL_FONTS = ['Operator Symbols', 'Operator Dingbats', 'Operator Legacy', 'Operator Emoji']

// Self-heal: how many consecutive rebuilds the watchdog attempts before it stops and
// shows the manual "stopped responding" prompt. A single ghostty WASM trap is usually
// recoverable by rebuilding the Terminal (a fresh engine handle); repeated failures mean
// the shared WASM module is poisoned (relaunch territory), so we stop thrashing.
const MAX_HEAL_ATTEMPTS = 3

let ghosttyReady: Promise<void> | null = null
function ensureGhostty(): Promise<void> {
  if (!ghosttyReady) {
    ghosttyReady = init().then(async () => {
      try {
        await Promise.all(SYMBOL_FONTS.map((f) =>
          (document.fonts?.load(`13px "${f}"`) ?? Promise.resolve()).catch(() => undefined)))
      } catch { /* no font API */ }
    })
  }
  return ghosttyReady
}

export function GhosttyTerminalPane({ terminalId, theme, active, suspendFit }: { terminalId: string; theme: ITheme; active: boolean; suspendFit?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  // Latest suspendFit without re-running the construction effect (mirrors TerminalPane):
  // the ResizeObserver reads this each callback so a panel drag pauses fitting.
  const suspendFitRef = useRef(suspendFit)
  suspendFitRef.current = suspendFit
  // Bumping buildId tears down + recreates the Terminal (the mount effect deps on it).
  // Both the manual reload and the auto-heal watchdog funnel through this one lever —
  // the pty is backend-owned, so a rebuild replays retained scrollback and loses nothing.
  const [buildId, setBuildId] = useState(0)
  // The watchdog gave up after MAX_HEAL_ATTEMPTS → show the manual recovery overlay.
  const [degraded, setDegraded] = useState(false)
  const [hovered, setHovered] = useState(false)
  // Survives rebuilds so consecutive failed heals accumulate toward the cap; forgiven
  // once a rebuilt canvas stays healthy a few seconds (see watchdog).
  const healAttemptsRef = useRef(0)

  const reload = useCallback(() => {
    healAttemptsRef.current = 0
    setDegraded(false)
    setBuildId((b) => b + 1)
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let disposed = false
    let cleanup = () => {}

    ensureGhostty().then(() => {
      if (disposed || !ref.current) return
      const term = new Terminal({
        fontSize: 13,
        fontFamily: TERMINAL_FONT_FAMILY,
        cursorBlink: true,
        cursorStyle: 'block',
        scrollback: 10000,
        theme: theme as unknown as ITerminalOptions['theme'],
      })
      termRef.current = term
      const fit = new FitAddon()
      fitRef.current = fit
      term.loadAddon(fit)
      term.open(ref.current)
      try { fit.fit() } catch { /* not measured yet */ }

      // Keep app chords out of the pty. ghostty's key handler ENCODES any unhandled
      // ⌘-letter to its bare character and writes it to the pty (then stopPropagation,
      // so the window-level shortcut handler in DashboardView never sees it) — e.g.
      // ⌘Q wrote a literal "q" into the input. attachCustomKeyEventHandler runs first;
      // returning TRUE makes ghostty preventDefault + decline (no pty write) WITHOUT
      // stopPropagation, so the chord bubbles up to DashboardView. We gate on `metaKey`
      // only — Ctrl+<letter> are real terminal control codes (^W werase, ^K kill-line)
      // and MUST reach the pty (same rule as TerminalPane/isAppChord).
      try {
        (term as unknown as { attachCustomKeyEventHandler?: (h: (e: KeyboardEvent) => boolean) => void })
          .attachCustomKeyEventHandler?.((e: KeyboardEvent) => {
            if (e.type !== 'keydown' || !e.metaKey || e.ctrlKey) return false
            // ⌘Q: no native macOS app menu intercepts it, so quit explicitly. Decline
            // either way so the bare "q" never reaches the pty.
            if (e.key === 'q' || e.key === 'Q') { window.operator.quitApp?.(); return true }
            return isAppChord(e)
          })
      } catch { /* API renamed in a future build — chords fall through to the pty */ }

      // Keep ghostty's render loop alive across a transient fault. Its rAF callback
      // runs `renderer.render(...)` and THEN re-arms `requestAnimationFrame`; if
      // render() throws once (a brief out-of-range read while the grid reallocates
      // mid-resize), the re-arm line is skipped and the loop dies PERMANENTLY — the
      // canvas blanks (a resize sets canvas.width, which clears it) and never repaints,
      // while the engine stays alive so getScrollbackLength() (the watchdog probe
      // below) keeps succeeding and we never rebuild. That's the "terminal went blank
      // on resize, no recovery" crash. Swallowing the throw lets the loop re-arm and
      // repaint on the next (post-resize) frame. `renderThrows` is monotonic so the
      // watchdog can see a PERSISTENT fault (throwing every frame) and rebuild instead
      // of spinning on a blank canvas; a one-off resize blip stays well under that bar.
      let renderThrows = 0
      try {
        const renderer = (term as unknown as { renderer?: { render?: (...a: unknown[]) => unknown } }).renderer
        if (renderer && typeof renderer.render === 'function') {
          const origRender = renderer.render.bind(renderer)
          renderer.render = (...a: unknown[]) => {
            try { return origRender(...a) }
            catch (e) {
              renderThrows += 1
              if (renderThrows === 1) console.warn('[ghostty] renderer.render threw — keeping render loop alive', e)
              return undefined
            }
          }
        }
      } catch { /* renderer shape changed in a future build — fall back to the watchdog */ }

      // Clean-repaint after the screen settles. ghostty's Canvas renderer only
      // repaints rows the WASM engine flags dirty; a cursor-positioned overwrite
      // (e.g. Claude Code redrawing its welcome box over the just-printed session-ID
      // line) can change a row WITHOUT it being flagged → the old glyphs show through
      // the new line's gaps = overprint. renderLine fully clears any row it DOES
      // repaint, so the cure is one full-redraw pass over every row.
      //
      // We MUST NOT call `renderer.render()` ourselves to force that — it reads the
      // WASM grid directly and racing the render loop (esp. mid-resize, when the grid
      // is reallocating) reads out-of-bounds WASM memory → a trap that kills the
      // canvas (blank session; a JS try/catch can't catch a WASM memory fault). That
      // was the resize crash. Instead we nudge the engine's OWN loop: invalidating
      // `renderer.lastViewportY` makes its next natural frame take the forceAll path
      // (`g !== lastViewportY` ⇒ every row cleared + redrawn from live state). The
      // loop stays the only thing touching WASM memory, in sync — no race, no crash.
      // Throttled (leading, ≤1 per 100ms) so a live drag-resize stays clean MID-drag,
      // not only on settle, plus a trailing pass 120ms after the burst goes quiet so
      // the final frame is clean even if it landed inside the throttle window.
      let repaintTimer = 0
      let lastRepaintAt = 0
      const doCleanRepaint = () => {
        const r = termRef.current?.renderer as unknown as { lastViewportY?: number } | undefined
        if (r) { try { r.lastViewportY = -1 } catch { /* field renamed in a future build */ } }
      }
      const scheduleCleanRepaint = () => {
        const now = performance.now()
        if (now - lastRepaintAt >= 100) { lastRepaintAt = now; doCleanRepaint() }
        clearTimeout(repaintTimer)
        repaintTimer = window.setTimeout(() => { lastRepaintAt = performance.now(); doCleanRepaint() }, 120)
      }

      // ONE resize path. We own the ResizeObserver (instead of FitAddon's own
      // `observeResize()`) for ONE reason: it must honor suspendFit. During a panel
      // drag the terminal container's width changes every frame; refitting per frame
      // reflows the ghostty grid AND reallocates the canvas backing store / GPU
      // surface each time — in WKWebView that repeated canvas realloc is the
      // compositor-thrash that hangs the app. So while suspendFit is held we skip the
      // fit entirely (the canvas just letterboxes at its old size) and fit ONCE on
      // release (the effect below). Coalesced to one fit per frame; FitAddon.fit()
      // itself no-ops when the computed cols/rows are unchanged. (A SECOND observer
      // alongside observeResize made the two fight — hence replace, don't add.)
      // Debounced 100ms to mirror FitAddon.observeResize's own cadence (so plain
      // window resizes refit exactly as before — no extra canvas reallocs), but
      // gated on suspendFit so a panel drag refits nothing until release.
      let fitDebounce = 0
      const resizeObserver = new ResizeObserver(() => {
        if (suspendFitRef.current) return
        clearTimeout(fitDebounce)
        fitDebounce = window.setTimeout(() => { try { fit.fit() } catch { /* ignore */ } }, 100)
      })
      try { resizeObserver.observe(ref.current) } catch { /* ignore */ }
      const onResize = term.onResize((d: { cols: number; rows: number }) => {
        try { window.operator.terminalResize(terminalId, d.cols, d.rows) } catch { /* ignore */ }
        scheduleCleanRepaint()
      })
      try { window.operator.terminalResize(terminalId, term.cols, term.rows) } catch { /* ignore */ }

      // Replay retained scrollback (re-attach after reload), then live stream.
      window.operator.terminalHistory(terminalId)
        .then((b64) => { if (!disposed && b64) { term.write(base64ToBytes(b64)); scheduleCleanRepaint() } })
        .catch(() => { /* none */ })

      // A rebuild (theme change) can run while the card is mid-layout, so the first
      // fit() above may measure a wrong box and the pane collapses. Re-fit once the
      // layout settles.
      const settle = setTimeout(() => { try { fit.fit() } catch { /* ignore */ } }, 100)

      // NB: ghostty's write() force-snaps the viewport to the bottom on every chunk
      // while you're scrolled up (`viewportY !== 0 && scrollToBottom()`). Counteracting
      // that per-chunk (snap → re-anchor) thrashes viewportY twice per write, and the
      // Canvas renderer doesn't fully clear between those rapid jumps → whole-screen
      // overprint corruption. So we DON'T fight it here: scroll-back during a live
      // stream isn't safe on ghostty. Reading-while-streaming belongs in the Canvas
      // reading panel (clean DOM markdown), not the terminal canvas.
      const unsubData = window.operator.onTerminalData((id, d) => {
        if (id !== terminalId) return
        term.write(d)
        scheduleCleanRepaint()
      })
      const onData = term.onData((d: string) => window.operator.terminalWrite(terminalId, d))

      // No custom wheel handler: in classic mode (which we force for ghostty) its native
      // handleWheel scrolls the viewport through scrollback. A custom handler here only
      // double-scrolled, and ghostty's alt-screen arrow-forwarding can't be salvaged
      // (there's no scrollback to scroll in alt-screen) — classic mode is the real fix.
      if (active) term.focus()

      // Self-heal watchdog. A ghostty WASM trap poisons the engine — every subsequent
      // call throws (a JS try/catch can't catch the original memory fault, but it CAN
      // catch the poisoned-state throw on the next call). The pty is alive in the
      // backend, so a dead canvas is just a dead VIEW: probe a cheap public method once
      // a second, and on throw bump buildId to rebuild + replay scrollback (zero lost
      // work). Cap consecutive rebuilds so a poisoned shared module degrades to the
      // manual overlay instead of thrashing; forgive the counter once a rebuilt canvas
      // stays healthy ~4s so a later unrelated fault gets a fresh retry budget.
      let stableTicks = 0
      let triggered = false
      let lastRenderThrows = 0
      const watchdog = window.setInterval(() => {
        const t = termRef.current
        if (!t) return
        // getScrollbackLength() calls a WASM export (ghostty_terminal_get_scrollback_length),
        // so it THROWS once the engine is poisoned — unlike getViewportY(), which just reads a
        // JS field and would never detect the fault.
        let alive = true
        try { t.getScrollbackLength() } catch { alive = false }
        // Engine alive but render is throwing on (nearly) EVERY frame ⇒ a persistent
        // fault, not a one-off resize blip — the canvas is effectively dead, so route it
        // to the same rebuild path. The wrapper above swallows the throws to keep the loop
        // re-arming; a transient resize throw is a handful per second and stays under the bar.
        const throwsThisTick = renderThrows - lastRenderThrows
        lastRenderThrows = renderThrows
        if (alive && throwsThisTick >= 30) {
          alive = false
          console.warn(`[ghostty] render threw ${throwsThisTick}× in 1s — treating canvas as dead`)
        }
        if (alive) {
          stableTicks += 1
          if (stableTicks >= 4 && healAttemptsRef.current > 0) healAttemptsRef.current = 0
          return
        }
        stableTicks = 0
        if (triggered) return // already requested a rebuild; wait for it to take
        triggered = true
        if (healAttemptsRef.current >= MAX_HEAL_ATTEMPTS) { setDegraded(true); return }
        healAttemptsRef.current += 1
        console.warn(`[ghostty] canvas unresponsive — self-heal rebuild ${healAttemptsRef.current}/${MAX_HEAL_ATTEMPTS}`)
        setBuildId((b) => b + 1)
      }, 1000)

      cleanup = () => {
        clearTimeout(settle)
        clearTimeout(repaintTimer)
        clearInterval(watchdog)
        clearTimeout(fitDebounce)
        try { resizeObserver.disconnect() } catch { /* ignore */ }
        unsubData()
        try { onData.dispose() } catch { /* ignore */ }
        try { onResize.dispose() } catch { /* ignore */ }
        try { fit.dispose() } catch { /* ignore */ }
        try { term.dispose() } catch { /* ignore */ }
        termRef.current = null
        fitRef.current = null
      }
    }).catch((e) => {
      console.error('[ghostty] init failed', e)
      // Construction itself threw (e.g. the shared WASM module is already poisoned).
      // Same capped-retry policy as the watchdog, then degrade.
      if (disposed) return
      if (healAttemptsRef.current >= MAX_HEAL_ATTEMPTS) { setDegraded(true); return }
      healAttemptsRef.current += 1
      setBuildId((b) => b + 1)
    })

    return () => { disposed = true; cleanup() }
    // NB: `theme` is a dep — ghostty-web does NOT support live theme swaps after open()
    // (its handleOptionChange warns + no-ops, and renderer.setTheme didn't repaint
    // existing cells). The reliable path is the one that already works for NEW sessions:
    // the CONSTRUCTOR applies the theme. So on a theme change we tear down and rebuild
    // the terminal, replaying the retained scrollback. Brief flicker, but it actually
    // switches. `theme` is a stable per-variant object, so this fires only on real
    // light/dark / identity changes, not every render. `buildId` is the rebuild lever
    // (manual reload + auto-heal); bumping it re-runs this whole teardown→recreate path.
  }, [terminalId, theme, buildId])

  useEffect(() => { if (active) termRef.current?.focus() }, [active])

  // Clicking anywhere in the main content column (toolbar, footer, the inset padding,
  // empty terminal area) refocuses the terminal input, so keystrokes always reach the
  // agent instead of falling on the floor. Scoped to `[data-term-focus-zone]` so the
  // sidebar and the right Canvas panel keep their own focus; skipped for genuinely
  // interactive controls so buttons/links/inputs still work normally.
  useEffect(() => {
    if (!active) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (!t || !t.closest('[data-term-focus-zone]')) return
      if (t.closest('button, a, input, textarea, select, [role="button"]')) return
      termRef.current?.focus()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [active])

  // Panel drag released (suspendFit → false): fit once so the grid snaps to the
  // final size in a single reflow / single canvas realloc, instead of every frame
  // during the drag. A rAF lets the container's final width settle in layout first.
  useEffect(() => {
    if (suspendFit) return
    const raf = requestAnimationFrame(() => { try { fitRef.current?.fit() } catch { /* ignore */ } })
    return () => cancelAnimationFrame(raf)
  }, [suspendFit])

  // ⇧⌘R rebuilds this pane from retained scrollback (manual escape hatch for a frozen or
  // corrupted canvas). Capture phase so it beats ghostty's textarea key handling; gated
  // on `active` so only the focused pane responds (avoid plain ⌘R = webview reload).
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault()
        e.stopPropagation()
        reload()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active, reload])

  // Image / file drag-and-drop. A dragged macOS screenshot *preview* carries image
  // BYTES, not a file on disk, so we persist them to a temp path via the backend and
  // drop that path into the terminal (parity with iTerm). ghostty-web renders to a
  // Canvas and never wired DnD itself, so we own it on the wrapper. (Needs
  // `dragDropEnabled: false` in tauri.conf so the webview gets HTML5 DnD.)
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return
    const paths = await persistFiles(files, window.operator.savePastedImage)
    if (paths.length > 0) window.operator.terminalWrite(terminalId, paths.join(' ') + ' ')
  }, [terminalId])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  // Inset the canvas so terminal content isn't jammed against the panel edges (the
  // canvas fills its container edge-to-edge; the inset is the padding). FitAddon
  // measures this inner box, so cols/rows fit the padded area.
  return (
    <div
      style={{ position: 'absolute', inset: 0 }}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div ref={ref} style={{ position: 'absolute', top: 6, left: 10, right: 8, bottom: 6 }} />

      {/* Manual reload — hover-revealed so it never sits over content while you read.
          Rebuilds the view from retained scrollback without touching the (live) pty. */}
      {hovered && !degraded && (
        <button
          onClick={reload}
          title="Reload terminal view (⇧⌘R) — the session keeps running"
          style={{
            position: 'absolute', top: 8, right: 12,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 22, height: 22, padding: 0,
            background: 'var(--overlay-subtle)', border: '1px solid var(--border)',
            borderRadius: 4, cursor: 'pointer', outline: 'none',
            color: 'var(--fg-muted)', opacity: 0.7,
          }}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <path d="M13 3.5v3.5h-3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M12.5 7A5 5 0 1 0 13 9.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}

      {/* Recovery overlay — the watchdog rebuilt the canvas MAX_HEAL_ATTEMPTS times and it
          kept failing (the shared WASM module is likely poisoned). The pty is still alive,
          so a reload may still take; if not, the message points at a relaunch. */}
      {degraded && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 12,
          background: 'var(--overlay-medium)', backdropFilter: 'blur(2px)',
          fontFamily: "'Inter', system-ui, sans-serif", textAlign: 'center', padding: 24,
        }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>
            Terminal view stopped responding
          </div>
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', maxWidth: 320, lineHeight: 1.5 }}>
            The session is still running in the background — only the display crashed.
            Reload to rebuild it from scrollback. If it keeps failing, relaunch Operator.
          </div>
          <button
            onClick={reload}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '5px 12px', fontSize: 11, fontWeight: 500, fontFamily: 'inherit',
              background: 'transparent', color: 'var(--accent)',
              border: '1px solid var(--accent)', borderRadius: 5, cursor: 'pointer',
            }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M13 3.5v3.5h-3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M12.5 7A5 5 0 1 0 13 9.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Reload terminal
          </button>
        </div>
      )}
    </div>
  )
}
