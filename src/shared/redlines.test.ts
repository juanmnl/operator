import { describe, it, expect } from 'vitest'
import { measureBetween, formatPx, placeChip, type Box } from './redlines'

const box = (left: number, top: number, right: number, bottom: number): Box => ({ left, top, right, bottom })

describe('measureBetween — rule 1, one contains the other', () => {
  it('draws four insets from inner to outer through the inner box\'s centre lines', () => {
    expect(measureBetween(box(10, 20, 110, 70), box(0, 0, 200, 100))).toEqual([
      { x1: 0, y1: 45, x2: 10, y2: 45, value: 10 },
      { x1: 110, y1: 45, x2: 200, y2: 45, value: 90 },
      { x1: 60, y1: 0, x2: 60, y2: 20, value: 20 },
      { x1: 60, y1: 70, x2: 60, y2: 100, value: 30 },
    ])
  })

  it('gives the same insets whichever box is the anchor', () => {
    expect(measureBetween(box(0, 0, 200, 100), box(10, 20, 110, 70))).toEqual(measureBetween(box(10, 20, 110, 70), box(0, 0, 200, 100)))
  })

  it('does not draw zero-length insets', () => {
    const segs = measureBetween(box(0, 20, 110, 100), box(0, 0, 200, 100))
    expect(segs.map((s) => s.value)).toEqual([90, 20])
  })

  it('draws nothing for two identical boxes', () => {
    expect(measureBetween(box(5, 5, 50, 50), box(5, 5, 50, 50))).toEqual([])
  })
})

describe('measureBetween — rules 2 and 3, separated', () => {
  it('horizontal gap at the middle of the vertical overlap', () => {
    expect(measureBetween(box(0, 0, 100, 50), box(130, 20, 200, 80))).toEqual([
      { x1: 100, y1: 35, x2: 130, y2: 35, value: 30 },
    ])
  })

  it('horizontal gap when the other box is to the left', () => {
    expect(measureBetween(box(130, 20, 200, 80), box(0, 0, 100, 50))).toEqual([
      { x1: 100, y1: 35, x2: 130, y2: 35, value: 30 },
    ])
  })

  it('vertical gap at the middle of the horizontal overlap', () => {
    expect(measureBetween(box(0, 0, 100, 50), box(40, 66, 160, 90))).toEqual([
      { x1: 70, y1: 50, x2: 70, y2: 66, value: 16 },
    ])
  })

  it('diagonal neighbours get both lines, each at A\'s centre with a dashed extension along B\'s edge', () => {
    expect(measureBetween(box(0, 0, 100, 50), box(130, 80, 200, 120))).toEqual([
      { x1: 130, y1: 25, x2: 130, y2: 80, value: null },
      { x1: 100, y1: 25, x2: 130, y2: 25, value: 30 },
      { x1: 50, y1: 80, x2: 130, y2: 80, value: null },
      { x1: 50, y1: 50, x2: 50, y2: 80, value: 30 },
    ])
  })

  it('touching edges measure 0', () => {
    expect(measureBetween(box(0, 0, 100, 50), box(100, 0, 150, 50)).map((s) => s.value)).toEqual([0])
  })
})

describe('measureBetween — rule 4, overlapping', () => {
  it('draws the left-edge and top-edge offsets through the overlap', () => {
    expect(measureBetween(box(0, 0, 100, 100), box(50, 30, 150, 130))).toEqual([
      { x1: 0, y1: 65, x2: 50, y2: 65, value: 50 },
      { x1: 75, y1: 0, x2: 75, y2: 30, value: 30 },
    ])
  })
})

describe('formatPx — rule 5', () => {
  it('integer when within 0.01 of one, otherwise one decimal', () => {
    expect(formatPx(12)).toBe('12')
    expect(formatPx(12.004)).toBe('12')
    expect(formatPx(11.995)).toBe('12')
    expect(formatPx(12.5)).toBe('12.5')
    expect(formatPx(72.6667)).toBe('72.7')
    expect(formatPx(0)).toBe('0')
  })
})

describe('placeChip', () => {
  const view = { w: 800, h: 600 }

  it('centres the chip on a line long enough to hold it', () => {
    expect(placeChip({ x1: 100, y1: 200, x2: 300, y2: 200, value: 200 }, 30, 14, view.w, view.h)).toEqual({ left: 185, top: 193 })
  })

  it('moves the chip past the end of a line shorter than it', () => {
    expect(placeChip({ x1: 100, y1: 200, x2: 110, y2: 200, value: 10 }, 30, 14, view.w, view.h)).toEqual({ left: 114, top: 193 })
    expect(placeChip({ x1: 50, y1: 100, x2: 50, y2: 108, value: 8 }, 30, 14, view.w, view.h)).toEqual({ left: 35, top: 112 })
  })

  it('puts it before the start when the end is at the viewport edge', () => {
    expect(placeChip({ x1: 780, y1: 200, x2: 790, y2: 200, value: 10 }, 30, 14, view.w, view.h)).toEqual({ left: 746, top: 193 })
  })

  it('keeps the chip inside the viewport', () => {
    expect(placeChip({ x1: 0, y1: 2, x2: 40, y2: 2, value: 40 }, 30, 14, view.w, view.h)).toEqual({ left: 5, top: 0 })
    expect(placeChip({ x1: 700, y1: 598, x2: 800, y2: 598, value: 100 }, 30, 14, view.w, view.h)).toEqual({ left: 735, top: 586 })
  })
})

describe('self-contained, for the script injected into the page', () => {
  it('each function works rebuilt from its source string', () => {
    const rebuild = <T,>(fn: T) => new Function(`return (${String(fn)})`)() as T
    const a = box(0, 0, 100, 50), b = box(130, 80, 200, 120)
    expect(rebuild(measureBetween)(a, b)).toEqual(measureBetween(a, b))
    expect(rebuild(formatPx)(72.6667)).toBe('72.7')
    const seg = { x1: 780, y1: 200, x2: 790, y2: 200, value: 10 }
    expect(rebuild(placeChip)(seg, 30, 14, 800, 600)).toEqual(placeChip(seg, 30, 14, 800, 600))
  })
})
