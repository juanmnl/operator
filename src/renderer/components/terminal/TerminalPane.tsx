import { useEffect, useRef, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import type { ITheme } from '@xterm/xterm'

interface TerminalPaneProps {
  terminalId: string
  theme: ITheme
  active?: boolean
  onTitleChange?: (title: string) => void
  /** Fires with the port when a dev server announces itself in the output. */
  onDevServerDetected?: (port: number) => void
}

/** Rough perceived lightness of a #rrggbb background. */
function isLightBackground(bg?: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(bg || '')
  if (!m) return false
  const n = parseInt(m[1], 16)
  const lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)
  return lum > 140
}

export function TerminalPane({ terminalId, theme, active = true, onTitleChange, onDevServerDetected }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  // Latest onDevServerDetected without making it an effect dep (would re-subscribe
  // the pty stream every render). The rolling tail lets the "Local:" banner be
  // matched even when it's split across two pty chunks; the last port we reported
  // is remembered so we only fire on a change.
  const devServerCbRef = useRef<typeof onDevServerDetected>(onDevServerDetected)
  devServerCbRef.current = onDevServerDetected
  const outTailRef = useRef('')
  const lastDevPortRef = useRef<number | null>(null)

  // We render with xterm's DOM renderer (each cell is a styled span). WKWebView
  // corrupted both the WebGL texture atlas AND the 2D-canvas renderer — stray
  // tofu cells and duplicated/garbled rows — so the only reliable path is to use
  // neither GPU nor canvas. The DOM renderer has no glyph atlas to invalidate,
  // so the atlas-clearing scaffolding the GPU/canvas renderers needed is gone.
  //
  // DO NOT reintroduce a renderer addon on this stack:
  //  - WebGL is still broken in WKWebView/Safari on the macOS 26.x line
  //    (xtermjs/xterm.js#5816, open as of 2026-06) — corrupted output.
  //  - canvas was REMOVED in @xterm/xterm v6; DOM and WebGL are the only two
  //    renderers that exist, and WebGL is the broken one here.
  //  - even if WebGL is fixed, WKWebView reports devicePixelRatio=1 on Retina
  //    under a custom URL scheme (wailsapp/wails#5111), so canvas/WebGL render
  //    half-res/blurry. The DOM renderer has no backing store, so it's immune.
  // Revisit only when #5816 is fixed in a STABLE macOS 26.x (that's also the
  // gate for chasing GPU perf again — see the shelved native-terminal branch).
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
      // Two bundled subsets go FIRST (see styles.css @font-face), supplying
      // single-width monochrome glyphs that NO usable macOS font has, so they
      // don't fall to a colour double-width emoji or the LastResort "tofu" box:
      //   'Operator Symbols' — Misc-Technical/geometric markers (⏺ U+23FA tool
      //     bullet, ⏸ U+23F8, ⎿ U+23BF tree, …).
      //   'Operator Legacy'  — Symbols for Legacy Computing (U+1FBxx) + Supplement
      //     (U+1CCxx) that Claude Code's logo/art mosaics use.
      //   'Operator Emoji'   — double-width emoji-pictograph ornaments with no text
      //     form (👣 U+1F463 footprints on the composer divider) that would otherwise
      //     tofu as a grey box under the font-variant-emoji:text rule (see styles.css).
      // These carry no letters, so SF Mono still wins for text. Menlo covers the
      // dingbats/geometric markers (● ◆ ▸ ✔ ✦ ✻); 'Apple Symbols' covers Braille
      // (U+28xx — used heavily by Claude Code's art and the ONLY system font that
      // has it); Apple Color Emoji stays last for genuine emoji with no text form.
      fontFamily: "'Operator Symbols', 'Operator Legacy', 'Operator Emoji', 'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, 'Apple Symbols', 'Apple Color Emoji', monospace",
      fontSize: 13,
      // 1.2 gives the rows breathing room. xterm rounds the cell height to an
      // integer device pixel, so every row gets the same height — no sub-pixel
      // drift / uneven spacing even though the multiplier is fractional.
      lineHeight: 1.2,
      // The DOM renderer maps these straight to CSS font-weight, so they're real
      // SF Mono weights (no canvas rasterization darkening to compensate for). 400
      // normal / 600 bold: SF Mono's 700 reads chunky next to its regular, 600
      // keeps Claude Code's frequent bold emphasis distinct as weight only (same
      // hue, no bright-colour shift).
      fontWeight: 400,
      fontWeightBold: 600,
      drawBoldTextInBrightColors: false,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
      macOptionIsMeta: true,
      scrollback: 10000,
      // Claude Code emits dim/gray secondary text (rendered at reduced alpha). On
      // a light background that washes out, so push to AA there. On dark, leave it
      // off (1) — the DOM renderer shows true alpha and any lift just whitens the
      // dim text.
      minimumContrastRatio: isLightBackground(theme.background) ? 4.5 : 1,
      // OSC-8 hyperlinks (Claude Code emits them for URLs). Without our own
      // handler xterm falls back to a default that calls confirm() — which Tauri
      // blocks ("dialog.confirm not allowed") so the link never opens. Route them
      // through the system opener instead.
      linkHandler: {
        activate: (_event, uri) => {
          if (window.operator?.openExternal) window.operator.openExternal(uri)
          else window.open(uri, '_blank')
        },
        allowNonHttpProtocols: true,
      },
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    // Upgrade xterm's character-width tables from its built-in Unicode 6 to Unicode 11.
    // Claude Code lays out its TUI with a modern wcwidth (emoji/symbols are 2 cells); with
    // xterm on Unicode 6 those came out 1 cell, so the cursor column drifted and Claude
    // Code's redraws (e.g. the spinner over its --agent hint) landed on the wrong row —
    // the overlapping/garbled lines. Needs allowProposedApi (set above).
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    // Clicking a link opens it in the system browser (via Tauri's opener);
    // falls back to window.open elsewhere.
    term.loadAddon(new WebLinksAddon((_event, uri) => {
      if (window.operator?.openExternal) window.operator.openExternal(uri)
      else window.open(uri, '_blank')
    }))

    // No renderer addon: xterm falls back to its built-in DOM renderer, which
    // sidesteps the WKWebView WebGL/canvas corruption entirely. Box-drawing
    // borders are now drawn by the font (SF Mono) rather than custom glyphs.
    term.open(containerRef.current)

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

    // The pty is opened at a default size in Rust a moment before our first fit
    // lands, and the rounded inset card / layout can settle a frame later. Re-
    // assert the real size a couple of beats after launch so Claude Code lays out
    // its TUI against the correct width (avoids an initial mis-wrapped frame).
    // Timers are cleared on unmount.
    const kick1 = setTimeout(() => handleResize(), 250)
    const kick2 = setTimeout(() => handleResize(), 800)

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
    // Sniff a dev-server URL. We used to anchor on a "Local:" banner, but Claude
    // Code COLLAPSES subprocess output ("+5 lines") so that line never streams —
    // only Claude's own prose ("Dev server is running: http://localhost:5273/")
    // does. So match a localhost URL directly. Keep a short tail so a URL split
    // across two chunks still matches.
    const DEV_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)/i
    // Dev servers colorize the banner (e.g. Vite: "Local\x1b[22m:  \x1b[36mhttp://…"),
    // so strip OSC + CSI/SGR escapes before matching or "Local:" never lines up
    // with the URL.
    const stripAnsi = (s: string) =>
      s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b[[(][0-9;?]*[ -/]*[@-~]/g, '')
    const detectDevServer = (chunk: string) => {
      const cb = devServerCbRef.current
      if (!cb) return
      // Keep the raw tail (escapes intact) so a sequence split across two chunks
      // still strips cleanly next time; strip only for matching.
      const hay = outTailRef.current + chunk
      const m = DEV_RE.exec(stripAnsi(hay))
      if (m) {
        const port = parseInt(m[1], 10)
        if (port && port !== lastDevPortRef.current) {
          lastDevPortRef.current = port
          cb(port)
        }
      }
      outTailRef.current = hay.length > 512 ? hay.slice(-512) : hay
    }

    const unsubData = window.operator.onTerminalData((id, data) => {
      if (id === terminalId) {
        term.write(data)
        detectDevServer(data)
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

    // Link clicks: when Claude Code has mouse tracking on (the common case — see
    // the wheel workaround above), xterm forwards the click to the pty as a mouse
    // report, so WebLinksAddon's own click never fires. The link still *hovers*
    // (decoration), but clicking does nothing. So when tracking is active we
    // resolve the URL under the pointer ourselves and open it, swallowing the
    // event before it becomes a mouse report. With tracking off we do nothing and
    // let WebLinksAddon handle it normally (avoids opening twice).
    const URL_RE = /(https?:\/\/[^\s'"`<>()\[\]]+)/g
    const urlAtClick = (e: MouseEvent): string | null => {
      const t = termRef.current
      if (!t) return null
      // xterm's measured cell box + the screen element origin (private but stable).
      const core = (t as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } }; screenElement?: HTMLElement } })._core
      const cell = core?._renderService?.dimensions?.css?.cell
      const screen = core?.screenElement
      if (!cell || !screen || !cell.width || !cell.height) return null
      const rect = screen.getBoundingClientRect()
      const col = Math.floor((e.clientX - rect.left) / cell.width)
      const row = Math.floor((e.clientY - rect.top) / cell.height)
      if (col < 0 || row < 0) return null
      const line = t.buffer.active.getLine(t.buffer.active.viewportY + row)
      if (!line) return null
      const text = line.translateToString(false)
      URL_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = URL_RE.exec(text))) {
        if (col >= m.index && col < m.index + m[0].length) return m[0]
      }
      return null
    }
    const onClickCapture = (e: MouseEvent) => {
      const t = termRef.current
      if (!t || t.modes.mouseTrackingMode === 'none') return // WebLinksAddon handles it
      if (e.button !== 0) return
      const url = urlAtClick(e)
      if (!url) return
      e.preventDefault()
      e.stopPropagation()
      if (window.operator?.openExternal) window.operator.openExternal(url)
      else window.open(url, '_blank')
    }
    // mousedown is where xterm builds the mouse report; intercept there too so the
    // click never reaches the pty, plus click for the actual activation.
    const swallowIfLink = (e: MouseEvent) => {
      const t = termRef.current
      if (!t || t.modes.mouseTrackingMode === 'none' || e.button !== 0) return
      if (urlAtClick(e)) { e.preventDefault(); e.stopPropagation() }
    }
    container.addEventListener('mousedown', swallowIfLink, { capture: true })
    container.addEventListener('mouseup', swallowIfLink, { capture: true })
    container.addEventListener('click', onClickCapture, { capture: true })

    return () => {
      clearTimeout(kick1)
      clearTimeout(kick2)
      unsubData()
      observer.disconnect()
      container.removeEventListener('wheel', onWheelCapture, { capture: true } as EventListenerOptions)
      container.removeEventListener('mousedown', swallowIfLink, { capture: true } as EventListenerOptions)
      container.removeEventListener('mouseup', swallowIfLink, { capture: true } as EventListenerOptions)
      container.removeEventListener('click', onClickCapture, { capture: true } as EventListenerOptions)
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // `theme` is intentionally excluded — recreating the terminal on a theme
    // change would wipe the scrollback. It's applied in place below instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId, onTitleChange, handleResize])

  // Apply theme/contrast changes to the live terminal without recreating it.
  // The DOM renderer repaints from the new palette on the next frame — no atlas
  // to rebuild.
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

  // Handle image / file drag and drop. A dragged macOS screenshot *preview* (the
  // one you grab before it saves to Desktop) carries image BYTES, not a file on
  // disk — and standard (Tauri) webviews never expose `File.path` anyway. So we
  // read the bytes and write them to a temp file via the backend, then drop that
  // path into the terminal. This makes "screenshot → drag straight in" work like
  // iTerm, so Claude Code can Read the image without it ever touching the Desktop.
  // (Needs `dragDropEnabled: false` in tauri.conf so the webview gets HTML5 DnD.)
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return
    const paths: string[] = []
    for (const f of files) {
      // Electron leftover / rare webviews that do expose a real path: use it.
      const p = (f as File & { path?: string }).path
      if (p) { paths.push(p); continue }
      // Otherwise persist the bytes to a temp file (works for unsaved screenshots
      // and any other dropped file the webview only hands us as data).
      try {
        const bytes = new Uint8Array(await f.arrayBuffer())
        let bin = ''
        for (let i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        }
        const ext = (f.name.split('.').pop() || f.type.split('/')[1] || 'png').toLowerCase()
        const tmp = await window.operator.savePastedImage(btoa(bin), ext)
        paths.push(tmp)
      } catch {
        // ignore a single unreadable drop
      }
    }
    // Trailing space so the path is delimited from whatever's typed next.
    if (paths.length > 0) window.operator.terminalWrite(terminalId, paths.join(' ') + ' ')
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
