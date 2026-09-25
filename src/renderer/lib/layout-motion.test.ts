import { describe, expect, it } from 'vitest'
import { layoutTransition, pinWidth } from './layout-motion'

describe('pinWidth — the heavy content holds the wider of a move\'s two widths', () => {
  it('a narrowing move (rail expands, panel opens) holds the START width', () => {
    expect(pinWidth(null, 1140, -194)).toBe(1140)
    expect(pinWidth(null, 1140, -468)).toBe(1140)
  })

  it('a widening move (rail collapses, panel closes) takes the END width at once', () => {
    expect(pinWidth(null, 1140, 194)).toBe(1334)
    expect(pinWidth(null, 672, 468)).toBe(1140)
  })

  it('a reversal mid-move keeps a width covering where the first move started', () => {
    // Collapse from 1140 (pin 1334), reversed halfway at a live 1237: the reversal ends at 1140.
    const first = pinWidth(null, 1140, 194)
    expect(pinWidth(first, 1237, -194)).toBe(1334)
    // Expand from 1334 (pin 1334), reversed halfway at 1237: ends back at 1334.
    const second = pinWidth(null, 1334, -194)
    expect(pinWidth(second, 1237, 194)).toBeGreaterThanOrEqual(1334)
  })

  it('rounds to whole pixels', () => {
    expect(pinWidth(null, 1140.4, 0)).toBe(1140)
  })
})

describe('layoutTransition', () => {
  it('is none under reduced motion, so the toggle is one frame', () => {
    expect(layoutTransition('width', true)).toBe('none')
    expect(layoutTransition('width', false)).toBe('width 260ms cubic-bezier(0.4, 0, 0.2, 1)')
  })
})
