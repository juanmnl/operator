import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { ITheme } from '@xterm/xterm'
import type { GridRun, GridUpdate } from '../../../shared/types'
import { TERMINAL_FONT_FAMILY } from '../../lib/terminal-options'
import { findUrlAtColumn } from '../../lib/terminal'

// Grid terminal pane — our own terminal (the non-native path). The pty bytes are
// parsed into a grid by alacritty in Rust (src-tauri/src/gridterm.rs); this pane
// just PAINTS the themed cell snapshot it streams (`gridterm:update`) as plain DOM,
// and forwards keystrokes back. Because no escape sequences ever reach the webview,
// there's no xterm buffer to mis-track → the overprint/ghost/garble class is gone.
//
//   - Render: imperative DOM (one <div> per row, style-run <span>s). Bypasses React
//     reconciliation on the hot path; updates are rAF-coalesced.
//   - Input:  a headless xterm used ONLY as a key encoder (display fully transparent,
//     pointer-events off); onData → terminalWrite — identical encoding, for free.
//   - Scroll: wheel → gridtermScroll (alacritty display_offset); typing jumps back.
//   - Select: drag → highlight layer + ⌘C copies; a click opens a URL under it.
//   - Theme:  the same xterm ITheme the standard pane uses; ANSI indices 0–15 map to
//     the live palette, so themes apply 1:1.
const FONT_SIZE = 13
// Integer row height renders crisper than a fractional one (no sub-pixel baseline),
// and 1.3 gives a touch more breathing room than xterm's tight 1.2. Single knob:
// feeds row height, the rows-per-pane calc, and cursor/selection positioning.
const LINE_HEIGHT = Math.round(FONT_SIZE * 1.3) // 17px
const PAD = 4 // host inner padding; cell origin is offset by this
const TRANSPARENT = '#00000000'
// Translucent so the text under a selection stays readable; tracks the live accent.
const SEL_BG = 'color-mix(in srgb, var(--accent) 26%, transparent)'

interface Palette { fg: string; bg: string; cursor: string; ansi: string[] }

function paletteFromTheme(t: ITheme): Palette {
  return {
    fg: t.foreground || '#e6e6e6',
    bg: t.background || '#0b0d10',
    cursor: t.cursor || t.foreground || '#e6e6e6',
    ansi: [
      t.black || '#000', t.red || '#c00', t.green || '#0c0', t.yellow || '#cc0',
      t.blue || '#00c', t.magenta || '#c0c', t.cyan || '#0cc', t.white || '#ccc',
      t.brightBlack || '#666', t.brightRed || '#f33', t.brightGreen || '#3f3', t.brightYellow || '#ff3',
      t.brightBlue || '#33f', t.brightMagenta || '#f3f', t.brightCyan || '#3ff', t.brightWhite || '#fff',
    ],
  }
}

function resolveColor(c: number | string | null | undefined, pal: Palette, fallback: string | null): string | null {
  if (c == null) return fallback
  if (typeof c === 'number') return pal.ansi[c] ?? fallback
  return c
}

