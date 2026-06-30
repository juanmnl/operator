import { useEffect, useRef } from 'react'
import { init, Terminal, FitAddon } from 'ghostty-web'
import type { ITerminalOptions } from 'ghostty-web'
import type { ITheme } from '@xterm/xterm'
import { TERMINAL_FONT_FAMILY } from '../../lib/terminal-options'
import { base64ToBytes } from '../../lib/base64'

// Ghostty terminal pane (SPIKE) — uses ghostty-web: the real Ghostty VT engine
// compiled to WASM, with an xterm.js-compatible API and a Canvas-2D renderer. The
// open question this spike answers: does that Canvas-2D path render cleanly in
// WKWebView (where xterm's WebGL/canvas corrupted)? If yes, this is a drop-in that's
// a more correct + complete terminal than both xterm and our DOM grid.

// WASM loads once for the whole app. We also force-load the bundled symbol fonts:
// ghostty renders to Canvas-2D, and canvas fillText only falls back to fonts that are
// ALREADY loaded — the bundled fonts load lazily, so without this ⏺/⎿/👀/✳ etc. tofu.
const SYMBOL_FONTS = ['Operator Symbols', 'Operator Dingbats', 'Operator Legacy', 'Operator Emoji']
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

export function GhosttyTerminalPane({ terminalId, theme, active }: { terminalId: string; theme: ITheme; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)

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
      term.loadAddon(fit)
      term.open(ref.current)
      try { fit.fit() } catch { /* not measured yet */ }
      // ONE resize path: the FitAddon's own (debounced) ResizeObserver auto-fits;
      // ghostty's onResize then syncs the pty. (Adding a second observer made the
      // two fight — the erratic layout / sizing jumps.)
      try { fit.observeResize() } catch { /* ignore */ }
      const onResize = term.onResize((d: { cols: number; rows: number }) => {
        try { window.operator.terminalResize(terminalId, d.cols, d.rows) } catch { /* ignore */ }
      })
      try { window.operator.terminalResize(terminalId, term.cols, term.rows) } catch { /* ignore */ }

      // Replay retained scrollback (re-attach after reload), then live stream.
      window.operator.terminalHistory(terminalId)
        .then((b64) => { if (!disposed && b64) term.write(base64ToBytes(b64)) })
        .catch(() => { /* none */ })

      // A rebuild (theme change) can run while the card is mid-layout, so the first
      // fit() above may measure a wrong box and the pane collapses. Re-fit once the
      // layout settles.
      const settle = setTimeout(() => { try { fit.fit() } catch { /* ignore */ } }, 100)

      const unsubData = window.operator.onTerminalData((id, d) => { if (id === terminalId) term.write(d) })
      const onData = term.onData((d: string) => window.operator.terminalWrite(terminalId, d))

      // No custom wheel handler: in classic mode (which we force for ghostty) its native
      // handleWheel scrolls the viewport through scrollback. A custom handler here only
      // double-scrolled, and ghostty's alt-screen arrow-forwarding can't be salvaged
      // (there's no scrollback to scroll in alt-screen) — classic mode is the real fix.
      if (active) term.focus()

      cleanup = () => {
        clearTimeout(settle)
        unsubData()
        try { onData.dispose() } catch { /* ignore */ }
        try { onResize.dispose() } catch { /* ignore */ }
        try { fit.dispose() } catch { /* ignore */ }
        try { term.dispose() } catch { /* ignore */ }
        termRef.current = null
      }
    }).catch((e) => { console.error('[ghostty] init failed', e) })

    return () => { disposed = true; cleanup() }
    // NB: `theme` is a dep — ghostty-web does NOT support live theme swaps after open()
    // (its handleOptionChange warns + no-ops, and renderer.setTheme didn't repaint
    // existing cells). The reliable path is the one that already works for NEW sessions:
    // the CONSTRUCTOR applies the theme. So on a theme change we tear down and rebuild
    // the terminal, replaying the retained scrollback. Brief flicker, but it actually
    // switches. `theme` is a stable per-variant object, so this fires only on real
    // light/dark / identity changes, not every render.
  }, [terminalId, theme])

  useEffect(() => { if (active) termRef.current?.focus() }, [active])

  // Inset the canvas so terminal content isn't jammed against the panel edges (the
  // canvas fills its container edge-to-edge; the inset is the padding). FitAddon
  // measures this inner box, so cols/rows fit the padded area.
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <div ref={ref} style={{ position: 'absolute', top: 6, left: 10, right: 8, bottom: 6 }} />
    </div>
  )
}
