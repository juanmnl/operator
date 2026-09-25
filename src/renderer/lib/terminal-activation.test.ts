import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { applyPaneActivation, ACTIVE_SCROLLBACK, INACTIVE_SCROLLBACK, type ActivatingTerminal } from './terminal-options'
import xtermPackage from '@xterm/xterm/package.json'
import appPackage from '../../../package.json'

/** A terminal that records every call and option write, and holds write callbacks until the test
 *  says the bytes have parsed — which is what real xterm does asynchronously. */
function recorder(rows = 30) {
  const calls: string[] = []
  const pending: (() => void)[] = []
  const options = new Proxy({} as Record<string, unknown>, {
    set(t, k, v) { calls.push(`${String(k)}=${v}`); t[k as string] = v; return true },
  })
  const term = {
    rows,
    options,
    write: (data: string, cb?: () => void) => { calls.push(`write:${data}`); if (cb) pending.push(cb) },
    scrollToBottom: () => { calls.push('scrollToBottom') },
    refresh: (a: number, b: number) => { calls.push(`refresh:${a}-${b}`) },
    focus: () => { calls.push('focus') },
    blur: () => { calls.push('blur') },
  } as unknown as ActivatingTerminal
  const parse = () => { while (pending.length) pending.shift()!() }
  return { term, calls, parse }
}

describe('applyPaneActivation — the sequence', () => {
  it('activating: trims scrollback, queues the hidden output, focuses; fits only after it parses', () => {
    const { term, calls, parse } = recorder()
    applyPaneActivation(term, true, {
      fit: () => { calls.push('fit') },
      takeHiddenOutput: () => 'hidden',
      isActive: () => true,
    })
    expect(calls).toEqual([
      `scrollback=${ACTIVE_SCROLLBACK}`,
      'cursorBlink=true',
      'scrollToBottom', 'refresh:0-29',
      'write:hidden',
      'focus',
    ])
    calls.length = 0
    parse()
    expect(calls).toEqual(['fit', 'scrollToBottom', 'refresh:0-29'])
  })

  it('scrolls to the bottom even when nothing was buffered (a viewport that drifted while hidden)', () => {
    const { term, calls, parse } = recorder()
    applyPaneActivation(term, true, { fit: () => { calls.push('fit') }, takeHiddenOutput: () => '', isActive: () => true })
    parse()
    expect(calls.filter((c) => c === 'scrollToBottom')).toHaveLength(2)
    expect(calls.indexOf('fit')).toBeLessThan(calls.lastIndexOf('scrollToBottom'))
  })

  it('deactivating: trims, stops the cursor, blurs — and leaves the hidden buffer alone', () => {
    const { term, calls } = recorder()
    let taken = false
    applyPaneActivation(term, false, { fit: () => { calls.push('fit') }, takeHiddenOutput: () => { taken = true; return '' }, isActive: () => false })
    expect(calls).toEqual([`scrollback=${INACTIVE_SCROLLBACK}`, 'cursorBlink=false', 'blur'])
    expect(taken).toBe(false)
  })

  it('does not fit a pane that was switched away before its output parsed (a hidden fit reaches the pty)', () => {
    const { term, calls, parse } = recorder()
    let active = true
    applyPaneActivation(term, true, { fit: () => { calls.push('fit') }, takeHiddenOutput: () => 'hidden', isActive: () => active })
    active = false
    calls.length = 0
    parse()
    expect(calls).toEqual([])
  })

  it('a fit that throws still scrolls and repaints', () => {
    const { term, calls, parse } = recorder()
    applyPaneActivation(term, true, { fit: () => { throw new Error('teardown') }, takeHiddenOutput: () => '', isActive: () => true })
    calls.length = 0
    parse()
    expect(calls).toEqual(['scrollToBottom', 'refresh:0-29'])
  })
})

