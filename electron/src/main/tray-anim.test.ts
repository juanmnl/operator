import { describe, it, expect } from 'vitest'
import { aggregateState, buildDots, frame, rand, startTrayAnimation } from './tray-anim'

const SIZE = 44
/** The visible mark and its padding — the numbers this file exists to pin. Kept as literals
 *  rather than imported from `tray-anim`, so a test cannot agree with a constant that changed. */
const MARK = 36
const INSET = (SIZE - MARK) / 2
const alpha = (buf: Buffer) => { let n = 0; for (let i = 3; i < buf.length; i += 4) n += buf[i]; return n }

// Ported from the `#[cfg(test)]` block in tray_anim.rs — the pseudo-random is FROZEN on purpose:
// it is what makes the tray's dots carry the same weights as the mark in the app.
describe('rand', () => {
  it('is deterministic and in the unit range', () => {
    expect(rand(0)).toBe(0) // sin(0) = 0
    for (let i = 0; i < 50; i++) {
      const v = rand(i + 0.5)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
      expect(rand(i + 0.5)).toBe(v)
    }
  })
})

describe('buildDots', () => {
  it('fills the disc deterministically — 37 of the 7×7 cells', () => {
    const dots = buildDots()
    expect(dots).toHaveLength(37)
    const max = 3.4 * 3.4 * 1.04
    for (const d of dots) {
      const dx = d.cx - 3.5
      const dy = d.cy - 3.5
      expect(dx * dx + dy * dy).toBeLessThanOrEqual(max)
      expect(d.dur).toBeGreaterThanOrEqual(1.4)
      expect(d.dur).toBeLessThan(2.6)
      expect(d.v).toBeGreaterThanOrEqual(0)
      expect(d.v).toBeLessThan(1)
      expect(d.off).toBeGreaterThanOrEqual(0)
      expect(d.off).toBeLessThan(1)
    }
  })
})

describe('frame', () => {
  const dots = buildDots()

  it('is a 44×44 RGBA buffer carrying shape in ALPHA ONLY — that is what makes it a template', () => {
    const buf = frame(dots, 'idle', 0)
    expect(buf).toHaveLength(SIZE * SIZE * 4)
    for (let i = 0; i < buf.length; i += 4) {
      expect(buf[i]).toBe(0) // R
      expect(buf[i + 1]).toBe(0) // G
      expect(buf[i + 2]).toBe(0) // B
    }
    expect(alpha(buf)).toBeGreaterThan(0) // …and something is actually drawn
  })

  // THE SIZE TEST. A macOS menu-bar template icon is ~18pt; at scaleFactor 2 that is a 36px mark
  // inside the 44px canvas, leaving a 4px inset on every side. It was 40px (20.0pt), matched by
  // hand to the opaque box inside `tray.png`, and read visibly larger than the Tauri build's.
  //
  // Asserted as MEASURED EXTENT across a full cycle rather than as "the border is empty": the dot
  // scale varies with time, so a single frame can sit well inside the mark and pass a border
  // check while the mark itself is the wrong size.
  it('draws a 36px (18pt) mark inside the 44px canvas — a 4px inset on every side', () => {
    let minX = SIZE, maxX = -1, minY = SIZE, maxY = -1
    for (const state of ['idle', 'busy', 'your-turn'] as const) {
      for (let i = 0; i < 60; i++) {
        const buf = frame(dots, state, i * 0.05)
        for (let y = 0; y < SIZE; y++) {
          for (let x = 0; x < SIZE; x++) {
            if (buf[(y * SIZE + x) * 4 + 3] === 0) continue
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
          }
        }
      }
    }
    expect({ minX, maxX, minY, maxY }).toEqual({ minX: INSET, maxX: SIZE - INSET - 1, minY: INSET, maxY: SIZE - INSET - 1 })
    expect(maxX - minX + 1).toBe(MARK)
    expect((maxX - minX + 1) / 2).toBe(18) // points, at scaleFactor 2
  })

  it('never paints outside the canvas edge, in any phase', () => {
    const buf = frame(dots, 'busy', 0.4)
    const at = (x: number, y: number) => buf[(y * SIZE + x) * 4 + 3]
    for (let i = 0; i < SIZE; i++) {
      expect(at(i, 0)).toBe(0)
      expect(at(i, SIZE - 1)).toBe(0)
      expect(at(0, i)).toBe(0)
      expect(at(SIZE - 1, i)).toBe(0)
    }
  })

  it('busy MOVES — successive frames differ, and the dots are desynced, not in lockstep', () => {
    const a = frame(dots, 'busy', 0)
    const b = frame(dots, 'busy', 0.4)
    expect(b.equals(a)).toBe(false)
    // Desync: at t=0 the per-dot phases are spread, so the frame is neither empty nor saturated.
    const ink = alpha(a)
    expect(ink).toBeGreaterThan(0)
    expect(ink).toBeLessThan(alpha(frame(dots, 'idle', 0)) * 4)
  })

  it('idle is STATIC — the same bytes at any t, so there is nothing to repaint', () => {
    expect(frame(dots, 'idle', 12.5).equals(frame(dots, 'idle', 0))).toBe(true)
  })

  it('your-turn breathes in unison on a 2.6s cycle', () => {
    const trough = frame(dots, 'your-turn', 0) // pulse = 0
    const peak = frame(dots, 'your-turn', 1.3) // pulse = 1, half a cycle later
    expect(alpha(peak)).toBeGreaterThan(alpha(trough))
    expect(frame(dots, 'your-turn', 2.6).equals(trough)).toBe(true) // full cycle
  })
})

