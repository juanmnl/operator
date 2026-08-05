import { describe, it, expect } from 'vitest'
import { zoneLabel, composeMessage, migrateAnnotations, ANNOTATION_GEOM_VERSION, type Annotation } from './annotations'

describe('zoneLabel', () => {
  it('maps corners and center', () => {
    expect(zoneLabel(10, 10)).toBe('top-left')
    expect(zoneLabel(90, 90)).toBe('bottom-right')
    expect(zoneLabel(50, 50)).toBe('center')
    expect(zoneLabel(50, 10)).toBe('top')
    expect(zoneLabel(10, 50)).toBe('left')
  })
})

describe('composeMessage', () => {
  const pin: Annotation = { id: '1', xPct: 12, yPct: 20, note: 'Button clipped', route: '/login', createdAt: '' }
  const box: Annotation = { id: '2', xPct: 40, yPct: 40, wPct: 20, hPct: 10, note: 'Too tight', route: '/login', createdAt: '' }

  it('returns empty for no annotations', () => {
    expect(composeMessage([], '/login')).toBe('')
  })

  it('lists notes with location hints + route + viewport', () => {
    const msg = composeMessage([pin, box], '/login', { w: 1280, h: 800 })
    expect(msg).toContain('UI feedback on /login (viewport 1280×800):')
    expect(msg).toContain('1. [top-left · ~12%,20%] Button clipped')
    expect(msg).toContain('region] Too tight')
    expect(msg).toMatch(/address it\.$/)
  })

  it('falls back to (no note) and default route', () => {
    const bare: Annotation = { id: '3', xPct: 5, yPct: 5, note: '   ', route: '', createdAt: '' }
    const msg = composeMessage([bare], '')
    expect(msg).toContain('UI feedback on /:')
    expect(msg).toContain('(no note)')
  })

  it('uses the annotation full URL + device + pixel coords when captured', () => {
    const rich: Annotation = {
      id: '4', xPct: 40, yPct: 40, wPct: 20, hPct: 10, note: 'Overlaps logo',
      route: '/dashboard', url: 'http://localhost:5173/dashboard?tab=settings',
      viewport: { w: 375, h: 720 }, device: '375px', createdAt: '',
    }
    const msg = composeMessage([rich], '/dashboard')
    // Full URL (not just the pathname) + device + viewport in the header.
    expect(msg).toContain('UI feedback on http://localhost:5173/dashboard?tab=settings (375px · viewport 375×720):')
    // Percentage geometry resolved to concrete pixels (20%×10% of 375×720 = 75×72).
    expect(msg).toContain('region · ≈ 75×72px] Overlaps logo')
  })
})

// The panel used to draw pins as a percentage of the whole preview PANEL, which is only the same
// as "of the page" while the frame fills it. At a preset narrower than the panel it does not, so
// every note taken at 375 or 768 was stored against a box wider than the page it was about.
describe('migrateAnnotations', () => {
  /** A note taken at 375 in a 1000px-wide panel, pinned 25% across the PAGE — which the old code
   *  stored as 93.75px / 1000 = 9.375% of the panel. */
  const v1Narrow: Annotation = {
    id: 'n', xPct: 9.375, yPct: 40, note: 'clipped', route: '/',
    viewport: { w: 1000, h: 800 }, device: '375px', createdAt: '',
  }

  it('NARROW preset: re-bases x onto the page and restates the viewport in page pixels', () => {
    const [a] = migrateAnnotations([v1Narrow])
    expect(a.xPct).toBeCloseTo(25, 6)
    // Only the horizontal axis moved — the frame was always full-height.
    expect(a.yPct).toBe(40)
    expect(a.viewport).toEqual({ w: 375, h: 800 })
    expect(a.v).toBe(ANNOTATION_GEOM_VERSION)
  })

  it('re-bases a BOX’s width by the same factor, leaving its height', () => {
    const box: Annotation = { ...v1Narrow, id: 'b', wPct: 7.5, hPct: 20 }
    const [a] = migrateAnnotations([box])
    // 7.5% of 1000 = 75px = 20% of the 375px page.
    expect(a.wPct).toBeCloseTo(20, 6)
    expect(a.hPct).toBe(20)
  })

  it('WIDE preset: geometry is untouched — the page filled the panel, so it never drifted', () => {
    const wide: Annotation = {
      id: 'w', xPct: 30, yPct: 50, note: '', route: '',
      viewport: { w: 900, h: 700 }, device: '1280px', createdAt: '',
    }
    const [a] = migrateAnnotations([wide])
    expect(a.xPct).toBe(30)
    expect(a.yPct).toBe(50)
    // …but the viewport is restated as the PAGE's box: 1280 wide, and as tall as the panel
    // divided by the scale that fit it (700 × 1280/900).
    expect(a.viewport!.w).toBe(1280)
    expect(a.viewport!.h).toBeCloseTo(700 * 1280 / 900, 6)
  })

  it('Fit is left alone — wrapper and page were the same box', () => {
    const fit: Annotation = {
      id: 'f', xPct: 60, yPct: 20, note: '', route: '',
      viewport: { w: 1000, h: 800 }, device: 'Fit', createdAt: '',
    }
    const [a] = migrateAnnotations([fit])
    expect(a.xPct).toBe(60)
    expect(a.viewport).toEqual({ w: 1000, h: 800 })
    expect(a.v).toBe(ANNOTATION_GEOM_VERSION)
  })

  it('a bare note (no device/viewport) is stamped but not moved — nothing to rebase from', () => {
    const bare: Annotation = { id: 'x', xPct: 12, yPct: 20, note: '', route: '', createdAt: '' }
    const [a] = migrateAnnotations([bare])
    expect(a.xPct).toBe(12)
    expect(a.viewport).toBeUndefined()
    // Stamped anyway, so it is not re-examined and re-written on every load.
    expect(a.v).toBe(ANNOTATION_GEOM_VERSION)
  })

  it('IS IDEMPOTENT — a second pass returns the very same array, not a second rebase', () => {
    const once = migrateAnnotations([v1Narrow])
    const twice = migrateAnnotations(once)
    // Same reference: nothing changed, so `loadAnnotations` writes nothing back.
    expect(twice).toBe(once)
    expect(twice[0].xPct).toBeCloseTo(25, 6)
  })

  it('returns the SAME array when every note is already current', () => {
    const list = [{ ...v1Narrow, v: ANNOTATION_GEOM_VERSION }]
    expect(migrateAnnotations(list)).toBe(list)
  })

  it('a pin left in the GUTTER keeps its position and lands past 100% — never clamped onto the page', () => {
    // 60% of a 1000px panel = 600px, well right of a 375px page.
    const gutter: Annotation = { ...v1Narrow, id: 'g', xPct: 60 }
    const [a] = migrateAnnotations([gutter])
    expect(a.xPct).toBeCloseTo(160, 6)
  })

  it('migrated pixel hints read against the page, not the panel', () => {
    const [a] = migrateAnnotations([{ ...v1Narrow, note: 'clipped' }])
    // 25% of the 375px page = 94px across, 40% of 800 = 320px down.
    expect(composeMessage([a], '/')).toContain('≈ 94,320px')
  })
})
