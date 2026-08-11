// THE COMPOSER-GHOST PROBE — is the DOM wrong, or only the pixels?
//
// The ghost is the composer and the rule/status lines around it going stale or blank while the
// session is plainly still alive. Two very different bugs look identical on screen:
//
//   (a) xterm's DOM is correct and WKWebView never flushed it to the compositor → a pixel bug, and
//       the `hardRepaint`/`rebuildLayer` nudges in TerminalPane are the right place to work.
//   (b) xterm's DOM itself is stale → a renderer bug, upstream of any compositor trick.
//
// Nothing in the app could tell them apart. `verify:ghost` settles it headlessly and says the DOM
// is correct on every scenario (9 × 2 fixtures, 0 mismatches) — but headless WebKit has no
// compositor to fail, so it cannot speak to (a) at all, and it cannot rule out that the live app
// hits something the harness does not model. This probe is the same comparison, run in the live
// app, at the moment the ghost is on screen.
//
// READ-ONLY, AND THAT IS THE WHOLE DESIGN CONSTRAINT. Any repaint clears the ghost before it can
// be captured, which would make the probe destroy the only evidence it exists to collect. So it
// never calls refresh / fit / write / resize / clear / focus / scrollToBottom, and never assigns
// to `term.options` (an options write triggers a full refresh internally). It reads the buffer,
// reads `textContent`, and stops. `ghost-probe.test.ts` enforces this against a Terminal stub
// whose mutating methods throw.
//
// Clipboard goes through `navigator.clipboard.writeText` ONLY. The usual textarea+execCommand
// fallback moves focus, and a focus change runs xterm's `handleFocus`/`handleBlur`, which repaints
// the cursor row — the exact thing this must not do. If the clipboard write fails the text is
// still on the console and returned to the caller.
import type { Terminal } from '@xterm/xterm'

const FLAG = 'operator.terminal.ghostProbe'
/** Rows to capture. The ghost lives at the bottom of an alt-screen viewport: composer, its rules,
 *  and the mode/hint line. Eight covers that band with room either side. */
const TAIL_ROWS = 8

export function ghostProbeEnabled(): boolean {
  try {
    return localStorage.getItem(FLAG) === '1'
  } catch {
    return false
  }
}

export type ProbeRow = {
  /** Viewport row index, 0 = top of the visible area. */
  row: number
  buffer: string
  dom: string
  match: boolean
}

export type GhostProbeReport = {
  terminalId: string
  capturedAt: string
  cols: number
  rows: number
  viewportY: number
  /** `alternate` is the fullscreen TUI; the ghost has only ever been reported there. */
  bufferType: string
  /** DEC 2026. `RenderService.refreshRows` BUFFERS and returns while this is set, so a repaint
   *  issued inside a frame paints nothing until something else releases it. Claude Code's
   *  fullscreen TUI wraps every redraw in one. If this is true at capture time, a swallowed
   *  refresh is the first thing to suspect. */
  syncOutputOpen: boolean | null
  /** xterm pauses rendering for a terminal it believes is not on screen, and drops refreshes while
   *  paused. `null` when the internal could not be read. */
  renderPaused: boolean | null
  documentFocused: boolean
  devicePixelRatio: number
  /** The heal machinery parks a transform / will-change on the element. Worth knowing whether one
   *  was mid-flight when the ghost was captured. */
  inlineTransform: string
  inlineWillChange: string
  /** How many row elements the DOM renderer currently owns, against `rows`. A short list is itself
   *  a finding — `DomRenderer.renderRows` stops at the first row it cannot resolve. */
  domRowCount: number
  tail: ProbeRow[]
  mismatches: number
}

/** xterm internals, read-only and optional-chained: a version bump that renames one of these
 *  degrades the field to `null`, it does not throw and it does not change what is captured. */
interface Internals {
  _core?: {
    coreService?: { decPrivateModes?: { synchronizedOutput?: boolean } }
    _renderService?: { _isPaused?: boolean }
  }
}

/** Normalised the same way `scripts/width-audit/fullscreen-ghost.ts` normalises, so a live capture
 *  and a harness run are directly comparable: &nbsp; → space, trailing whitespace dropped. The DOM
 *  pads trailing cells and the buffer does not, and that difference is not the ghost. */
const norm = (s: string) => s.replace(/ /g, ' ').replace(/\s+$/, '')

/** Capture the comparison. Pure read — see the file header. */
export function captureGhostProbe(term: Terminal, terminalId: string): GhostProbeReport {
  const internals = term as unknown as Internals
  const buf = term.buffer.active
  const el = term.element as HTMLElement | null
  const rowEls = el ? Array.from(el.querySelectorAll('.xterm-rows > *')) as HTMLElement[] : []

  const first = Math.max(0, term.rows - TAIL_ROWS)
  const tail: ProbeRow[] = []
  for (let i = first; i < term.rows; i++) {
    const line = buf.getLine(buf.viewportY + i)
    const buffer = norm(line?.translateToString(true) ?? '')
    const dom = norm(rowEls[i]?.textContent ?? '')
    tail.push({ row: i, buffer, dom, match: buffer === dom })
  }

  return {
    terminalId,
    capturedAt: new Date().toISOString(),
    cols: term.cols,
    rows: term.rows,
    viewportY: buf.viewportY,
    bufferType: buf.type,
    syncOutputOpen: internals._core?.coreService?.decPrivateModes?.synchronizedOutput ?? null,
    renderPaused: internals._core?._renderService?._isPaused ?? null,
    documentFocused: typeof document !== 'undefined' && document.hasFocus(),
    devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio : 1,
    inlineTransform: el?.style.transform ?? '',
    inlineWillChange: el?.style.willChange ?? '',
    domRowCount: rowEls.length,
    tail,
    mismatches: tail.filter((r) => !r.match).length,
  }
}