// Style one run's <span> from the snapshot's fg/bg/attr bitmask.
function styleSpan(span: HTMLSpanElement, run: GridRun, pal: Palette) {
  span.textContent = run.t
  const a = run.a || 0
  let fg = resolveColor(run.f, pal, pal.fg)
  let bg = resolveColor(run.b, pal, null)
  if (a & 16) { // inverse — swap, materialising the position defaults
    const realFg = fg
    fg = bg ?? pal.bg
    bg = realFg
  }
  const s = span.style
  s.color = fg || pal.fg
  s.background = bg || ''
  s.fontWeight = a & 1 ? '600' : '400'
  s.fontStyle = a & 4 ? 'italic' : 'normal'
  const deco: string[] = []
  if (a & 8) deco.push('underline')
  if (a & 32) deco.push('line-through')
  s.textDecoration = deco.join(' ')
  s.opacity = a & 2 ? '0.6' : '1'
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
type Cell = { col: number; row: number }

// A DOM Range over characters [c0, c1) within a painted row element, walking its
// run <span> text nodes. Used to highlight selection over the REAL glyph positions
// (so symbol/variable-advance glyphs can't make the highlight drift off the text).
function rangeForChars(rowEl: HTMLElement, c0: number, c1: number): Range | null {
  const walker = document.createTreeWalker(rowEl, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  let acc = 0
  let started = false
  let last: Text | null = null
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const len = node.data.length
    if (!started && c0 <= acc + len) { range.setStart(node, Math.max(0, c0 - acc)); started = true }
    if (started && c1 <= acc + len) { range.setEnd(node, Math.max(0, c1 - acc)); return range }
    acc += len
    last = node
  }
  if (started && last) { range.setEnd(last, last.data.length); return range }
  return null
}

export function GridTerminalPane({ terminalId, theme, active }: { terminalId: string; theme: ITheme; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null)   // grid surface (painted rows)
  const inputRef = useRef<HTMLDivElement>(null)  // headless xterm key-encoder overlay
  const cursorRef = useRef<HTMLDivElement>(null)
  const selLayerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)

  const palRef = useRef<Palette>(paletteFromTheme(theme))
  palRef.current = paletteFromTheme(theme)
  const activeRef = useRef(active)
  activeRef.current = active

  const cellRef = useRef({ w: 8, h: LINE_HEIGHT })
  const dimsRef = useRef({ cols: 0, rows: 0 })
  const linesRef = useRef<GridRun[][]>([])
  const rowElsRef = useRef<HTMLDivElement[]>([])
  const dirtyRef = useRef<Set<number>>(new Set())
  const cursorStateRef = useRef({ x: 0, y: 0, vis: false })
  const rafRef = useRef(0)
  const offsetRef = useRef(0)                                  // scrollback lines
  const selRef = useRef<{ a: Cell; h: Cell } | null>(null)     // drag selection
  const dragRef = useRef<{ x: number; y: number; col: number; row: number; moved: boolean } | null>(null)

  // ---- geometry / text helpers (read refs, so they see live values) ----------
  const cellAt = (e: { clientX: number; clientY: number }): Cell => {
    const r = hostRef.current!.getBoundingClientRect()
    const { w, h } = cellRef.current
    return {
      col: clamp(Math.floor((e.clientX - r.left - PAD) / w), 0, Math.max(0, dimsRef.current.cols - 1)),
      row: clamp(Math.floor((e.clientY - r.top - PAD) / h), 0, Math.max(0, dimsRef.current.rows - 1)),
    }
  }
  const rowText = (y: number) => (linesRef.current[y] || []).map((r) => r.t).join('')
  const orderSel = (s: { a: Cell; h: Cell }) => {
    const { a, h } = s
    return (h.row < a.row || (h.row === a.row && h.col < a.col)) ? { start: h, end: a } : { start: a, end: h }
  }
  const selectionText = (): string => {
    const sel = selRef.current
    if (!sel) return ''
    const { start, end } = orderSel(sel)
    const parts: string[] = []
    for (let row = start.row; row <= end.row; row++) {
      const text = rowText(row)
      const c0 = row === start.row ? start.col : 0
      const c1 = row === end.row ? end.col + 1 : text.length
      parts.push(text.slice(c0, Math.max(c0, c1)))
    }
    return parts.join('\n')
  }
  // Highlight the selection over the actual rendered glyphs (via DOM Range rects),
  // not a computed col×cellW grid — so variable-advance symbols can't drift it off.
  const paintSelection = () => {
    const layer = selLayerRef.current
    const host = hostRef.current
    if (!layer || !host) return
    layer.textContent = ''
    const sel = selRef.current
    if (!sel) return
    const { start, end } = orderSel(sel)
    const hostRect = host.getBoundingClientRect()
    for (let row = start.row; row <= end.row; row++) {
      const rowEl = rowElsRef.current[row]
      if (!rowEl) continue
      const text = rowText(row)
      if (text.length === 0) continue
      const c0 = row === start.row ? start.col : 0
      const c1 = Math.min(row === end.row ? end.col + 1 : text.length, text.length)
      if (c1 <= c0) continue
      const range = rangeForChars(rowEl, c0, c1)
      if (!range) continue
      for (const r of Array.from(range.getClientRects())) {
        const d = document.createElement('div')
        d.style.cssText = `position:absolute;left:${r.left - hostRect.left}px;top:${r.top - hostRect.top}px;width:${r.width}px;height:${r.height}px;background:${SEL_BG};`
        layer.appendChild(d)
      }
    }
  }
  const clearSelection = () => { selRef.current = null; paintSelection() }

  // ---- painting --------------------------------------------------------------
  const rebuildScaffold = (cols: number, rows: number) => {
    const host = hostRef.current
    if (!host) return
    dimsRef.current = { cols, rows }
    linesRef.current = Array.from({ length: rows }, () => [])
    rowElsRef.current = []
    clearSelection()
    Array.from(host.querySelectorAll('.gt-row')).forEach((el) => el.remove())
    const frag = document.createDocumentFragment()
    for (let y = 0; y < rows; y++) {
      const row = document.createElement('div')
      row.className = 'gt-row'
      row.style.height = `${cellRef.current.h}px`
      row.style.lineHeight = `${cellRef.current.h}px`
      row.style.whiteSpace = 'pre'
      row.style.overflow = 'hidden'
      frag.appendChild(row)
      rowElsRef.current.push(row)
    }
    host.insertBefore(frag, selLayerRef.current)
    for (let y = 0; y < rows; y++) dirtyRef.current.add(y)
  }

  const paintRow = (y: number) => {
    const row = rowElsRef.current[y]
    if (!row) return
    const runs = linesRef.current[y] || []
    row.textContent = ''
    if (runs.length === 0) return
    const pal = palRef.current
    const frag = document.createDocumentFragment()
    for (const run of runs) {
      const span = document.createElement('span')
      styleSpan(span, run, pal)
      frag.appendChild(span)
    }
    row.appendChild(frag)
  }

  const paintCursor = () => {
    const c = cursorRef.current
    if (!c) return
    const { x, y, vis } = cursorStateRef.current
    const { w, h } = cellRef.current
    const show = vis && activeRef.current && y >= 0
    c.style.display = show ? 'block' : 'none'
    if (!show) return
    c.style.width = `${w}px`
    c.style.height = `${h}px`
    c.style.transform = `translate(${x * w}px, ${y * h}px)`
    c.style.background = palRef.current.cursor
  }

  const repaintAll = () => {
    for (let y = 0; y < dimsRef.current.rows; y++) paintRow(y)
    paintCursor()
  }

  const schedulePaint = () => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      for (const y of dirtyRef.current) paintRow(y)
      dirtyRef.current.clear()
      paintCursor()
    })
  }

  // Rows/cols that actually FIT the host's content area. Subtract the padding
  // (top + sides; bottom is 0 so the grid reaches the panel's bottom edge) so the
  // last row — where Claude Code's input composer lives — is never clipped, however
  // tall the composer grows.
  const gridDims = () => {
    const host = hostRef.current
    if (!host) return { cols: 0, rows: 0 }
    const cols = Math.max(1, Math.floor((host.clientWidth - 2 * PAD) / cellRef.current.w))
    const rows = Math.max(1, Math.floor((host.clientHeight - PAD) / cellRef.current.h))
    return { cols, rows }
  }

  const reflow = () => {
    const host = hostRef.current
    if (!host || host.clientWidth === 0 || host.clientHeight === 0) return
    const { cols, rows } = gridDims()
    if (cols === dimsRef.current.cols && rows === dimsRef.current.rows) return
    if (activeRef.current) window.operator.gridtermResize?.(terminalId, cols, rows)
  }

  // Mount: measure the cell, create the key-encoder, wire the update stream + all
  // pointer/keyboard/scroll interaction.
  useEffect(() => {
    const host = hostRef.current
    const inputEl = inputRef.current
    if (!host || !inputEl) return

    // Re-mount / HMR safety: drop any rows or stray xterm DOM left by a prior mount
    // (this pane builds its rows imperatively, which React Fast Refresh won't clean up).
    host.querySelectorAll('.gt-row').forEach((el) => el.remove())
    inputEl.replaceChildren()
    rowElsRef.current = []
    dimsRef.current = { cols: 0, rows: 0 }

    // Measure the cell advance from a probe that INHERITS the host's exact font (no
    // re-declared family/size that could resolve differently), so cellW matches the
    // rows' real glyph advance — otherwise the selection highlight drifts from the
    // text by col×error. Average a long run for sub-pixel accuracy.
    const measureW = () => {
      const probe = document.createElement('span')
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;left:-9999px;top:0'
      probe.textContent = 'M'.repeat(60)
      host.appendChild(probe)
      const w = probe.getBoundingClientRect().width / 60
      probe.remove()
      return w
    }
    cellRef.current = { w: measureW(), h: LINE_HEIGHT }
    // Bundled symbol fonts load async; if the advance shifts once they're ready,
    // re-measure and re-fit so the grid + selection stay aligned.
    document.fonts?.ready.then(() => {
      const w = measureW()
      if (Math.abs(w - cellRef.current.w) > 0.02) {
        cellRef.current = { ...cellRef.current, w }
        clearSelection()
        reflow()
      }
    }).catch(() => { /* no font API */ })

    // Headless xterm — key encoder only (transparent, pointer-events off, never written to).
    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: false,
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: FONT_SIZE,
      theme: { background: TRANSPARENT, foreground: TRANSPARENT, cursor: TRANSPARENT, cursorAccent: TRANSPARENT, selectionBackground: TRANSPARENT },
    })
    term.open(inputEl)
    termRef.current = term
    term.onData((d) => {
      window.operator.terminalWrite(terminalId, d)
      // Typing while scrolled back jumps to the live bottom (standard terminal feel).
      if (offsetRef.current > 0) window.operator.gridtermScroll?.(terminalId, -1_000_000)
    })

    // Robust focus: the encoder lives beneath the grid, so nothing focuses it on its
    // own (after a reload / re-attach it's easy to end up with NOTHING focused and
    // typing silently dies). (1) Focus shortly after mount if this is the active pane.
    // (2) Re-grab focus if it's lost to NOTHING (relatedTarget null) while active —
    // but never steal it from a real input/button elsewhere (Canvas, sidebar).
    const ta = (term as unknown as { textarea?: HTMLTextAreaElement }).textarea
    const focusSoon = () => { if (activeRef.current) term.focus() }
    setTimeout(focusSoon, 60)
    const onTaBlur = (e: FocusEvent) => { if (activeRef.current && e.relatedTarget === null) setTimeout(focusSoon, 0) }
    ta?.addEventListener('blur', onTaBlur)

    const unsub = window.operator.onGridUpdate?.((u: GridUpdate) => {
      if (u.id !== terminalId) return
      if (u.cols !== dimsRef.current.cols || u.rows !== dimsRef.current.rows) rebuildScaffold(u.cols, u.rows)
      for (const line of u.lines) {
        linesRef.current[line.y] = line.runs
        dirtyRef.current.add(line.y)
      }
      cursorStateRef.current = u.cursor
      // A scroll changed what's on screen → the old selection no longer maps to text.
      if ((u.offset ?? 0) !== offsetRef.current) { offsetRef.current = u.offset ?? 0; clearSelection() }
      schedulePaint()
    })

    // Debounce resize: only re-fit (which makes alacritty reflow the grid) once the
    // drag settles, not every frame — repeated reflows thrash + compound any garble.
    let resizeTimer = 0
    const onResize = () => { clearTimeout(resizeTimer); resizeTimer = window.setTimeout(reflow, 120) }
    const ro = new ResizeObserver(onResize)
    ro.observe(host)

    // Wheel → scrollback (into history on wheel-up).
    const onWheel = (e: WheelEvent) => {
      if (!activeRef.current) return
      e.preventDefault()
      const lines = Math.round(-e.deltaY / 24) || (e.deltaY < 0 ? 1 : -1)
      if (lines !== 0) window.operator.gridtermScroll?.(terminalId, lines)
    }
    host.addEventListener('wheel', onWheel, { passive: false })

    // Drag → selection; click (no drag) → open a URL under the pointer.
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      term.focus()
      const cell = cellAt(e)
      dragRef.current = { x: e.clientX, y: e.clientY, col: cell.col, row: cell.row, moved: false }
      clearSelection()
    }
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      if (!d.moved && Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) < 3) return
      d.moved = true
      selRef.current = { a: { col: d.col, row: d.row }, h: cellAt(e) }
      paintSelection()
    }
    const onUp = () => {
      const d = dragRef.current
      if (!d) return
      dragRef.current = null
      if (!d.moved) {
        const url = findUrlAtColumn(rowText(d.row), d.col)
        if (url) window.operator.openExternal?.(url)
      }
    }
    host.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)

    // ⌘C copies the selection (Ctrl+C is left alone so it still interrupts).
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && (e.key === 'c' || e.key === 'C') && selRef.current) {
        const text = selectionText()
        if (text) { void navigator.clipboard?.writeText(text).catch(() => { /* blocked */ }); e.preventDefault(); e.stopImmediatePropagation() }
      }
    }
    window.addEventListener('keydown', onKey, true)

    return () => {
      clearTimeout(resizeTimer)
      cancelAnimationFrame(rafRef.current)
      ro.disconnect()
      unsub?.()
      host.removeEventListener('wheel', onWheel)
      host.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('keydown', onKey, true)
      term.dispose()
      termRef.current = null
      window.operator.gridtermDetach?.(terminalId)
    }
  }, [terminalId])

  // Becoming active (mount-if-active or tab switch): focus the encoder + (re)attach
  // at the current size, which pushes a fresh full frame.
  useEffect(() => {
    if (!active) return
    termRef.current?.focus()
    const raf = requestAnimationFrame(() => {
      if (!hostRef.current) return
      const { cols, rows } = gridDims()
      window.operator.gridtermAttach?.(terminalId, cols, rows)
    })
    return () => cancelAnimationFrame(raf)
  }, [active, terminalId])

  // Live theme change: repaint with the new palette + tell the core the new colours so
  // Claude's background-colour query reflects the current theme.
  useEffect(() => {
    repaintAll()
    if (theme.background && theme.foreground) {
      window.operator.gridtermSetTheme?.(terminalId, theme.background, theme.foreground)
    }
  }, [theme, terminalId])

  return (
    // Any pointer-down in the pane focuses the key-encoder — a catch-all so typing
    // always works (survives reloads / tab switches) without fragile focus juggling.
    <div
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: palRef.current.bg }}
      onMouseDown={() => termRef.current?.focus()}
    >
      {/* Key-encoder xterm — BENEATH the grid, transparent theme so it paints nothing.
          Focusable for keyboard (focus is programmatic; it must NOT be opacity:0 or
          pointer-events:none, which block keyboard in WKWebView). */}
      <div ref={inputRef} style={{ position: 'absolute', inset: 0 }} />
      {/* Painted grid surface — on top, transparent (root holds the opaque bg). */}
      <div
        ref={hostRef}
        style={{
          position: 'absolute', inset: 0, padding: `${PAD}px ${PAD}px 0`, boxSizing: 'border-box',
          fontFamily: TERMINAL_FONT_FAMILY, fontSize: FONT_SIZE, color: palRef.current.fg,
          fontVariantLigatures: 'none', overflow: 'hidden', userSelect: 'none',
        }}
      >
        <div ref={selLayerRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 1 }} />
        <div
          ref={cursorRef}
          className="gt-cursor-blink"
          style={{ position: 'absolute', top: PAD, left: PAD, display: 'none', pointerEvents: 'none', zIndex: 2 }}
        />
      </div>
    </div>
  )
}
