import { describe, it, expect } from 'vitest'
import { toolbarTier, originChipLabel, scaleReadout, pointerMode, ONE_ROW_MIN_W, TWO_ROW_MIN_W } from './preview-toolbar'

describe('toolbarTier', () => {
  it('one row from 880, two rows from 520, narrow below', () => {
    expect(toolbarTier(1400)).toBe('one')
    expect(toolbarTier(ONE_ROW_MIN_W)).toBe('one')
    expect(toolbarTier(ONE_ROW_MIN_W - 1)).toBe('two')
    expect(toolbarTier(TWO_ROW_MIN_W)).toBe('two')
    expect(toolbarTier(TWO_ROW_MIN_W - 1)).toBe('narrow')
    expect(toolbarTier(360)).toBe('narrow')
  })
})

describe('originChipLabel', () => {
  it('keeps localhost at one and two rows', () => {
    expect(originChipLabel(null, 5173, 'one')).toBe('localhost:5173')
    expect(originChipLabel(undefined, 5173, 'two')).toBe('localhost:5173')
  })

  it('drops localhost but never the port when narrow', () => {
    expect(originChipLabel(null, 5173, 'narrow')).toBe(':5173')
  })

  it('shows an external target\'s host at every tier', () => {
    expect(originChipLabel('https://example.com/pricing', 5173, 'narrow')).toBe('example.com')
    expect(originChipLabel('not a url', null, 'one')).toBe('not a url')
  })

  it('says so when there is no server', () => {
    expect(originChipLabel(null, null, 'narrow')).toBe('no server')
  })
})

describe('scaleReadout', () => {
  it('reads preset and scale when the preset is wider than the stage', () => {
    expect(scaleReadout(768, 476)).toBe('768 · 62%')
    expect(scaleReadout(1280, 640)).toBe('1280 · 50%')
  })

  it('is absent for Fit, a preset that fits, and an unmeasured stage', () => {
    expect(scaleReadout('fit', 400)).toBeNull()
    expect(scaleReadout(375, 400)).toBeNull()
    expect(scaleReadout(375, 375)).toBeNull()
    expect(scaleReadout(1280, 0)).toBeNull()
  })
})

describe('pointerMode', () => {
  it('spells exactly one mode', () => {
    expect(pointerMode(false, false)).toBe('interact')
    expect(pointerMode(true, false)).toBe('annotate')
    expect(pointerMode(false, true)).toBe('inspect')
  })

  it('Annotate wins if both flags are briefly on', () => {
    expect(pointerMode(true, true)).toBe('annotate')
  })
})
