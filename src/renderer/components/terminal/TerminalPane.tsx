import { useEffect, useRef, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
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
  }, [])

  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      theme,
      // Trailing emoji/symbol families so glyphs the mono fonts lack (Claude Code's
      // spinner symbols, emoji) fall back to a real glyph instead of tofu (□/??).
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, 'Apple Color Emoji', 'Apple Symbols', monospace",
      fontSize: 13,
      // Keep this an integer. The WebGL renderer rasterizes glyphs at the font
      // cell height but clears cells at a fractional offset when lineHeight isn't
      // a whole number, so previous rows bleed into new ones (text ghosts/overlaps
      // on every redraw). 1.0 is the only value the GL renderer positions correctly.
      lineHeight: 1.0,
      // SF Mono's 700 bold reads chunky next to its regular; 600 keeps Claude
      // Code's frequent bold emphasis distinct without the clobbered look. Bold
      // stays in the same hue (no bright-colour shift) so it reads as weight only.
      fontWeight: 400,
      fontWeightBold: 600,
      drawBoldTextInBrightColors: false,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
      macOptionIsMeta: true,
      scrollback: 10000,
      // Claude Code emits dim/gray secondary text (rendered at reduced alpha). On
      // a light background that washes out, and even on dark the dimmest grays can
      // drop below legibility — lift the floor a touch on dark, push to AA on light.
      minimumContrastRatio: isLightBackground(theme.background) ? 4.5 : 1.15,
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

    // Use the WebGL renderer: it draws box-drawing/block characters as seamless
    // custom glyphs (the input-box borders and separators render as continuous
    // lines, not dashes — the DOM renderer can't do this) and rasterizes glyphs
    // through the font stack so the emoji fallback applies. The context-loss
    // handler disposes the addon if the GL context drops, so xterm falls back to
    // the DOM renderer instead of drawing into a dead context (stale/garbled cells).
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      // WebGL unavailable — xterm keeps the DOM renderer.
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
      container.removeEventListener('wheel', onWheelCapture, { capture: true } as EventListenerOptions)
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // `theme` is intentionally excluded — recreating the terminal on a theme
    // change would wipe the scrollback. It's applied in place below instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId, onTitleChange, handleResize])

  // Apply theme/contrast changes to the live terminal without recreating it.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = theme
    term.options.minimumContrastRatio = isLightBackground(theme.background) ? 4.5 : 1.15
  }, [theme])

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

  // The outer frame inset (--bg-sidebar) lets the terminal sit as a rounded card
  // a few px in from the window edges, separated from the chrome behind it; the
  // inner ref div is where xterm mounts and keeps its own 6px breathing room.
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        overflow: 'hidden',
        background: 'var(--bg-sidebar)',
        padding: 8,
      }}
    >
      <div
        ref={containerRef}
        onClick={() => termRef.current?.focus()}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        style={{
          width: '100%',
          height: '100%',
          boxSizing: 'border-box',
          overflow: 'hidden',
          padding: 6,
          background: 'var(--bg-terminal)',
          // Hairline only — the inset frame + radius carry the separation; a full
          // --border line reads too heavy here.
          border: '1px solid var(--overlay-subtle)',
          borderRadius: 10,
        }}
      />
    </div>
  )
}
