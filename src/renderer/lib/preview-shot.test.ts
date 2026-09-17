import { describe, it, expect } from 'vitest'
import { annotationTargets, pickTargets, pickShotRequest, pageToStage, withScreenshot, shotProject, parseRgb, PIN_MARK, PIN_MARGIN } from './preview-shot'
import { composeMessage, shotPaths, type Annotation } from './annotations'

const stage = { left: 300, top: 80, width: 400, height: 800 }

describe('annotationTargets', () => {
  it('turns a box note’s page percentages into window px on the stage', () => {
    expect(annotationTargets({ xPct: 10, yPct: 50, wPct: 25, hPct: 5 }, stage)).toEqual({ targets: [{ x: 340, y: 480, w: 100, h: 40 }] })
  })

  it('gives a point pin a small mark and a wide margin', () => {
    const t = annotationTargets({ xPct: 50, yPct: 50 }, stage)
    expect(t.targets).toEqual([{ x: 500 - PIN_MARK / 2, y: 480 - PIN_MARK / 2, w: PIN_MARK, h: PIN_MARK }])
    expect(t.margin).toBe(PIN_MARGIN)
  })
})

describe('Inspect picks', () => {
  it('outlines the element, and the anchor too for a measurement note', () => {
    const box = { x: 10, y: 20, w: 30, h: 40 }
    const anchorBox = { x: 10, y: 80, w: 30, h: 10 }
    expect(pickTargets({ box })).toEqual([box])
    expect(pickTargets({ box, anchorBox, measurement: '16px below Header' })).toEqual([box, anchorBox])
  })

  // The page is the stage's iframe (there is no inspect view since 2026-09-17), so a pick is captured
  // from the main window like an Annotate note: its page box maps to window px through the stage.
  const stage = { left: 300, top: 90, width: 640, height: 480 }

  it('maps a page box to window px: the stage origin plus the box times the iframe scale', () => {
    expect(pageToStage({ x: 100, y: 40, w: 200, h: 10 }, stage, 0.5)).toEqual({ x: 350, y: 110, w: 100, h: 5 })
    // Fit, or a preset that fits: scale 1, just the offset.
    expect(pageToStage({ x: 100, y: 40, w: 200, h: 10 }, stage, 1)).toEqual({ x: 400, y: 130, w: 200, h: 10 })
    // A pick from an inspector that sends no scale, or a nonsense one, is unscaled.
    expect(pageToStage({ x: 1, y: 2, w: 3, h: 4 }, stage, undefined)).toEqual({ x: 301, y: 92, w: 3, h: 4 })
    expect(pageToStage({ x: 1, y: 2, w: 3, h: 4 }, stage, 0)).toEqual({ x: 301, y: 92, w: 3, h: 4 })
  })

  it('builds a window capture clipped to the stage, hiding the in-page outline, or none without a box', () => {
    expect(pickShotRequest({ box: { x: 1, y: 2, w: 3, h: 4 }, scale: 0.5 }, 'p', 'pick-1', stage)).toEqual({
      source: 'window', project: 'p', id: 'pick-1', targets: [{ x: 300.5, y: 91, w: 1.5, h: 2 }],
      clip: { x: 300, y: 90, w: 640, h: 480 }, outline: undefined, hideInspector: true,
    })
    expect(pickShotRequest({ message: 'old inspector' }, 'p', 'pick-1', stage)).toBeNull()
  })

  it('maps both boxes of a measurement note', () => {
    const r = pickShotRequest({ box: { x: 10, y: 20, w: 30, h: 40 }, anchorBox: { x: 10, y: 80, w: 30, h: 10 }, scale: 1 }, 'p', 'pick-2', stage)
    expect(r?.targets).toEqual([{ x: 310, y: 110, w: 30, h: 40 }, { x: 310, y: 170, w: 30, h: 10 }])
  })
})

describe('the note text names its screenshot', () => {
  it('adds a Screenshot line only when there is one', () => {
    expect(withScreenshot('Fix this', '/s/a.png')).toBe('Fix this\n\nScreenshot: /s/a.png')
    expect(withScreenshot('Fix this', null)).toBe('Fix this')
  })

  it('composeMessage lists each annotation’s screenshot under it, and shotPaths collects them', () => {
    const a = (id: string, shot?: Annotation['shot']): Annotation => ({ id, xPct: 10, yPct: 10, note: `note ${id}`, route: '/', createdAt: '', shot })
    const anns = [a('1', { path: '/s/1.png', w: 10, h: 10 }), a('2')]
    const msg = composeMessage(anns, '/')
    expect(msg).toContain('1. [top-left · ~10%,10%] note 1\n   Screenshot: /s/1.png\n2.')
    expect(msg).not.toContain('Screenshot: undefined')
    expect(shotPaths(anns)).toEqual(['/s/1.png'])
  })

  it('a lane with no project still gets a folder', () => {
    expect(shotProject(null)).toBe('no-project')
    expect(shotProject('abc')).toBe('abc')
  })
})

describe('parseRgb', () => {
  it('reads rgb(), rgba() and hex', () => {
    expect(parseRgb('rgb(47, 227, 154)')).toEqual({ r: 47, g: 227, b: 154 })
    expect(parseRgb('rgba(1, 2, 3, 0.5)')).toEqual({ r: 1, g: 2, b: 3 })
    expect(parseRgb('#2fe39a')).toEqual({ r: 47, g: 227, b: 154 })
    expect(parseRgb('color(srgb 1 1 1)')).toBeUndefined()
  })
})
