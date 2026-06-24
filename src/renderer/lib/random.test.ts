import { describe, it, expect } from 'vitest'
import { rand, hashSeed, gridPointsInDisc } from './random'

describe('rand', () => {
  it('is zero at the origin and deterministic', () => {
    expect(rand(0)).toBe(0) // sin(0) = 0
    expect(rand(7.5)).toBe(rand(7.5))
  })
  it('stays within [0,1)', () => {
    for (let i = 0; i < 100; i++) {
      const v = rand(i + 0.5)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('hashSeed', () => {
  it('passes numbers through unchanged', () => {
    expect(hashSeed(5)).toBe(5)
    expect(hashSeed(0)).toBe(0)
  })
  it('folds strings deterministically', () => {
    expect(hashSeed('')).toBe(0)
    expect(hashSeed('a')).toBe(97)
    expect(hashSeed('session-x')).toBe(hashSeed('session-x'))
    expect(hashSeed('a')).not.toBe(hashSeed('b'))
  })
})

describe('gridPointsInDisc', () => {
  it('selects the 37 cells inside the 7-cell brand disc', () => {
    // Must match the Rust tray_anim build_dots() count so the icon and the
    // sidebar wave share a layout.
    expect(gridPointsInDisc(7, 3.4).length).toBe(37)
  })
  it('keeps every point within the disc tolerance', () => {
    const cells = 7, radius = 3.4
    const center = (cells - 1) / 2 + 0.5
    const max = radius * radius * 1.04
    for (const p of gridPointsInDisc(cells, radius)) {
      const dx = p.cx - center, dy = p.cy - center
      expect(dx * dx + dy * dy).toBeLessThanOrEqual(max)
    }
  })
})
