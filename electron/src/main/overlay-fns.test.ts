import { describe, it, expect } from 'vitest'
import { OVERLAY_FNS_JS } from './overlay-fns'
import { layoutGrid, DEFAULT_GRID_SPEC } from '../../../src/shared/layout-grid'
import { measureBetween, formatPx, placeChip } from '../../../src/shared/redlines'

type Fns = { layoutGrid: typeof layoutGrid; measureBetween: typeof measureBetween; formatPx: typeof formatPx; placeChip: typeof placeChip }

// The page gets these functions as SOURCE. A function that reached for an import or a module
// constant would compile here and throw inside the page, where nobody would see it.
describe('OVERLAY_FNS_JS', () => {
  it('defines working copies of the renderer\'s functions in a page that has nothing else', () => {
    const page: { __operatorOverlayFns?: Fns } = {}
    new Function('window', OVERLAY_FNS_JS)(page)
    const fns = page.__operatorOverlayFns!
    const spec = { ...DEFAULT_GRID_SPEC, preset: 'custom' as const, maxWidth: 1200 }
    expect(fns.layoutGrid(spec, 1280)).toEqual(layoutGrid(spec, 1280))
    const a = { left: 0, top: 0, right: 100, bottom: 50 }
    const b = { left: 130, top: 80, right: 200, bottom: 120 }
    expect(fns.measureBetween(a, b)).toEqual(measureBetween(a, b))
    expect(fns.formatPx(12.5)).toBe(formatPx(12.5))
    const seg = { x1: 0, y1: 2, x2: 40, y2: 2, value: 40 }
    expect(fns.placeChip(seg, 30, 14, 800, 600)).toEqual(placeChip(seg, 30, 14, 800, 600))
  })
})