// Real xterm, no DOM renderer needed: parsing, resize and the viewport are all buffer state.
describe('applyPaneActivation — against a real xterm', () => {
  const settled = (t: Terminal) => new Promise<void>((r) => t.write('', r))
  const row = (t: Terminal, i: number) => t.buffer.active.getLine(i)?.translateToString(true)
  // Composed by the program for an 80-column pty: a full-width line, a status line, then
  // cursor-up and a rewrite of column 0 — the shape of Claude Code's status redraws.
  const COMPOSED_AT_80 = 'A'.repeat(80) + '\r\n' + 'status' + '\x1b[1A\r' + 'X'

  it('WHY THE FIT WAITS: a queued write is parsed after a synchronous resize, and lands on the wrong row', async () => {
    const t = new Terminal({ cols: 80, rows: 6, scrollback: 100 })
    t.write(COMPOSED_AT_80) // queued, not parsed
    t.resize(60, 6) // what fit() does, synchronously
    await settled(t)
    // The 80-column line wrapped at 60 first, so the cursor-up hit its continuation row.
    expect(row(t, 0)).toBe('A'.repeat(60))
    expect(row(t, 1)).toBe('X' + 'A'.repeat(19))
    t.dispose()
  })

  it('hidden output composed for the old width lands where it was aimed, then the pane fits', async () => {
    const t = new Terminal({ cols: 80, rows: 6, scrollback: 100 })
    applyPaneActivation(t, true, { fit: () => t.resize(60, 6), takeHiddenOutput: () => COMPOSED_AT_80, isActive: () => true })
    await settled(t)
    expect(t.cols).toBe(60)
    expect(row(t, 0)?.startsWith('XAAAA')).toBe(true)
    expect(row(t, 1)).toBe('status')
    t.dispose()
  })

  it('a pane left scrolled up opens at the bottom, where the prompt is', async () => {
    const t = new Terminal({ cols: 40, rows: 6, scrollback: 1000 })
    await new Promise<void>((r) => t.write(Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\r\n'), r))
    t.scrollLines(-50)
    expect(t.buffer.active.viewportY).toBeLessThan(t.buffer.active.baseY)
    applyPaneActivation(t, true, { fit: () => {}, takeHiddenOutput: () => '\r\n> prompt', isActive: () => true })
    await settled(t)
    expect(t.buffer.active.viewportY).toBe(t.buffer.active.baseY)
    expect(row(t, t.buffer.active.baseY + t.buffer.active.cursorY)).toBe('> prompt')
    t.dispose()
  })
})

// THE SCROLLBACK FREEZE (dev/results/scrollback-freeze-2026-09-25.md). Lowering `scrollback` on
// hide trims the buffer without telling xterm's scroll viewport, which keeps the old scroll height
// and position about 8,000 lines past the trimmed buffer. After that, a wheel-up moves the stale
// position, xterm turns it into a scroll DOWN, and the buffer clamps it to the bottom: nothing
// moves until the lane prints a line. These tests need the viewport, so the terminal is OPENED
// into jsdom. That takes three shims jsdom lacks: `matchMedia`, a canvas context (null is enough
// for the DOM renderer) and a character measurement (offsetWidth/offsetHeight on xterm's measure
// span), without which every cell would be 0px tall and scroll positions would all be 0.
describe('applyPaneActivation — the viewport follows the scrollback trim', () => {
  const CELL_H = 16
  const saved: { matchMedia?: typeof window.matchMedia; getContext?: unknown; ow?: PropertyDescriptor; oh?: PropertyDescriptor } = {}
  beforeAll(() => {
    saved.matchMedia = window.matchMedia
    saved.getContext = HTMLCanvasElement.prototype.getContext
    saved.ow = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
    saved.oh = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
    window.matchMedia = ((media: string) => ({
      matches: false, media, onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
    HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext
    const measured = (el: HTMLElement) => el.classList.contains('xterm-char-measure-element')
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get(this: HTMLElement) { return measured(this) ? 8 * (this.textContent?.length ?? 0) : 0 } })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get(this: HTMLElement) { return measured(this) ? CELL_H : 0 } })
  })
  afterAll(() => {
    window.matchMedia = saved.matchMedia!
    HTMLCanvasElement.prototype.getContext = saved.getContext as typeof HTMLCanvasElement.prototype.getContext
    if (saved.ow) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', saved.ow)
    if (saved.oh) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', saved.oh)
  })

  type Scrollable = { getScrollDimensions(): { scrollHeight: number }; getScrollPosition(): { scrollTop: number } }
  const scrollable = (t: Terminal) => (t as unknown as { _core: { _viewport: { _scrollableElement: Scrollable } } })._core._viewport._scrollableElement
  /** The viewport's idea of the buffer, in rows, next to the buffer's own. Equal when in sync. */
  const viewportState = (t: Terminal) => ({
    scrollRows: scrollable(t).getScrollDimensions().scrollHeight / CELL_H,
    bufferRows: t.buffer.active.length,
    topRow: scrollable(t).getScrollPosition().scrollTop / CELL_H,
    viewportY: t.buffer.active.viewportY,
  })
  // `queueSync` runs on xterm's next render frame; two frames covers it plus anything it queues.
  const frames = async () => {
    for (let i = 0; i < 2; i++) await new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)))
  }
  const hooks = (active: () => boolean) => ({ fit: () => {}, takeHiddenOutput: () => '', isActive: active })

  /** An opened, active pane holding `lines` lines of history, viewport settled. */
  async function longPane(lines = 6000): Promise<Terminal> {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const t = new Terminal({ cols: 40, rows: 6, scrollback: ACTIVE_SCROLLBACK })
    t.open(el)
    await new Promise<void>((r) => t.write(Array.from({ length: lines }, (_, i) => `line ${i}`).join('\r\n'), r))
    await frames()
    return t
  }

  // THE CANARY. `resyncViewport` reaches xterm internals and returns quietly when they are missing,
  // because a pane must not crash over a scroll repair. That quiet is also how a renamed internal
  // would bring the freeze back with nothing failing, so this test is where it has to fail loudly.
  it('CANARY: the xterm internals resyncViewport calls exist on a real opened Terminal', async () => {
    const t = await longPane(10)
    const viewport = (t as unknown as { _core?: { _viewport?: Record<string, unknown> } })._core?._viewport
    expect(viewport, 'Terminal._core._viewport is gone: resyncViewport is now a no-op and the scrollback freeze is back').toBeDefined()
    expect(typeof viewport!.scrollToLine, 'Viewport.scrollToLine is gone').toBe('function')
    expect(typeof viewport!.queueSync, 'Viewport.queueSync is gone').toBe('function')
    // The two-argument form: `scrollToLine(line, disableSmoothScroll)`. The one-argument
    // `scrollToLine` on the public Terminal is RELATIVE and cannot do the repair.
    expect((viewport!.scrollToLine as (...a: unknown[]) => void).length, 'Viewport.scrollToLine changed shape').toBe(2)
    t.dispose()
  })

  it('CANARY: @xterm/xterm stays pinned to the exact version installed', () => {
    // A caret range would let a minor release rename the internals above without anyone
    // choosing to upgrade. Moving this pin is a deliberate act: bump both together, re-run.
    expect(appPackage.dependencies['@xterm/xterm']).toBe(xtermPackage.version)
  })

  it('is set up right: a long active pane starts with viewport and buffer in sync', async () => {
    const t = await longPane()
    expect(t.buffer.active.length).toBeGreaterThan(INACTIVE_SCROLLBACK)
    const s = viewportState(t)
    expect(s.scrollRows).toBe(s.bufferRows)
    expect(s.topRow).toBe(s.viewportY)
    t.dispose()
  })

  it('hide, then show: the wheel scrolls up at once instead of crossing ~8k lines of dead track', async () => {
    const t = await longPane()
    let active = false
    applyPaneActivation(t, false, hooks(() => active))
    await frames()
    active = true
    applyPaneActivation(t, true, hooks(() => active))
    await new Promise<void>((r) => t.write('', r))
    await frames()

    const s = viewportState(t)
    expect(s.bufferRows).toBeLessThanOrEqual(INACTIVE_SCROLLBACK + t.rows) // the memory trim still happened
    expect(s.scrollRows).toBe(s.bufferRows)
    expect(s.topRow).toBe(s.viewportY)
    expect(t.buffer.active.viewportY).toBe(t.buffer.active.baseY) // opens at the bottom

    const before = t.buffer.active.viewportY
    t.scrollLines(-3) // what TerminalPane's wheel handler calls
    await frames()
    expect(t.buffer.active.viewportY).toBe(before - 3)
    t.dispose()
  })

  it('an ENDED lane, trimmed on hide and never shown again, still scrolls', async () => {
    // `active` requires `!ended`, so an ended lane never reaches the show path. Its repair has
    // to happen on the hide.
    const t = await longPane()
    applyPaneActivation(t, false, hooks(() => false))
    await frames()
    const before = t.buffer.active.viewportY
    t.scrollLines(-3)
    await frames()
    expect(t.buffer.active.viewportY).toBe(before - 3)
    t.dispose()
  })

  it('a pane left scrolled up when hidden keeps its position and the viewport agrees with it', async () => {
    const t = await longPane()
    t.scrollLines(-500)
    await frames()
    applyPaneActivation(t, false, hooks(() => false))
    await frames()
    const s = viewportState(t)
    expect(s.viewportY).toBeLessThan(t.buffer.active.baseY)
    expect(s.scrollRows).toBe(s.bufferRows)
    expect(s.topRow).toBe(s.viewportY)
    t.scrollLines(-3)
    await frames()
    expect(t.buffer.active.viewportY).toBe(s.viewportY - 3)
    t.dispose()
  })

  it('a short pane (under the trim) is left exactly where it was', async () => {
    const t = await longPane(300)
    const before = viewportState(t)
    applyPaneActivation(t, false, hooks(() => false))
    await frames()
    expect(viewportState(t)).toEqual(before)
    t.dispose()
  })
})
