import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { getTuiMode, setTuiMode, getRendererMode, setRendererMode, spawnTerminalMode, planDeferredFit, FIT_QUIET_MS, FIT_MAX_DEFER_MS } from './terminal-options'

// getTuiMode is on the session-spawn path (operator-bridge terminalSpawn), so a throw
// or a bogus value here would break launching, not just the preference. These pin the
// contract: always one of the two valid modes, never an exception.
describe('getTuiMode', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('defaults to classic when unset', () => {
    expect(getTuiMode()).toBe('default')
  })

  it('round-trips through setTuiMode', () => {
    setTuiMode('fullscreen')
    expect(getTuiMode()).toBe('fullscreen')
    setTuiMode('default')
    expect(getTuiMode()).toBe('default')
  })

  it('treats any unrecognised stored value as classic', () => {
    localStorage.setItem('operator.terminal.tuiMode', 'nonsense')
    expect(getTuiMode()).toBe('default')
  })

  it('falls back to classic when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    expect(getTuiMode()).toBe('default')
  })
})

// The renderer pref is on the same spawn path, and it is an OPT-IN escape hatch for a soak test
// of the grid terminal — so the case that matters most is the one nobody will look at: that a
// default install, and any install with a corrupt value, still gets xterm.
describe('getRendererMode', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('defaults to xterm when unset — the grid is opt-in, never inherited', () => {
    expect(getRendererMode()).toBe('xterm')
  })

  it('round-trips through setRendererMode', () => {
    setRendererMode('grid')
    expect(getRendererMode()).toBe('grid')
    setRendererMode('xterm')
    expect(getRendererMode()).toBe('xterm')
  })

  it('treats any unrecognised stored value as xterm', () => {
    localStorage.setItem('operator.terminal.renderer', 'ghostty')
    expect(getRendererMode()).toBe('xterm')
  })

  it('falls back to xterm when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    expect(getRendererMode()).toBe('xterm')
  })
})

// The COUPLING is the part worth pinning: grid mode forces Claude's fullscreen TUI whatever the
// tui pref says, because alt-screen is the only mode the grid was built to parse — and classic is
// the mode whose absolute-column redraws produce the overprint the grid exists to escape.
describe('spawnTerminalMode', () => {
  beforeEach(() => localStorage.clear())

  it('default install: xterm, and the tui pref is honoured', () => {
    expect(spawnTerminalMode()).toEqual({ grid: false, tuiMode: 'default' })
    setTuiMode('fullscreen')
    expect(spawnTerminalMode()).toEqual({ grid: false, tuiMode: 'fullscreen' })
  })

  it('grid FORCES fullscreen even when the tui pref says classic', () => {
    setRendererMode('grid')
    setTuiMode('default')
    expect(spawnTerminalMode()).toEqual({ grid: true, tuiMode: 'fullscreen' })
  })

  it('grid + fullscreen pref agree, and turning grid back off restores the pref', () => {
    setRendererMode('grid')
    setTuiMode('fullscreen')
    expect(spawnTerminalMode()).toEqual({ grid: true, tuiMode: 'fullscreen' })
    setRendererMode('xterm')
    setTuiMode('default')
    // The tui pref was never written to by grid mode — it is overridden at spawn, not persisted.
    expect(spawnTerminalMode()).toEqual({ grid: false, tuiMode: 'default' })
  })
})

// The fit gate. This is a TIMING policy, which is exactly why the starvation survived: it could
// only be observed by watching a real terminal not resize. Driving the pure decision through a
// simulated clock makes "never fits" an assertion.
describe('planDeferredFit', () => {
  it('fits immediately when output has been quiet', () => {
    // 1000ms since the last chunk — far outside the quiet window.
    expect(planDeferredFit(1000, 0, null)).toEqual({ fit: true, retryInMs: 0 })
  })

  it('fits immediately on a pane that has never received output', () => {
    // The pane's lastDataAtRef starts at 0 against a real epoch clock, so "never" reads as an
    // enormous quiet period and a fresh pane is not gated at all.
    expect(planDeferredFit(Date.now(), 0, null).fit).toBe(true)
  })

  it('defers while output is mid-burst, and asks again after the quiet window', () => {
    const plan = planDeferredFit(1000, 960, null) // 40ms since data
    expect(plan.fit).toBe(false)
    expect(plan.retryInMs).toBe(FIT_QUIET_MS - 40 + 10)
  })

  it('fits once the deferral has run past FIT_MAX_DEFER_MS, however busy the stream is', () => {
    // Still only 10ms since the last chunk — the quiet gate alone would defer forever.
    const plan = planDeferredFit(5000, 4990, 5000 - FIT_MAX_DEFER_MS)
    expect(plan).toEqual({ fit: true, retryInMs: 0 })
  })

  it('never schedules a retry past the deadline', () => {
    // 20ms of budget left, but 140ms of quiet window to wait out: the retry must land on the
    // deadline, not 120ms beyond it.
    const firstDefer = 1000
    const now = firstDefer + FIT_MAX_DEFER_MS - 20
    const plan = planDeferredFit(now, now - 10, firstDefer)
    expect(plan.fit).toBe(false)
    expect(plan.retryInMs).toBe(20)
  })
})