// Ported from the reducer the tailer runs inline (transcript.rs:1131-1149).
describe('aggregateState', () => {
  it('any running lane means busy, whatever else is open', () => {
    expect(aggregateState([{ phase: 'idle' }, { phase: 'waiting' }, { phase: 'running' }])).toBe('busy')
  })

  it('no running but something waiting means your-turn', () => {
    expect(aggregateState([{ phase: 'idle' }, { phase: 'waiting' }])).toBe('your-turn')
  })

  it('nothing working and nothing blocked on you is idle', () => {
    expect(aggregateState([])).toBe('idle')
    expect(aggregateState([{ phase: 'idle' }, { phase: 'ended' }, { phase: 'compacting' }])).toBe('idle')
  })
})

// The loop's contract, driven with fake timers: MOTION IS THE BUSY SIGNAL. Idle must paint once
// and then rest — a menu bar that repaints 12 times a second while nothing is happening is both
// a lie and a battery cost.
describe('startTrayAnimation', () => {
  it('paints idle exactly once and then rests', async () => {
    const { vi } = await import('vitest')
    vi.useFakeTimers()
    let painted = 0
    const stop = startTrayAnimation(() => 'idle', () => { painted++ })
    expect(painted).toBe(1) // immediately, not 80ms into the app's life
    vi.advanceTimersByTime(1000)
    expect(painted).toBe(1)
    stop()
    vi.useRealTimers()
  })

  it('busy repaints ~12fps, and stop() actually stops it', async () => {
    const { vi } = await import('vitest')
    vi.useFakeTimers()
    let painted = 0
    const stop = startTrayAnimation(() => 'busy', () => { painted++ })
    vi.advanceTimersByTime(800) // 10 ticks at 80ms
    expect(painted).toBeGreaterThanOrEqual(10)
    const seen = painted
    stop()
    vi.advanceTimersByTime(800)
    expect(painted).toBe(seen)
    vi.useRealTimers()
  })

  it('your-turn SETTLES after 6s — a beacon, not a permanent pulse — and re-arms on a new turn', async () => {
    const { vi } = await import('vitest')
    vi.useFakeTimers()
    let phase: 'idle' | 'busy' | 'your-turn' = 'your-turn'
    let painted = 0
    const stop = startTrayAnimation(() => phase, () => { painted++ })
    vi.advanceTimersByTime(6000)
    const during = painted
    vi.advanceTimersByTime(2000) // settled: the static mark, painted once more, then quiet
    expect(painted).toBeLessThanOrEqual(during + 1)
    const settled = painted
    phase = 'busy' // a fresh turn re-arms the pulse
    vi.advanceTimersByTime(400)
    expect(painted).toBeGreaterThan(settled)
    stop()
    vi.useRealTimers()
  })
})
