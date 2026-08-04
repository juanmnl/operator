import { describe, it, expect } from 'vitest'
import { scrollbackFor, ACTIVE_SCROLLBACK, INACTIVE_SCROLLBACK, buildTerminalOptions } from './terminal-options'

describe('scrollbackFor', () => {
  it('gives the visible pane its full history, unchanged', () => {
    expect(scrollbackFor(true)).toBe(10_000)
    expect(scrollbackFor(true)).toBe(ACTIVE_SCROLLBACK)
  })

  it('gives a mounted-but-hidden pane a smaller buffer', () => {
    expect(scrollbackFor(false)).toBe(INACTIVE_SCROLLBACK)
    expect(INACTIVE_SCROLLBACK).toBeLessThan(ACTIVE_SCROLLBACK)
  })

  it('keeps a background pane generous enough to be useful', () => {
    // ~20 screens. Small enough to matter for memory, big enough that switching back
    // rarely finds the top of the buffer.
    expect(INACTIVE_SCROLLBACK).toBeGreaterThanOrEqual(2_000)
  })

  it('bounds the worst real case — eight mounted lanes', () => {
    // The measured crash: `operator` holds 8 live sessions and DashboardView mounts every one.
    // Before, that was 8 × 10k = 80,000 lines of buffered cells in a single renderer.
    const lanes = 8
    const before = lanes * ACTIVE_SCROLLBACK
    const after = ACTIVE_SCROLLBACK + (lanes - 1) * INACTIVE_SCROLLBACK
    expect(before).toBe(80_000)
    expect(after).toBeLessThan(before / 3)
  })

  it('a fresh terminal is built with the active size (panes mount visible, then settle)', () => {
    const opts = buildTerminalOptions({ background: '#000000' })
    expect(opts.scrollback).toBe(ACTIVE_SCROLLBACK)
  })
})
