import { useEffect, useRef, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { CanvasAddon } from '../../vendor/addon-canvas/xterm-addon-canvas'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import type { ITheme } from '@xterm/xterm'

interface TerminalPaneProps {
  terminalId: string
  theme: ITheme
  active?: boolean
  onTitleChange?: (title: string) => void
}

/** Rough perceived lightness of a #rrggbb background. */
function isLightBackground(bg?: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(bg || '')
  if (!m) return false
  const n = parseInt(m[1], 16)
  const lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)
  return lum > 140
}

export function TerminalPane({ terminalId, theme, active = true, onTitleChange }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const webglRef = useRef<CanvasAddon | null>(null)
  const atlasTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // The WebGL renderer caches rasterized glyphs in a GPU texture atlas. In
  // WKWebView that atlas intermittently corrupts — on reflow, on a DPR change
  // (moving the window between monitors), or as it fills with a long paragraph —
  // which surfaces as stray tofu glyphs and garbled cells near the newest
  // content (the input). clearTextureAtlas() rebuilds it from scratch, so we
  // call it whenever those triggers fire. Debounced so a drag-resize that emits
  // a ResizeObserver tick per frame doesn't re-rasterize every frame.
  const clearAtlasSoon = useCallback(() => {
    if (atlasTimerRef.current) clearTimeout(atlasTimerRef.current)
    atlasTimerRef.current = setTimeout(() => {
      try { webglRef.current?.clearTextureAtlas() } catch { /* renderer gone */ }
    }, 200)
  }, [])

  const handleResize = useCallback(() => {
    // Never fit against a hidden/collapsed container (display:none → 0 width).
    // Doing so would send a ~1-column size to the pty and make Claude Code
    // re-render its TUI narrow, which then sticks in the scrollback.
    const el = containerRef.current
    if (!el || el.offsetWidth < 50 || el.offsetHeight < 20) return
    if (fitRef.current) {
      try {
        fitRef.current.fit()
      } catch {
        // ignore fit errors during teardown
      }
    }
    // The reflow can leave atlas pages keyed to the old geometry; refresh once
    // the resize settles.
    clearAtlasSoon()
  }, [clearAtlasSoon])

  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      theme,
      // Fallback families for glyphs the mono fonts lack. 'Apple Symbols'
      // (monochrome TEXT presentation) is listed BEFORE 'Apple Color Emoji' so
      // technical glyphs Claude Code uses — e.g. the ⏺ tool bullet, ● ◆ ▸ — fall
      // back to a single-width text glyph that stays on the monospace grid,
      // instead of a double-width COLOUR emoji that shoves the line out of
      // alignment. True emoji (no text-presentation form) still reach Apple Color
      // Emoji as the last resort before the generic monospace.
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, 'Apple Symbols', 'Apple Color Emoji', monospace",
      fontSize: 13,
      // Keep this an integer. The WebGL renderer rasterizes glyphs at the font
      // cell height but clears cells at a fractional offset when lineHeight isn't
      // a whole number, so previous rows bleed into new ones (text ghosts/overlaps
      // on every redraw). 1.0 is the only value the GL renderer positions correctly.
      lineHeight: 1.0,
      // SF Mono's 700 bold reads chunky next to its regular; 600 keeps Claude
      // Code's frequent bold emphasis distinct without the clobbered look. Bold
      // stays in the same hue (no bright-colour shift) so it reads as weight only.
      // The canvas renderer rasterizes glyphs heavier than the old WebGL atlas
      // (WebKit's canvas fillText is darker), so the SAME font reads bold/muddy
      // here at the weight that looked crisp under WebGL. Push normal text right
      // down to 100 to net out near the old WebGL-400 crispness; bold stays at 500
      // so emphasis still reads as weight without going chunky next to the lighter
      // body.
      fontWeight: 100,
      fontWeightBold: 500,
      drawBoldTextInBrightColors: false,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
      macOptionIsMeta: true,
      scrollback: 10000,
      // Claude Code emits dim/gray secondary text (rendered at reduced alpha). On
      // a light background that washes out, so push to AA there. On dark, drop the
      // boost entirely (1 = off): the canvas renderer already darkens glyphs, and
      // any contrast lift whitens/thickens the dim text, compounding the bold look.
      minimumContrastRatio: isLightBackground(theme.background) ? 4.5 : 1,
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    // Clicking a link opens it in the system browser (via Tauri's opener);
    // falls back to window.open elsewhere.
    term.loadAddon(new WebLinksAddon((_event, uri) => {
      if (window.operator?.openExternal) window.operator.openExternal(uri)
      else window.open(uri, '_blank')
    }))

    term.open(containerRef.current)

    // SPIKE: Canvas renderer instead of WebGL. The WebGL atlas corrupts in
    // WKWebView (tofu/garbled cells near the input); the 2D-canvas renderer keeps
    // box-drawing/block characters as seamless custom glyphs and rasterizes
    // through the font stack (emoji fallback) WITHOUT a GPU glyph atlas, so it
    // can't hit the atlas-corruption bug at all.
    try {
      const canvas = new CanvasAddon()
      term.loadAddon(canvas)
      webglRef.current = canvas
    } catch {
      // Canvas unavailable — xterm keeps the DOM renderer.
    }

    // Re-assert cursorBlink (loading a renderer addon can reset terminal options).
    term.options.cursorBlink = true

    termRef.current = term
    fitRef.current = fitAddon

    // Fit only once the container actually has width. Fitting against a 0/tiny
    // container sends a tiny column count to the pty, so Claude Code renders its
    // TUI at ~10 cols and that wrapping gets baked into the scrollback.
    const ensureInitialFit = () => {
      const el = containerRef.current
      if (!el) return
      if (el.offsetWidth < 50) {
        requestAnimationFrame(ensureInitialFit)
        return
      }
      try { fitAddon.fit() } catch { /* */ }
      window.operator.terminalResize(terminalId, term.cols, term.rows)
    }
    ensureInitialFit()
    term.focus()

    // Forward keystrokes to pty
    term.onData((data) => {
      window.operator.terminalWrite(terminalId, data)
    })

    // Resize pty on terminal resize
    term.onResize(({ cols, rows }) => {
      window.operator.terminalResize(terminalId, cols, rows)
    })

    // Title changes
    if (onTitleChange) {
      term.onTitleChange(onTitleChange)
    }

    // Receive data from pty — returns unsubscribe function
    const unsubData = window.operator.onTerminalData((id, data) => {
      if (id === terminalId) {
        term.write(data)
      }
    })

    // Resize observer
    const observer = new ResizeObserver(handleResize)
    observer.observe(containerRef.current)

    // A devicePixelRatio change (window dragged to a monitor with a different
    // scale factor) invalidates the GPU glyph atlas — the classic WKWebView
    // corruption trigger. matchMedia on the current resolution fires once when
    // it changes; re-arm after each to keep watching.
    let dprQuery: MediaQueryList | null = null
    const onDprChange = () => { clearAtlasSoon(); watchDpr() }
    const watchDpr = () => {
      dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      dprQuery.addEventListener('change', onDprChange, { once: true })
    }
    watchDpr()

    // Claude Code enables mouse tracking, which makes xterm forward the wheel to
    // the app instead of scrolling. When that's on (and we're not in an
    // alt-screen app that owns the screen), scroll the scrollback ourselves.
    const container = containerRef.current
    const onWheelCapture = (e: WheelEvent) => {
      const t = termRef.current
      if (!t || t.modes.mouseTrackingMode === 'none') return
      if (t.buffer.active.type !== 'normal') return
      const lines = e.deltaMode === 1 ? e.deltaY : e.deltaY / 24
      t.scrollLines(Math.round(lines) || (e.deltaY > 0 ? 1 : -1))
      e.preventDefault()
      e.stopPropagation()
    }
    container.addEventListener('wheel', onWheelCapture, { capture: true, passive: false })

    return () => {
      unsubData()
      observer.disconnect()
      dprQuery?.removeEventListener('change', onDprChange)
      if (atlasTimerRef.current) clearTimeout(atlasTimerRef.current)
      container.removeEventListener('wheel', onWheelCapture, { capture: true } as EventListenerOptions)
      term.dispose()
      termRef.current = null
      fitRef.current = null
      webglRef.current = null
    }
    // `theme` is intentionally excluded — recreating the terminal on a theme
    // change would wipe the scrollback. It's applied in place below instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId, onTitleChange, handleResize, clearAtlasSoon])

  // Apply theme/contrast changes to the live terminal without recreating it.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = theme
    term.options.minimumContrastRatio = isLightBackground(theme.background) ? 4.5 : 1.15
    // Atlas glyphs were rasterized in the old palette; rebuild so cached cells
    // don't linger in stale colours.
    clearAtlasSoon()
  }, [theme, clearAtlasSoon])

  // Focus/blur and refit when active state changes
  useEffect(() => {
    const term = termRef.current
    if (!term) return

    if (active) {
      term.options.cursorBlink = true
      try {
        fitRef.current?.fit()
      } catch {
        // ignore
      }
      term.focus()
    } else {
      term.options.cursorBlink = false
      term.blur()
    }
  }, [active])

  // Handle image drag and drop
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files)
    // `File.path` is a non-standard Electron augmentation; absent in standard
    // (Tauri) webviews, where dropped-file paths simply aren't available.
    const paths = files.map((f) => (f as File & { path?: string }).path).filter(Boolean)
    if (paths.length > 0) {
      // Paste file paths into the terminal
      window.operator.terminalWrite(terminalId, paths.join(' '))
    }
  }, [terminalId])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  // Flush terminal — the content column already provides the rounded inset card,
  // so the terminal just fills it with a little breathing room (no second frame).
  return (
    <div
      ref={containerRef}
      onClick={() => termRef.current?.focus()}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      style={{
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        padding: 6,
      }}
    />
  )
}
