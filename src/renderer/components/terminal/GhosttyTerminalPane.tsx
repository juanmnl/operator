import { useCallback, useEffect, useRef, useState } from 'react'
import { init, Terminal, FitAddon } from 'ghostty-web'
import type { ITerminalOptions } from 'ghostty-web'
import type { ITheme } from '@xterm/xterm'
import { TERMINAL_FONT_FAMILY } from '../../lib/terminal-options'
import { base64ToBytes } from '../../lib/base64'
import { stripOrnaments } from '../../lib/terminal'
import { persistFiles } from '../../lib/paste-image'
import { isAppChord } from '../../lib/key-routing'

// Ghostty terminal pane (SPIKE) — uses ghostty-web: the real Ghostty VT engine
// compiled to WASM, with an xterm.js-compatible API and a Canvas-2D renderer. The
// open question this spike answers: does that Canvas-2D path render cleanly in
// WKWebView (where xterm's WebGL/canvas corrupted)? If yes, this is a drop-in that's
// a more correct + complete terminal than both xterm and our DOM grid.

// Claude Code centers a decorative, cycling ornament on the composer divider
// (historically 👀/👣; newer builds cycle other pictographs). ghostty renders to
// Canvas-2D via the browser's font fallback, so any pictograph that neither the bundled
// subsets NOR the system Apple Color Emoji cover falls to a LastResort "tofu" box (the
// two ⍰ seen on the divider). The old xterm pane STRIPPED these on every write path; the
// ghostty migration dropped that — restore it via the shared `stripOrnaments` (see
// lib/terminal for the rationale) on both live output AND replayed history.
const decoder = new TextDecoder()

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
  // Latest theme WITHOUT making it a construction-effect dep. A live theme change used
  // to tear the terminal down and rebuild it (ghostty-web can't live-swap themes), and
  // that rebuild replays the whole scrollback through term.write — which can hang the
  // ghostty WASM parser and FREEZE the app (observed on every theme toggle). So a theme
  // change no longer rebuilds: the terminal keeps its current colours until the next real
  // rebuild (relaunch / ⇧⌘R / auto-heal), which reads this ref for the up-to-date theme.
  const themeRef = useRef(theme)
  themeRef.current = theme
  // Latest `active` for the resize path. Only the VISIBLE pane needs to fit on a
  // sidebar/window resize — fitting the hidden panes too means N ghostty grid
  // reallocs per toggle (N = open sessions), each a chance to trip the WASM
  // resize/render hang. Hidden panes fit when they become active (the effect below).
  const activeRef = useRef(active)
  activeRef.current = active
  // Bumping buildId tears down + recreates the Terminal (the mount effect deps on it).
  // Both the manual reload and the auto-heal watchdog funnel through this one lever —
  // the pty is backend-owned, so a rebuild replays retained scrollback and loses nothing.
  const [buildId, setBuildId] = useState(0)
  // The watchdog gave up after MAX_HEAL_ATTEMPTS → show the manual recovery overlay.
  const [degraded, setDegraded] = useState(false)
  const [hovered, setHovered] = useState(false)
  // Sticky-bottom scrollback: true while the user has scrolled up during a live stream
  // (write-snap suppressed). `jumpRef` re-anchors to the bottom; set inside the mount effect.
  const [scrolledUp, setScrolledUp] = useState(false)
  const jumpRef = useRef<() => void>(() => {})
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
        theme: themeRef.current as unknown as ITerminalOptions['theme'],
      })
      termRef.current = term
      const fit = new FitAddon()
      fitRef.current = fit
      // Never fit on a degenerate/transient container size (mid-layout, hidden, ~0-width):
      // a fit measures a tiny box → resizes the grid to a degenerate shape → another chance
      // to trip the ghostty resize/render hang. Skip until the box is real; a later fit
      // (ResizeObserver / activation / settle) sizes it correctly.
      const safeFit = () => {
        const el = ref.current
        if (!el || el.clientWidth < 24 || el.clientHeight < 24) return
        try { fit.fit() } catch { /* ignore */ }
      }
      term.loadAddon(fit)
      term.open(ref.current)
      safeFit()

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

      // NOTE (2026-07-02): we used to force a full-canvas redraw ~10×/sec during streaming
      // by invalidating `renderer.lastViewportY = -1` ("scheduleCleanRepaint"). That fought
      // the engine's OWN render loop: ghostty runs a continuous rAF that already redraws
      // every dirty row (proper per-row dirty tracking) and force-redraws all rows on
      // resize/scroll. The forced full redraws were redundant and a prime suspect for the
      // WebContent CPU peg → watchdog kill → reload churn. Removed — we now drive ghostty
      // the way its reference consumer (coder's Mux) does: just `write()` and let the loop
      // paint. The overprint this once masked was the spawn-size reflow, fixed at the root
      // (the pty opens at the pane's final width; see terminal_spawn).

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
        // Skip while suspended (panel drag), AND for hidden panes — only the active
        // pane refits on resize; the rest fit when activated (avoids N reallocs/toggle).
        if (suspendFitRef.current || !activeRef.current) return
        clearTimeout(fitDebounce)
        fitDebounce = window.setTimeout(safeFit, 100)
      })
      try { resizeObserver.observe(ref.current) } catch { /* ignore */ }
      const onResize = term.onResize((d: { cols: number; rows: number }) => {
        try { window.operator.terminalResize(terminalId, d.cols, d.rows) } catch { /* ignore */ }
      })
      try { window.operator.terminalResize(terminalId, term.cols, term.rows) } catch { /* ignore */ }

      // Replay retained scrollback (re-attach after reload), then live stream.
      window.operator.terminalHistory(terminalId)
        .then((b64) => { if (!disposed && b64) term.write(stripOrnaments(decoder.decode(base64ToBytes(b64)))) })
        .catch(() => { /* none */ })

      // A rebuild (theme change) can run while the card is mid-layout, so the first
      // fit() above may measure a wrong box and the pane collapses. Re-fit once the
      // layout settles.
      // Fit once the layout settles, THEN launch the deferred Claude process at that exact
      // fitted size (see terminal_spawn's DEFERRED LAUNCH). Doing it here — after the box has
      // real dimensions — means the pty width == grid width from Claude's first byte, so its
      // classic-mode output (incl. the whole --resume reprint) never mis-wraps. Idempotent on
      // a rebuild (the backend has no pending command left, so it's a no-op).
      const settle = setTimeout(() => {
        safeFit()
        try { window.operator.terminalStart?.(terminalId, term.cols, term.rows) } catch { /* ignore */ }
      }, 100)

      // Sticky-bottom scrollback. ghostty's write() force-snaps the viewport to the bottom
      // on every chunk while you're scrolled up (writeInternal: `viewportY !== 0 &&
      // scrollToBottom()`), so reading back during a live stream yanks you down. We suppress
      // the snap AT THE SOURCE — override the instance's scrollToBottom to no-op while the
      // user is scrolled up — instead of undoing it after each write (that per-chunk snap →
      // re-anchor thrashed viewportY twice per write and smeared the canvas). onScroll tells
      // us when the user leaves / returns to the bottom; the jump-to-latest button re-anchors.
      const realScrollToBottom = term.scrollToBottom.bind(term)
      const scrollState = { locked: false }
      ;(term as unknown as { scrollToBottom: () => void }).scrollToBottom = () => {
        if (!scrollState.locked) realScrollToBottom()
      }
      jumpRef.current = () => { scrollState.locked = false; setScrolledUp(false); realScrollToBottom() }
      const onScrollSub = (term as unknown as { onScroll?: (cb: (y: number) => void) => { dispose(): void } })
        .onScroll?.((y: number) => {
          const up = y > 0.5
          if (up !== scrollState.locked) { scrollState.locked = up; setScrolledUp(up) }
        })

      const unsubData = window.operator.onTerminalData((id, d) => {
        if (id !== terminalId) return
        term.write(stripOrnaments(d))
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
        clearInterval(watchdog)
        clearTimeout(fitDebounce)
        try { resizeObserver.disconnect() } catch { /* ignore */ }
        unsubData()
        try { onData.dispose() } catch { /* ignore */ }
        try { onResize.dispose() } catch { /* ignore */ }
        try { onScrollSub?.dispose() } catch { /* ignore */ }
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
    // NB: `theme` is intentionally NOT a dep. ghostty-web can't live-swap themes, so a
    // theme change would force a full teardown+rebuild — and that rebuild replays the
    // scrollback through term.write, which can hang the WASM parser and FREEZE the app
    // (it did, on every theme toggle). We accept a stale terminal palette on a live theme
    // change: the terminal keeps its colours until the next real rebuild (relaunch, ⇧⌘R,
    // or auto-heal), which reads `themeRef.current` for the current theme. Only `buildId`
    // (manual reload + watchdog) drives the teardown→recreate path now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId, buildId])

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

  // Fit once when the drag/animation is released (suspendFit → false) OR when this
  // pane becomes active — so it snaps to the final size in a single reflow. Gated on
  // `active`: hidden panes don't fit on a sidebar/window resize (that's N grid reallocs
  // per toggle, each a resize-hang chance); they fit here the moment they're shown. A
  // rAF lets the container's final width settle in layout first.
  useEffect(() => {
    if (suspendFit || !active) return
    const raf = requestAnimationFrame(() => {
      // Same degenerate-size guard as the construction path: don't fit a ~0-width box.
      const el = ref.current
      if (!el || el.clientWidth < 24 || el.clientHeight < 24) return
      try { fitRef.current?.fit() } catch { /* ignore */ }
    })
    return () => cancelAnimationFrame(raf)
  }, [suspendFit, active])

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
  //
  // We send the path(s) via BRACKETED PASTE (ESC[200~ … ESC[201~) rather than as raw
  // typed bytes: Claude Code recognizes an image file path arriving as a PASTE and
  // converts it to a native `[Image #N]` attachment in the input (the same as its
  // window drag-drop), instead of leaving an ugly literal path. Non-image paths just
  // paste as text. terminalWrite goes straight to the pty, so the sequence reaches
  // Claude's stdin intact.
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return
    const paths = await persistFiles(files, window.operator.savePastedImage)
    if (paths.length > 0) {
      window.operator.terminalWrite(terminalId, `\x1b[200~${paths.join(' ')}\x1b[201~`)
    }
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

      {/* Jump to latest — shown while scrolled up during a live stream (the write-snap is
          suppressed so you can read back). Re-anchors to the bottom and resumes following. */}
      {scrolledUp && !degraded && (
        <button
          onClick={() => jumpRef.current()}
          title="Jump to latest output"
          style={{
            position: 'absolute', bottom: 12, right: 16,
            display: 'flex', alignItems: 'center', gap: 5,
            padding: '4px 10px', fontFamily: 'var(--font-body)', fontSize: 11,
            background: 'var(--overlay-medium)', border: '1px solid var(--border)',
            borderRadius: 14, cursor: 'pointer', outline: 'none', color: 'var(--fg)',
            backdropFilter: 'blur(2px)',
          }}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <path d="M8 3v9M8 12l-3.5-3.5M8 12l3.5-3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Latest
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
          fontFamily: "var(--font-body)", textAlign: 'center', padding: 24,
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
