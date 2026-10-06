import { describe, it, expect, vi } from 'vitest'
import { createReadyFallback, createRendererGate, replacesDocument, HELD_LIMIT, HELD_MAX_AGE_MS, READY_FALLBACK_MS } from './renderer-gate'

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
    gate.hold() // render-process-gone, or Cmd+R's committed navigation
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

// Review M2 (round 2): events held while the window was closed were routed in one burst when it
// reopened, hours later, launching lanes and typing stale replies.
describe('held events have an age limit', () => {
  const setup = () => {
    let t = 0
    const got: number[] = []
    const expired: Array<{ events: number[]; dropped: number }> = []
    const gate = createRendererGate<number>((e) => { got.push(e); return true }, {
      now: () => t,
      onExpired: (events, dropped) => expired.push({ events, dropped }),
      limit: 3,
    })
    return { gate, got, expired, advance: (ms: number) => { t += ms } }
  }

  it('routes only events younger than the limit and hands the rest to onExpired', () => {
    const { gate, got, expired, advance } = setup()
    gate.send(1)
    advance(HELD_MAX_AGE_MS)
    gate.send(2)
    advance(1)
    gate.release()
    expect(expired).toEqual([{ events: [1], dropped: 0 }])
    expect(got).toEqual([2])
  })

  it('a reload within the limit routes everything and reports nothing', () => {
    const { gate, got, expired, advance } = setup()
    gate.send(1); advance(2_000); gate.send(2)
    gate.release()
    expect(got).toEqual([1, 2])
    expect(expired).toEqual([])
  })

  it('reports how many were dropped past the cap, once', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { gate, got, expired } = setup()
    for (let i = 0; i < 5; i++) gate.send(i)
    gate.release()
    expect(expired).toEqual([{ events: [], dropped: 2 }])
    expect(got).toEqual([2, 3, 4])
    gate.hold(); gate.send(9); gate.release()
    expect(expired).toHaveLength(1)
    err.mockRestore()
  })

  it('an event that waits out a failed delivery keeps its original age', () => {
    let t = 0
    let window = false
    const expired: number[][] = []
    const gate = createRendererGate<number>(() => window, { now: () => t, onExpired: (e) => expired.push(e) })
    gate.send(1)
    gate.release() // no window: kept, still stamped at 0
    t = HELD_MAX_AGE_MS + 1
    window = true
    gate.release()
    expect(expired).toEqual([[1]])
  })
})

describe('createReadyFallback', () => {
  it('fires when the app loaded and never said it was ready, and not otherwise', () => {
    vi.useFakeTimers()
    const fired = vi.fn()
    const f = createReadyFallback(fired)
    f.loaded(); f.ready()
    vi.advanceTimersByTime(READY_FALLBACK_MS * 2)
    expect(fired).not.toHaveBeenCalled()
    f.loaded(); f.leaving() // replaced before it could be ready: the next load re-arms it
    vi.advanceTimersByTime(READY_FALLBACK_MS * 2)
    expect(fired).not.toHaveBeenCalled()
    f.loaded()
    vi.advanceTimersByTime(READY_FALLBACK_MS)
    expect(fired).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
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