/** The pasteable form. Deliberately plain text: this goes into a bug report or a lane message. */
export function formatGhostProbe(r: GhostProbeReport): string {
  const head = [
    `ghost-probe ${r.capturedAt}`,
    `  terminal      ${r.terminalId}`,
    `  size          ${r.cols}x${r.rows}   viewportY=${r.viewportY}   buffer=${r.bufferType}`,
    `  sync-output   ${r.syncOutputOpen === null ? 'unknown' : r.syncOutputOpen ? 'OPEN (a refresh here paints nothing)' : 'closed'}`,
    `  render paused ${r.renderPaused === null ? 'unknown' : r.renderPaused}`,
    `  dom rows      ${r.domRowCount}${r.domRowCount < r.rows ? `  ⚠ fewer than ${r.rows}` : ''}`,
    `  focus/dpr     ${r.documentFocused} / ${r.devicePixelRatio}`,
    `  inline style  transform=${r.inlineTransform || '(none)'}  will-change=${r.inlineWillChange || '(none)'}`,
    `  bottom ${r.tail.length} rows: ${r.mismatches} mismatch(es)`,
    '',
  ]
  for (const t of r.tail) {
    head.push(`  ${t.match ? '·' : '✗'} row ${String(t.row).padStart(3)}`)
    head.push(`      buffer |${t.buffer}|`)
    head.push(`      dom    |${t.dom}|`)
  }
  head.push('')
  head.push(
    r.mismatches === 0
      ? '  VERDICT: the DOM matches the buffer. If the screen is wrong, the pixels are stale and'
      : '  VERDICT: the DOM ITSELF is stale — xterm never wrote these rows. Not a compositor bug;',
  )
  head.push(
    r.mismatches === 0
      ? '  the DOM is not — a WKWebView compositor flush, not an xterm renderer bug.'
      : '  the repaint that should have filled them was dropped or never ran.',
  )
  return head.join('\n')
}

type Probe = { run: () => Promise<string>; isActive: () => boolean }
const probes = new Map<string, Probe>()
let globalInstalled = false

/** Ctrl+Alt+Shift+G. Chosen to be something no TUI binds and no app chord uses; the handler runs in
 *  the CAPTURE phase on `document` and stops propagation, so xterm never sees the keystroke and
 *  never forwards it to the pty. */
function isProbeChord(e: KeyboardEvent): boolean {
  return e.ctrlKey && e.altKey && e.shiftKey && !e.metaKey && e.code === 'KeyG'
}

/** Wire the probe for one pane. Returns a disposer. Call ONLY when `ghostProbeEnabled()` — with the
 *  flag unset nothing is registered, no listener is attached, and no global is defined. */
export function installGhostProbe(term: Terminal, terminalId: string, isActive: () => boolean): () => void {
  const run = async (): Promise<string> => {
    const report = captureGhostProbe(term, terminalId)
    const text = formatGhostProbe(report)
    // `console.table` for a genuinely side-by-side read at a glance; the text block is what gets
    // pasted. Both, because the table truncates long rows and the pasted evidence must not.
    console.log(`%c[ghost-probe] ${terminalId} — ${report.mismatches} mismatch(es)`, 'font-weight:bold')
    console.table(report.tail.map((t) => ({ row: t.row, match: t.match, buffer: t.buffer, dom: t.dom })))
    console.log(text)
    try {
      await navigator.clipboard.writeText(text)
      console.log('[ghost-probe] copied to clipboard')
    } catch (e) {
      // Never fall back to a textarea + execCommand: that moves focus, and a focus change repaints
      // the cursor row. The text is on the console and returned either way.
      console.warn('[ghost-probe] clipboard write failed; copy it from the log above', e)
    }
    return text
  }

  probes.set(terminalId, { run, isActive })

  const onKeyDown = (e: KeyboardEvent) => {
    if (!isProbeChord(e) || !isActive()) return
    e.preventDefault()
    e.stopPropagation()
    void run()
  }
  document.addEventListener('keydown', onKeyDown, true)

  if (!globalInstalled) {
    globalInstalled = true
    // `window.__ghostProbe()` targets the active pane, or takes an explicit terminal id. Handy when
    // the chord is inconvenient — e.g. driving from the inspector console while the app has focus.
    ;(window as unknown as { __ghostProbe: (id?: string) => Promise<string | undefined> }).__ghostProbe =
      async (id?: string) => {
        const chosen = id
          ? probes.get(id)
          : [...probes.values()].find((p) => p.isActive()) ?? (probes.size === 1 ? [...probes.values()][0] : undefined)
        if (!chosen) {
          console.warn(`[ghost-probe] no ${id ? `terminal ${id}` : 'active terminal'}; ids: ${[...probes.keys()].join(', ') || '(none)'}`)
          return undefined
        }
        return chosen.run()
      }
  }

  return () => {
    document.removeEventListener('keydown', onKeyDown, true)
    probes.delete(terminalId)
  }
}
