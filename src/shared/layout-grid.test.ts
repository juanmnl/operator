import { describe, it, expect } from 'vitest'
import {
  layoutGrid, applyGridPreset, editGridField, parseGridField, stepGridField, coerceGridSpec, formatColumnWidth,
  DEFAULT_GRID_SPEC, GRID_PRESETS, GRID_SWATCHES, gridInk, parseGridColor, withGridColor, withGridFill, type GridSpec,
} from './layout-grid'

const spec = (over: Partial<GridSpec>): GridSpec => ({ ...DEFAULT_GRID_SPEC, ...over })

describe('layoutGrid — the design spec\'s worked example', () => {
  // Page 1280, max 1200, margin 32, gutter 24, 12 columns.
  const g = layoutGrid(spec({ preset: 'custom', columns: 12, gutter: 24, margin: 32, maxWidth: 1200 }), 1280)

  it('centres a 1200 container and insets the content by the margin', () => {
    expect(g.containerW).toBe(1200)
    expect(g.containerLeft).toBe(40)
    expect(g.x0).toBe(72)
    expect(g.contentW).toBe(1136)
    expect(g.clamped).toBe(true)
  })

  it('makes 72.67px columns', () => {
    expect(g.colW).toBeCloseTo(72.6667, 3)
    expect(formatColumnWidth(g.colW)).toBe('72.67px')
    expect(g.cols).toHaveLength(12)
    expect(g.cols[0].left).toBe(72)
  })

  it('three cards spanning four columns each are (1136 − 2 × 24) / 3 wide', () => {
    const span = (from: number, to: number) => g.cols[to].left + g.cols[to].width - g.cols[from].left
    expect(span(0, 3)).toBeCloseTo((1136 - 48) / 3, 6)
    expect(span(4, 7)).toBeCloseTo(362.6667, 3)
    // The last column ends exactly on the content's right edge.
    expect(g.cols[11].left + g.cols[11].width).toBeCloseTo(72 + 1136, 6)
  })
})

describe('layoutGrid', () => {
  it('draws nothing when the columns do not fit', () => {
    const g = layoutGrid(spec({ preset: 'custom', columns: 12, gutter: 24, margin: 32 }), 300)
    expect(g.colW).toBeLessThanOrEqual(0)
    expect(g.cols).toEqual([])
  })

  it('draws nothing on an unmeasured page', () => {
    expect(layoutGrid(DEFAULT_GRID_SPEC, 0).cols).toEqual([])
  })

  it('uses the whole page and no edges without a max width, or with one wider than the page', () => {
    for (const maxWidth of [null, 2000]) {
      const g = layoutGrid(spec({ preset: '12', ...GRID_PRESETS['12'], maxWidth }), 1280)
      expect(g.containerW).toBe(1280)
      expect(g.containerLeft).toBe(0)
      expect(g.clamped).toBe(false)
    }
  })

  it('Auto follows the page width: 4 below 600, 8 from 600, 12 from 840', () => {
    const cols = (w: number) => layoutGrid(DEFAULT_GRID_SPEC, w).autoColumns
    expect(cols(375)).toBe(4)
    expect(cols(599)).toBe(4)
    expect(cols(600)).toBe(8)
    expect(cols(768)).toBe(8)
    expect(cols(839)).toBe(8)
    expect(cols(840)).toBe(12)
    expect(cols(1280)).toBe(12)
  })

  it('Auto\'s tiers use the same values as the fixed presets', () => {
    for (const [w, p] of [[375, '4'], [768, '8'], [1280, '12']] as const) {
      const g = layoutGrid(DEFAULT_GRID_SPEC, w)
      expect({ columns: g.columns, gutter: g.gutter, margin: g.margin }).toEqual(GRID_PRESETS[p])
    }
  })

  it('Auto keeps a max width', () => {
    const g = layoutGrid(spec({ preset: 'auto', maxWidth: 1000 }), 1280)
    expect(g.containerW).toBe(1000)
    expect(g.autoColumns).toBe(12)
  })

  it('reports autoColumns only for Auto', () => {
    expect(layoutGrid(spec({ preset: '8', ...GRID_PRESETS['8'] }), 1280).autoColumns).toBeNull()
  })

  it('still works as a stringified function, for the script injected into the page', () => {
    const injected = new Function(`return (${String(layoutGrid)})`)() as typeof layoutGrid
    const s = spec({ preset: 'custom', columns: 12, gutter: 24, margin: 32, maxWidth: 1200 })
    expect(injected(s, 1280)).toEqual(layoutGrid(s, 1280))
    expect(injected(DEFAULT_GRID_SPEC, 768)).toEqual(layoutGrid(DEFAULT_GRID_SPEC, 768))
  })
})

