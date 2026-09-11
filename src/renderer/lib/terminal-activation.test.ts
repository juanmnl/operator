import { describe, it, expect } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { applyPaneActivation, ACTIVE_SCROLLBACK, INACTIVE_SCROLLBACK, type ActivatingTerminal } from './terminal-options'

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