// THE REGRESSION ITSELF. QA measured 0 resizes in 2000ms on a streaming lane; the same collapse
// on an idle lane fitted once at ~327ms. This simulates the pane's loop — refs, replace-on-new-
// resize, and the retry timer — against a fake clock, so the fix is pinned by behaviour rather
// than by the constant's value.
//
// `busyAtStart` is what makes these tests real. The reported scenario is a resize arriving while
// output is ALREADY streaming; with an idle start the very first request fits at t=0 and the
// whole gate is never exercised — the test would pass just as well against the unbounded code it
// exists to catch. The counterfactual test below (maxDeferMs: Infinity) is the proof it doesn't.
function simulate(opts: {
  dataEveryMs: number | null
  runForMs: number
  extraResizeAtMs?: number
  resizeEveryMs?: number
  busyAtStart?: boolean
  maxDeferMs?: number
}) {
  let now = 0
  // "No output has ever arrived", the way the pane sees it: lastDataAtRef starts at 0 against a
  // real epoch clock, so a simulated clock starting at 0 would read as "a chunk just landed".
  let lastDataAt = opts.busyAtStart ? 0 : -1e9
  let firstDeferAt: number | null = null
  let pendingAt: number | null = null // when the scheduled retry is due (replaces, never stacks)
  let pendingEver = 0                 // how many retries were ever outstanding at once
  const fits: number[] = []
  const plan = () => planDeferredFit(now, lastDataAt, firstDeferAt, { maxDeferMs: opts.maxDeferMs })

  const request = () => {
    // Mirrors handleResize: an incoming request CLEARS any pending retry before deciding.
    pendingAt = null
    const p = plan()
    if (!p.fit) {
      if (firstDeferAt == null) firstDeferAt = now
      pendingAt = now + p.retryInMs
      pendingEver = Math.max(pendingEver, 1)
      return
    }
    firstDeferAt = null
    fits.push(now)
  }

  request() // the resize that starts it all (a sidebar collapse)
  for (now = 1; now <= opts.runForMs; now++) {
    if (opts.dataEveryMs && now % opts.dataEveryMs === 0) lastDataAt = now
    if (opts.extraResizeAtMs === now) request()
    if (opts.resizeEveryMs && now % opts.resizeEveryMs === 0) request()
    if (pendingAt != null && now >= pendingAt) request()
  }
  return { fits, pendingEver }
}

describe('the fit gate under a stream (regression: unbounded deferral starved every resize)', () => {
  it('idle: fits immediately, once', () => {
    const { fits } = simulate({ dataEveryMs: null, runForMs: 2000 })
    expect(fits).toEqual([0])
  })

  it('WITHOUT the bound, a 60ms stream starves the fit completely — the bug', () => {
    // The counterfactual, and the reason the tests below mean anything: same loop, deferral
    // unbounded, 2000ms of a stream that ticks inside the quiet window → zero fits. This is
    // QA's "0 resizes in 2000 ms" reproduced as an assertion.
    const { fits } = simulate({ dataEveryMs: 60, runForMs: 2000, busyAtStart: true, maxDeferMs: Infinity })
    expect(fits).toEqual([])
  })

  it('data every 60ms: fits within FIT_MAX_DEFER_MS + FIT_QUIET_MS — NOT never', () => {
    const { fits } = simulate({ dataEveryMs: 60, runForMs: 2000, busyAtStart: true })
    expect(fits.length).toBeGreaterThan(0)
    expect(fits[0]).toBeLessThanOrEqual(FIT_MAX_DEFER_MS + FIT_QUIET_MS)
  })

  it('data every 60ms: fits ONCE for one resize, not repeatedly', () => {
    const { fits } = simulate({ dataEveryMs: 60, runForMs: 2000, busyAtStart: true })
    expect(fits).toHaveLength(1)
  })

  it('a second resize during the deferral replaces the pending fit, it does not stack', () => {
    const { fits, pendingEver } = simulate({
      dataEveryMs: 60, runForMs: 2000, busyAtStart: true, extraResizeAtMs: 200,
    })
    expect(pendingEver).toBe(1)
    // One fit, not two: the resize at 200ms replaced the pending retry rather than adding one.
    expect(fits).toHaveLength(1)
    expect(fits[0]).toBeLessThanOrEqual(FIT_MAX_DEFER_MS + FIT_QUIET_MS)
  })

  it('a continuous drag does not restart the budget (that would be the same starvation)', () => {
    // A resize every 100ms for the whole run. The fit must still land on the ORIGINAL deadline
    // rather than being pushed out by each new callback.
    const { fits } = simulate({
      dataEveryMs: 60, runForMs: 2000, busyAtStart: true, resizeEveryMs: 100,
    })
    expect(fits.length).toBeGreaterThan(0)
    expect(fits[0]).toBeLessThanOrEqual(FIT_MAX_DEFER_MS + FIT_QUIET_MS)
  })
})
