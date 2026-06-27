import { useEffect, useRef, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
import '@xterm/xterm/css/xterm.css'
import type { ITheme } from '@xterm/xterm'
import { isLightBackground, detectDevServerPort, findUrlAtColumn } from '../../lib/terminal'
import { buildTerminalOptions, getMacOptionIsMeta } from '../../lib/terminal-options'
import { isAppChord } from '../../lib/key-routing'
import { persistFiles, imageFilesFrom } from '../../lib/paste-image'

interface TerminalPaneProps {
  terminalId: string
  theme: ITheme
  active?: boolean
  onTitleChange?: (title: string) => void
  /** Fires with the port when a dev server announces itself in the output. */
  onDevServerDetected?: (port: number) => void
}

export function TerminalPane({ terminalId, theme, active = true, onTitleChange, onDevServerDetected }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  // Timestamp (ms) of the last pty chunk, and a pending deferred-fit timer. A
  // fit() that changes cols/rows sends a SIGWINCH to the pty; if that lands while
  // Claude Code is mid-redraw (between its cursor-up and the rewrite of its status
  // block) the redraw desyncs → stacked/garbled "Infusing…" status lines. So we
  // hold fits until output has been quiet briefly (see handleResize).
  const lastDataAtRef = useRef(0)
  const pendingFitRef = useRef<number | null>(null)
  // True while an IME composition is in progress — the custom key handler must not
  // intercept keys (let the textarea commit the composed text through onData).
  const isComposingRef = useRef(false)
  // Latest `active` without making it a dep of the construction effect (which must
  // not re-run on activation). Used by the window-focus refocus guard.
  const activeRef = useRef(active)
  activeRef.current = active
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
  // Quiet window (ms) after the last pty chunk before a deferred fit is allowed.
  // Claude's spinner updates leave gaps well over this, so fits still apply
  // between frames; only mid-burst fits are held back.
  const FIT_QUIET_MS = 150

  const doFit = useCallback(() => {
    // Never fit against a hidden/collapsed container (display:none → 0 width).
    // Doing so would send a ~1-column size to the pty and make Claude Code
    // re-render its TUI narrow, which then sticks in the scrollback.
    const el = containerRef.current
    if (!el || el.offsetWidth < 50 || el.offsetHeight < 20) return
    if (fitRef.current) {
      try {
        fitRef.current.fit() // no-op unless the computed cols/rows actually changed
      } catch {
        // ignore fit errors during teardown
      }
    }
  }, [])

  const handleResize = useCallback(() => {
    if (pendingFitRef.current != null) {
      clearTimeout(pendingFitRef.current)
      pendingFitRef.current = null
    }
    // If output is actively streaming, defer the fit until it quiets so a resize
    // never interrupts an in-flight TUI redraw. Re-checks on each retry.
    const sinceData = Date.now() - lastDataAtRef.current
    if (sinceData < FIT_QUIET_MS) {
      pendingFitRef.current = window.setTimeout(() => {
        pendingFitRef.current = null
        handleResize()
      }, FIT_QUIET_MS - sinceData + 10)
      return
    }
    doFit()
  }, [doFit])

  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      // Shared font/behavior config (font stack, weights, unicode, scrollback, and
      // macOptionIsMeta — now defaulting to false so ⌥ composes characters; see
      // lib/terminal-options.ts). The harnesses build the same options so they
      // can't drift from production.
      ...buildTerminalOptions(theme),
      // OSC-8 hyperlinks (Claude Code emits them for URLs). Without our own
      // handler xterm falls back to a default that calls confirm() — which Tauri
      // blocks ("dialog.confirm not allowed") so the link never opens. Route them
      // through the system opener instead. App-specific, so it stays here.
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
    // Upgrade xterm's character-width tables from its built-in Unicode 6 to a modern,
    // grapheme-cluster-aware width model. Claude Code lays out its TUI with a modern
    // wcwidth (string-width / Unicode 15-16: emoji & many symbols are 2 cells, ZWJ
    // sequences cluster); on Unicode 6 those came out wrong, so the cursor column drifted
    // and Claude Code's redraws landed on the wrong row — the overlapping/garbled lines.
    // The graphemes addon (successor to addon-unicode11, which was really Unicode 12) is
    // closer to Claude Code's table and adds grapheme clustering. Needs allowProposedApi.
    term.loadAddon(new UnicodeGraphemesAddon())
    // The addon registers '15' and '15-graphemes' and activates the latter; pin it
    // explicitly (plain '15' would select the non-grapheme provider).
    term.unicode.activeVersion = '15-graphemes'
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

    // Key routing: app chords (Cmd+K/N/B/W, Cmd+1..9) are owned by the window
    // shortcut handler in DashboardView. Decline the Cmd (meta) variants here so
    // xterm emits no bytes for them and they bubble to that handler — Ctrl+<key>
    // are terminal control codes (^W werase, ^K kill-line) and must reach the pty,
    // so they're NOT declined. During IME composition decline nothing.
    term.attachCustomKeyEventHandler((e) => {
      if (isComposingRef.current) return true
      if (e.type === 'keydown' && e.metaKey && isAppChord(e)) return false
      return true
    })

    // Track IME composition on xterm's hidden textarea. xterm already commits the
    // composed result through onData; we only need the flag for the key handler.
    const textarea = term.textarea
    const onCompositionStart = () => { isComposingRef.current = true }
    const onCompositionEnd = () => { isComposingRef.current = false }
    textarea?.addEventListener('compositionstart', onCompositionStart)
    textarea?.addEventListener('compositionend', onCompositionEnd)

    // Clipboard image paste: if the clipboard holds an image (e.g. a screenshot
    // copied with Cmd+Ctrl+Shift+4), persist its bytes to a temp file and write
    // the path — parity with drag-drop (handleDrop). Non-image pastes fall through
    // to xterm untouched, so bracketed paste of text still works.
    const onPaste = async (e: ClipboardEvent) => {
      const images = imageFilesFrom(e.clipboardData)
      if (images.length === 0) return
      e.preventDefault()
      e.stopPropagation()
      const paths = await persistFiles(images, window.operator.savePastedImage)
      if (paths.length) window.operator.terminalWrite(terminalId, paths.join(' ') + ' ')
    }
    textarea?.addEventListener('paste', onPaste, { capture: true })

    // Refocus when the window regains focus (or the tab becomes visible after the
    // idle webview reload) while this pane is active, so typing lands without a
    // click. activeRef avoids making `active` a dependency of this effect.
    const refocusIfActive = () => { if (activeRef.current) termRef.current?.focus() }
    window.addEventListener('focus', refocusIfActive)
    const onVisibility = () => { if (document.visibilityState === 'visible') refocusIfActive() }
    document.addEventListener('visibilitychange', onVisibility)

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
    const detectDevServer = (chunk: string) => {
      const cb = devServerCbRef.current
      if (!cb) return
      // Pure rolling-tail scan (see lib/terminal): strips colour escapes, matches a
      // localhost URL, dedups against the last port, and returns the next 512-char
      // tail (escapes intact) so a banner split across chunks still strips cleanly.
      const { port, tail } = detectDevServerPort(outTailRef.current, chunk, lastDevPortRef.current)
      outTailRef.current = tail
      if (port !== null) { lastDevPortRef.current = port; cb(port) }
    }

    const unsubData = window.operator.onTerminalData((id, data) => {
      if (id === terminalId) {
        lastDataAtRef.current = Date.now() // gate fits while output is streaming
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
      return findUrlAtColumn(line.translateToString(false), col)
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
      if (pendingFitRef.current != null) clearTimeout(pendingFitRef.current)
      unsubData()
      observer.disconnect()
      container.removeEventListener('wheel', onWheelCapture, { capture: true } as EventListenerOptions)
      container.removeEventListener('mousedown', swallowIfLink, { capture: true } as EventListenerOptions)
      container.removeEventListener('mouseup', swallowIfLink, { capture: true } as EventListenerOptions)
      container.removeEventListener('click', onClickCapture, { capture: true } as EventListenerOptions)
      textarea?.removeEventListener('compositionstart', onCompositionStart)
      textarea?.removeEventListener('compositionend', onCompositionEnd)
      textarea?.removeEventListener('paste', onPaste, { capture: true } as EventListenerOptions)
      window.removeEventListener('focus', refocusIfActive)
      document.removeEventListener('visibilitychange', onVisibility)
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

    // Re-read the ⌥-as-Meta setting on activation so a change in Preferences takes
    // effect when you switch back to a terminal (no terminal recreate needed).
    term.options.macOptionIsMeta = getMacOptionIsMeta()

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
    // Persist each dropped file to a temp path (works for unsaved screenshots that
    // carry bytes but no File.path). Shared with the clipboard-paste handler.
    const paths = await persistFiles(files, window.operator.savePastedImage)
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
