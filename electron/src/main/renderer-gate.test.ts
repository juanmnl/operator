import { describe, it, expect, vi } from 'vitest'
import { createRendererGate, replacesDocument, HELD_LIMIT } from './renderer-gate'

// Review M1 (2026-10-06): a dispatch sent while the renderer was dead, or before its lane tabs were
// back, was dropped or reported as coming from a lane that was gone.
describe('createRendererGate', () => {
  const setup = (hasWindow = () => true) => {
    const got: number[] = []
    const gate = createRendererGate<number>((e) => { if (!hasWindow()) return false; got.push(e); return true })
    return { gate, got }
  }

  it('holds everything until the first renderer is ready (launch)', () => {
    const { gate, got } = setup()
    gate.send(1)
    gate.send(2)
    expect(got).toEqual([])
    gate.release()
    expect(got).toEqual([1, 2])
    gate.send(3)
    expect(got).toEqual([1, 2, 3])
    expect(gate.held()).toBe(0)
  })

  it('holds from a crash or a reload until the new renderer is ready, then sends oldest first', () => {
    const { gate, got } = setup()
    gate.release()
    gate.send(1)
    gate.hold() // render-process-gone, or Cmd+R's did-start-navigation
    gate.send(2)
    gate.send(3)
    expect(got).toEqual([1])
    gate.release()
    expect(got).toEqual([1, 2, 3])
  })

  it('keeps an event when there is no window, and later events do not overtake it', () => {
    let hasWindow = true
    const { gate, got } = setup(() => hasWindow)
    gate.release()
    hasWindow = false
    gate.send(1)
    hasWindow = true
    gate.send(2) // a window is back, but no renderer said it is ready
    expect(got).toEqual([])
    gate.release()
    expect(got).toEqual([1, 2])
  })

  it('stays held when the window disappears during a release', () => {
    let calls = 0
    const got: number[] = []
    const gate = createRendererGate<number>((e) => { if (++calls === 3) return false; got.push(e); return true })
    gate.send(1); gate.send(2); gate.send(3)
    gate.release()
    expect(got).toEqual([1, 2])
    expect(gate.held()).toBe(1)
    gate.send(4)
    expect(got).toEqual([1, 2])
    gate.release()
    expect(got).toEqual([1, 2, 3, 4])
  })

  it('drops the oldest past the limit', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { gate, got } = setup()
    for (let i = 0; i < HELD_LIMIT + 5; i++) gate.send(i)
    expect(gate.held()).toBe(HELD_LIMIT)
    gate.release()
    expect(got[0]).toBe(5)
    expect(got).toHaveLength(HELD_LIMIT)
    err.mockRestore()
  })
})

describe('replacesDocument', () => {
  it('is true only for a main-frame, cross-document navigation', () => {
    expect(replacesDocument({ isMainFrame: true, isSameDocument: false })).toBe(true)
    // The error page's #operator-reload link, pushState in the app.
    expect(replacesDocument({ isMainFrame: true, isSameDocument: true })).toBe(false)
    // The Preview iframe.
    expect(replacesDocument({ isMainFrame: false, isSameDocument: false })).toBe(false)
  })
})