describe('presets and edits', () => {
  it('a fixed preset overwrites the fields and keeps the max width', () => {
    expect(applyGridPreset(spec({ preset: 'custom', columns: 5, gutter: 1, margin: 2, maxWidth: 1100 }), '8'))
      .toEqual({ preset: '8', columns: 8, gutter: 24, margin: 32, maxWidth: 1100 })
  })

  it('Auto keeps the fields as they were', () => {
    const s = spec({ preset: 'custom', columns: 5, gutter: 1, margin: 2 })
    expect(applyGridPreset(s, 'auto')).toEqual({ ...s, preset: 'auto' })
  })

  it('editing a field of an Auto grid goes Custom from the values Auto resolved on this page', () => {
    expect(editGridField(DEFAULT_GRID_SPEC, 768, 'gutter', 20))
      .toEqual({ preset: 'custom', columns: 8, gutter: 20, margin: 32, maxWidth: null })
  })

  it('editing max width keeps the preset', () => {
    expect(editGridField(DEFAULT_GRID_SPEC, 768, 'maxWidth', 1200)).toEqual({ ...DEFAULT_GRID_SPEC, maxWidth: 1200 })
    expect(editGridField(spec({ maxWidth: 1200 }), 768, 'maxWidth', null).maxWidth).toBeNull()
  })

  it('parses whole px within each field\'s range and rejects the rest', () => {
    expect(parseGridField('columns', '12')).toBe(12)
    expect(parseGridField('columns', '0')).toBeUndefined()
    expect(parseGridField('columns', '25')).toBeUndefined()
    expect(parseGridField('columns', '')).toBeUndefined()
    expect(parseGridField('gutter', '200')).toBe(200)
    expect(parseGridField('gutter', '201')).toBeUndefined()
    expect(parseGridField('margin', '12.5')).toBeUndefined()
    expect(parseGridField('margin', 'abc')).toBeUndefined()
    expect(parseGridField('maxWidth', '')).toBeNull()
    expect(parseGridField('maxWidth', ' 1200 ')).toBe(1200)
    expect(parseGridField('maxWidth', '239')).toBeUndefined()
  })

  it('steps by the given delta within the range', () => {
    expect(stepGridField('columns', 24, 1)).toBe(24)
    expect(stepGridField('columns', 12, -8)).toBe(4)
    expect(stepGridField('gutter', 3, -8)).toBe(0)
    expect(stepGridField('maxWidth', 240, -1)).toBe(240)
    expect(stepGridField('maxWidth', null, 8)).toBeNull()
  })
})

describe('coerceGridSpec', () => {
  it('passes a valid spec, and reads a missing max width as none', () => {
    expect(coerceGridSpec({ preset: '12', columns: 12, gutter: 24, margin: 32, maxWidth: 1200 }))
      .toEqual({ preset: '12', columns: 12, gutter: 24, margin: 32, maxWidth: 1200 })
    expect(coerceGridSpec({ preset: 'auto', columns: 12, gutter: 24, margin: 32 })?.maxWidth).toBeNull()
  })

  it('reads anything else as absent', () => {
    expect(coerceGridSpec(undefined)).toBeUndefined()
    expect(coerceGridSpec('12')).toBeUndefined()
    expect(coerceGridSpec({ preset: '16', columns: 12, gutter: 24, margin: 32 })).toBeUndefined()
    expect(coerceGridSpec({ preset: 'custom', columns: 0, gutter: 24, margin: 32 })).toBeUndefined()
    expect(coerceGridSpec({ preset: 'custom', columns: 12, gutter: '24', margin: 32 })).toBeUndefined()
    expect(coerceGridSpec({ preset: 'custom', columns: 12, gutter: 24, margin: 32, maxWidth: 100 })).toBeUndefined()
  })
})

