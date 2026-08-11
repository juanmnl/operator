import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { captureGhostProbe, formatGhostProbe, ghostProbeEnabled } from './ghost-probe'

/** A Terminal stub whose MUTATING methods throw. The probe exists to capture a ghost that any
 *  repaint would erase, so "it does not repaint" is the requirement, not a nicety — and the only
 *  way to hold that is to make a violation fail the suite rather than be caught in review. */
function stubTerm(opts: {
  rows?: number
  cols?: number
  bufferRows: string[]
  domRows?: string[]
  bufferType?: string
  viewportY?: number
  sync?: boolean
  paused?: boolean
}): Terminal {
  const rows = opts.rows ?? 30
  const forbidden = (name: string) => () => {
    throw new Error(`ghost-probe called ${name}() — that repaints, and a repaint destroys the ghost`)
  }
  const host = document.createElement('div')
  const rowContainer = document.createElement('div')
  rowContainer.className = 'xterm-rows'
  for (const text of opts.domRows ?? opts.bufferRows) {
    const el = document.createElement('div')
    el.textContent = text
    rowContainer.appendChild(el)
  }
  host.appendChild(rowContainer)

  const viewportY = opts.viewportY ?? 0
  return {
    rows,
    cols: opts.cols ?? 120,
    element: host,
    buffer: {
      active: {
        type: opts.bufferType ?? 'alternate',
        viewportY,
        getLine: (y: number) => {
          const text = opts.bufferRows[y - viewportY]
          return text === undefined ? undefined : { translateToString: () => text }
        },
      },
    },
    _core: {
      coreService: { decPrivateModes: { synchronizedOutput: opts.sync ?? false } },
      _renderService: { _isPaused: opts.paused ?? false },
    },
    refresh: forbidden('refresh'),
    write: forbidden('write'),
    resize: forbidden('resize'),
    clear: forbidden('clear'),
    focus: forbidden('focus'),
    blur: forbidden('blur'),
    scrollToBottom: forbidden('scrollToBottom'),
    reset: forbidden('reset'),
  } as unknown as Terminal
}

describe('ghost probe', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('is inert until the flag is explicitly set to 1', () => {
    expect(ghostProbeEnabled()).toBe(false)
    localStorage.setItem('operator.terminal.ghostProbe', 'true')
    expect(ghostProbeEnabled()).toBe(false) // only '1' counts, so a stray truthy value is not enough
    localStorage.setItem('operator.terminal.ghostProbe', '1')
    expect(ghostProbeEnabled()).toBe(true)
  })

  it('never touches anything that would repaint', () => {
    // Every mutating method on the stub throws. Capturing has to get through all of them.
    const term = stubTerm({ bufferRows: Array.from({ length: 30 }, (_, i) => `row ${i}`) })
    expect(() => captureGhostProbe(term, 't1')).not.toThrow()
  })

  it('captures the bottom 8 rows and nothing above them', () => {
    const term = stubTerm({ bufferRows: Array.from({ length: 30 }, (_, i) => `row ${i}`) })
    const r = captureGhostProbe(term, 't1')
    expect(r.tail).toHaveLength(8)
    expect(r.tail[0].row).toBe(22)
    expect(r.tail[7].row).toBe(29)
    expect(r.tail[7].buffer).toBe('row 29')
    expect(r.mismatches).toBe(0)
  })

  it('reports the DOM going stale under a correct buffer — the ghost', () => {
    const bufferRows = Array.from({ length: 30 }, (_, i) => `row ${i}`)
    const domRows = [...bufferRows]
    domRows[28] = '' // blanked, the shape the composer ghost takes
    domRows[29] = '❯' // truncated to its first glyph, the other reported shape
    const r = captureGhostProbe(stubTerm({ bufferRows, domRows }), 't1')

    expect(r.mismatches).toBe(2)
    expect(r.tail.find((t) => t.row === 28)).toMatchObject({ buffer: 'row 28', dom: '' })
    expect(r.tail.find((t) => t.row === 29)).toMatchObject({ buffer: 'row 29', dom: '❯' })
    expect(formatGhostProbe(r)).toContain('the DOM ITSELF is stale')
  })

  it('does not call trailing padding or &nbsp; a mismatch', () => {
    // The DOM pads trailing cells and uses non-breaking spaces; the buffer does neither. Counting
    // that as the ghost would make every capture a false positive.
    const bufferRows = Array.from({ length: 30 }, () => 'text')
    const domRows = Array.from({ length: 30 }, () => 'text     ')
    expect(captureGhostProbe(stubTerm({ bufferRows, domRows }), 't1').mismatches).toBe(0)
  })

  it('records the state that explains a swallowed repaint', () => {
    const r = captureGhostProbe(
      stubTerm({ bufferRows: Array.from({ length: 30 }, () => 'x'), sync: true, paused: true }),
      't1',
    )
    expect(r.syncOutputOpen).toBe(true)
    expect(r.renderPaused).toBe(true)
    const text = formatGhostProbe(r)
    expect(text).toContain('OPEN (a refresh here paints nothing)')
    expect(text).toContain('render paused true')
  })

  it('flags a DOM that is holding fewer rows than the viewport', () => {
    // `DomRenderer.renderRows` breaks at the first row it cannot resolve, so a short row list is
    // itself the finding — the tail was never built.
    const bufferRows = Array.from({ length: 30 }, (_, i) => `row ${i}`)
    const r = captureGhostProbe(stubTerm({ bufferRows, domRows: bufferRows.slice(0, 24) }), 't1')
    expect(r.domRowCount).toBe(24)
    expect(formatGhostProbe(r)).toContain('⚠ fewer than 30')
  })

  it('degrades to unknown rather than throwing when xterm internals move', () => {
    const term = stubTerm({ bufferRows: Array.from({ length: 30 }, () => 'x') })
    delete (term as unknown as { _core?: unknown })._core
    const r = captureGhostProbe(term, 't1')
    expect(r.syncOutputOpen).toBeNull()
    expect(r.renderPaused).toBeNull()
    expect(formatGhostProbe(r)).toContain('sync-output   unknown')
  })

  it('says plainly which of the two bugs a clean capture points at', () => {
    const r = captureGhostProbe(stubTerm({ bufferRows: Array.from({ length: 30 }, () => 'x') }), 't1')
    const text = formatGhostProbe(r)
    expect(text).toContain('the DOM matches the buffer')
    expect(text).toContain('compositor flush')
  })
})
