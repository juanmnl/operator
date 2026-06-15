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
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.3,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
      macOptionIsMeta: true,
      scrollback: 10000,
      // Claude Code emits dim/gray secondary text tuned for dark terminals; on a
      // light background that washes out. Force a readable contrast in light mode.
      minimumContrastRatio: isLightBackground(theme.background) ? 4.5 : 1,
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(new WebLinksAddon())

    term.open(containerRef.current)

    // Try WebGL, fall back to canvas
    try {
      term.loadAddon(new WebglAddon())
    } catch {
      // WebGL not available, using canvas renderer
    }

    // Re-assert cursorBlink after WebGL addon (can reset it)
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
    term.options.minimumContrastRatio = isLightBackground(theme.background) ? 4.5 : 1
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