describe('grid colour and fill — persistence and old projects.json entries', () => {
  // What a build before this change wrote into `Project.previewGrid`.
  const OLD = { preset: '12', columns: 12, gutter: 24, margin: 32, maxWidth: 1200 }
  /** projects.json is plain JSON through a pass-through store, so a save and a load is this. */
  const roundTrip = (s: GridSpec) => coerceGridSpec(JSON.parse(JSON.stringify(s)))

  it('reads an entry with no colour and no fill exactly as before, drawn in the theme colour at 10%', () => {
    const s = coerceGridSpec(OLD)!
    expect(s).toEqual(OLD)
    expect('color' in s).toBe(false)
    expect('fill' in s).toBe(false)
    expect(gridInk(s, 'var(--grid)')).toEqual({
      fill: 'color-mix(in srgb, var(--grid) 10%, transparent)',
      edge: 'color-mix(in srgb, var(--grid) 45%, transparent)',
    })
  })

  it('saves and loads a colour and a fill', () => {
    const s = withGridFill(withGridColor(coerceGridSpec(OLD)!, '#3e63dd'), 30)
    expect(roundTrip(s)).toEqual({ ...OLD, color: '#3e63dd', fill: 30 })
  })

  it('stores the defaults as absent, so choosing Theme and 10% writes what an old build wrote', () => {
    const s = withGridFill(withGridColor(withGridFill(withGridColor(coerceGridSpec(OLD)!, '#16a34a'), 20), undefined), 10)
    expect(s).toEqual(OLD)
    expect(JSON.stringify(s)).toBe(JSON.stringify(OLD))
  })

  it('drops a bad colour or fill alone and keeps the columns', () => {
    expect(coerceGridSpec({ ...OLD, color: 'red' })).toEqual(OLD)
    expect(coerceGridSpec({ ...OLD, color: '#12345' })).toEqual(OLD)
    expect(coerceGridSpec({ ...OLD, color: 'url(x);background:red' })).toEqual(OLD)
    expect(coerceGridSpec({ ...OLD, fill: 50 })).toEqual(OLD)
    expect(coerceGridSpec({ ...OLD, fill: '20' })).toEqual(OLD)
    // A hand-written short or uppercase hex is normalised.
    expect(coerceGridSpec({ ...OLD, color: '#0AF' })?.color).toBe('#00aaff')
  })

  it('keeps the colour and fill through preset changes and field edits', () => {
    const s = { ...DEFAULT_GRID_SPEC, color: '#d6409f', fill: 20 as const }
    expect(applyGridPreset(s, '8')).toMatchObject({ color: '#d6409f', fill: 20 })
    expect(applyGridPreset(s, 'auto')).toMatchObject({ color: '#d6409f', fill: 20 })
    expect(editGridField(s, 768, 'gutter', 12)).toMatchObject({ preset: 'custom', gutter: 12, color: '#d6409f', fill: 20 })
    expect(editGridField(s, 768, 'maxWidth', 1000)).toMatchObject({ color: '#d6409f', fill: 20 })
  })

  it('parses hex the way the field accepts it', () => {
    expect(parseGridColor('#F0283C')).toBe('#f0283c')
    expect(parseGridColor(' 3e63dd ')).toBe('#3e63dd')
    expect(parseGridColor('#abc')).toBe('#aabbcc')
    expect(parseGridColor('')).toBeUndefined()
    expect(parseGridColor('blue')).toBeUndefined()
    expect(parseGridColor('#3e63dd80')).toBeUndefined()
  })

  it('steps the edge up with the fill, and ignores a colour that is not stored hex', () => {
    const at = (fill: 10 | 20 | 30) => gridInk({ ...DEFAULT_GRID_SPEC, color: '#0797b9', fill }, '#ff5f56')
    expect(at(20)).toEqual({ fill: 'color-mix(in srgb, #0797b9 20%, transparent)', edge: 'color-mix(in srgb, #0797b9 60%, transparent)' })
    expect(at(30).edge).toBe('color-mix(in srgb, #0797b9 75%, transparent)')
    expect(gridInk({ ...DEFAULT_GRID_SPEC, color: 'red' }, '#ff5f56').fill).toBe('color-mix(in srgb, #ff5f56 10%, transparent)')
  })

  it('works as a stringified function, for the script injected into the page', () => {
    const injected = new Function(`return (${String(gridInk)})`)() as typeof gridInk
    const s = { ...DEFAULT_GRID_SPEC, color: '#3e63dd', fill: 30 as const }
    expect(injected(s, '#ff5f56')).toEqual(gridInk(s, '#ff5f56'))
  })

  it('offers swatches that hold 3:1 against both a white and a black page at full strength', () => {
    const lum = (hex: string) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
    }
    for (const { color } of GRID_SWATCHES) {
      const l = lum(color)
      expect(1.05 / (l + 0.05)).toBeGreaterThanOrEqual(3)
      expect((l + 0.05) / 0.05).toBeGreaterThanOrEqual(3)
      expect(parseGridColor(color)).toBe(color)
    }
  })
})
