import { describe, it, expect } from 'vitest'
import {
  screenshotPageSize, tileWindow, tilePlan, tileShift, screenshotPixels, tileOrigin, capturedDpr,
  fileStem, screenshotFileName, withSuffix, screenshotTooLarge, type Rect,
} from './preview-screenshot'

/** The panel's page box for a preset, as AppPreviewPanel derives it: `preset` wide, and the panel's
 *  height over the scale that fits `preset` into the panel's width. */
function pageBoxFor(preset: number, box: { w: number; h: number }) {
  const scale = Math.min(1, box.w / preset)
  return { scale, page: { w: preset, h: box.h / scale } }
}

describe('screenshotPageSize — the image is the preset size, not the scaled stage', () => {
  it('a preset scaled down to fit is captured at the preset, with the height the page has', () => {
    const { scale, page } = pageBoxFor(1280, { w: 500, h: 700 })
    expect(scale).toBeCloseTo(0.390625)
    expect(screenshotPageSize(page)).toEqual({ w: 1280, h: 1792 })
  })

  it('a preset narrower than the panel is not scaled: preset × panel height', () => {
    const { scale, page } = pageBoxFor(375, { w: 600, h: 812 })
    expect(scale).toBe(1)
    expect(screenshotPageSize(page)).toEqual({ w: 375, h: 812 })
  })

  it('a fractional page height rounds to whole CSS px', () => {
    const { page } = pageBoxFor(768, { w: 333, h: 701 })
    expect(page.h).toBeCloseTo(1616.7207, 3)
    expect(screenshotPageSize(page)).toEqual({ w: 768, h: 1617 })
  })

  it('never returns an empty size', () => {
    expect(screenshotPageSize({ w: 0, h: 0.2 })).toEqual({ w: 1, h: 1 })
  })
})

describe('screenshotPixels — CSS size times the display ratio', () => {
  it('390×844 at 2x is 780×1688, and at 1x is 390×844', () => {
    expect(screenshotPixels({ w: 390, h: 844 }, 2)).toEqual({ w: 780, h: 1688 })
    expect(screenshotPixels({ w: 390, h: 844 }, 1)).toEqual({ w: 390, h: 844 })
  })

  it('a fractional ratio rounds; a bad ratio counts as 1', () => {
    expect(screenshotPixels({ w: 375, h: 667 }, 1.5)).toEqual({ w: 563, h: 1001 })
    expect(screenshotPixels({ w: 375, h: 667 }, 0)).toEqual({ w: 375, h: 667 })
  })

  it('does not depend on the stage scale: the scaled and unscaled captures of one page agree', () => {
    const scaled = pageBoxFor(1280, { w: 500, h: 700 })
    const wide = pageBoxFor(1280, { w: 1400, h: 1792 })
    expect(screenshotPixels(screenshotPageSize(scaled.page), 2)).toEqual(screenshotPixels(screenshotPageSize(wide.page), 2))
  })

  it('capturedDpr is the capture\'s pixel width over the CSS width asked for', () => {
    expect(capturedDpr(1000, 500)).toBe(2)
    expect(capturedDpr(500, 500)).toBe(1)
    expect(capturedDpr(0, 500)).toBe(1)
    expect(capturedDpr(500, 0)).toBe(1)
  })
})

describe('tileWindow — the whole-px capture rect inside the stage', () => {
  const viewport = { w: 1440, h: 900 }

  it('a whole-px stage is itself', () => {
    expect(tileWindow({ left: 23, top: 57, width: 500, height: 700 }, viewport)).toEqual({ x: 23, y: 57, w: 500, h: 700 })
  })

  it('a stage on half pixels loses the half pixel on each side, never gains one', () => {
    expect(tileWindow({ left: 820.5, top: 96.25, width: 375, height: 700 }, viewport)).toEqual({ x: 821, y: 97, w: 374, h: 699 })
  })

  it('is clamped to the window, and null when nothing is left', () => {
    expect(tileWindow({ left: 1200, top: 600, width: 500, height: 700 }, viewport)).toEqual({ x: 1200, y: 600, w: 240, h: 300 })
    expect(tileWindow({ left: 1500, top: 0, width: 500, height: 700 }, viewport)).toBeNull()
    expect(tileWindow({ left: 10, top: 10, width: 0.6, height: 100 }, viewport)).toBeNull()
  })
})

describe('tilePlan — tiles cover the page exactly once', () => {
  /** Every page px is in exactly one tile. */
  function coverage(page: { w: number; h: number }, tiles: Rect[]) {
    const hits = new Uint8Array(page.w * page.h)
    for (const t of tiles) for (let y = t.y; y < t.y + t.h; y++) for (let x = t.x; x < t.x + t.w; x++) hits[y * page.w + x]++
    return { missed: hits.filter((n) => n === 0).length, twice: hits.filter((n) => n > 1).length }
  }

  it('a page that fits the window is one tile at the origin', () => {
    expect(tilePlan({ w: 375, h: 812 }, { w: 375, h: 812 })).toEqual([{ x: 0, y: 0, w: 375, h: 812 }])
    expect(tilePlan({ w: 375, h: 812 }, { w: 600, h: 900 })).toEqual([{ x: 0, y: 0, w: 375, h: 812 }])
  })

  it('1280×1792 through a 500×700 stage is 3×3 tiles, the last row and column trimmed', () => {
    const tiles = tilePlan({ w: 1280, h: 1792 }, { w: 500, h: 700 })
    expect(tiles).toHaveLength(9)
    expect(tiles[2]).toEqual({ x: 1000, y: 0, w: 280, h: 700 })
    expect(tiles[8]).toEqual({ x: 1000, y: 1400, w: 280, h: 392 })
    expect(coverage({ w: 1280, h: 1792 }, tiles)).toEqual({ missed: 0, twice: 0 })
  })

  it('covers an odd page through an odd window', () => {
    const page = { w: 777, h: 1033 }
    expect(coverage(page, tilePlan(page, { w: 374, h: 299 }))).toEqual({ missed: 0, twice: 0 })
  })

  it('an empty page or window plans nothing', () => {
    expect(tilePlan({ w: 0, h: 100 }, { w: 10, h: 10 })).toEqual([])
    expect(tilePlan({ w: 100, h: 100 }, { w: 0, h: 10 })).toEqual([])
  })
})

describe('tileShift — the tile lands on the capture window', () => {
  it('moves the iframe so the tile\'s page origin is at the window origin', () => {
    const stage = { left: 23, top: 57 }
    const win = { x: 23, y: 57, w: 500, h: 700 }
    expect(tileShift(stage, win, { x: 0, y: 0, w: 500, h: 700 })).toEqual({ x: 0, y: 0 })
    expect(tileShift(stage, win, { x: 1000, y: 1400, w: 280, h: 392 })).toEqual({ x: -1000, y: -1400 })
  })

  it('takes up a fractional stage offset, so page px sit on whole window px', () => {
    const stage = { left: 820.5, top: 96.25 }
    const win = tileWindow({ ...stage, width: 375, height: 700 }, { w: 1440, h: 900 })!
    const s = tileShift(stage, win, { x: 374, y: 0, w: 1, h: 699 })
    // The iframe's origin plus the shift plus the tile's page x is the window's x.
    expect(stage.left + s.x + 374).toBe(win.x)
    expect(stage.top + s.y).toBe(win.y)
  })

  it('tileOrigin places a tile in the stitched image at the ratio', () => {
    expect(tileOrigin({ x: 1000, y: 1400, w: 280, h: 392 }, 2)).toEqual({ x: 2000, y: 2800 })
    expect(tileOrigin({ x: 375, y: 0, w: 1, h: 1 }, 1.5)).toEqual({ x: 563, y: 0 })
  })
})

describe('the file name', () => {
  const at = new Date(2026, 9, 7, 9, 5, 3)

  it('is <project>-<W>x<H>-<YYYYMMDD-HHMMSS>.png in local time', () => {
    expect(screenshotFileName('operator', { w: 390, h: 844 }, at)).toBe('operator-390x844-20261007-090503.png')
  })

  it('a project name is made safe for a file name', () => {
    expect(fileStem('My App')).toBe('My-App')
    expect(fileStem('../etc/passwd')).toBe('etcpasswd')
    expect(fileStem('café: menú')).toBe('caf-men')
    expect(fileStem('')).toBe('preview')
    expect(fileStem(null)).toBe('preview')
  })

  it('a second capture in the same second gets a suffix', () => {
    expect(withSuffix('a-1x1-20261007-090503.png', 1)).toBe('a-1x1-20261007-090503.png')
    expect(withSuffix('a-1x1-20261007-090503.png', 2)).toBe('a-1x1-20261007-090503-2.png')
  })
})

describe('screenshotTooLarge — the image has a ceiling', () => {
  it('1280×1792 at 2x is within it', () => {
    expect(screenshotTooLarge(screenshotPixels({ w: 1280, h: 1792 }, 2))).toBeNull()
  })

  it('refuses a long side past 16384 px', () => {
    expect(screenshotTooLarge({ w: 1000, h: 16385 })).toMatch(/16384 px limit on a side/)
  })

  it('1280 in a tall 300 px panel at 2x is within it', () => {
    const page = screenshotPageSize({ w: 1280, h: 1000 / (300 / 1280) })
    expect(screenshotTooLarge(screenshotPixels(page, 2))).toBeNull()
  })

  it('refuses more than 128 MB of pixels', () => {
    expect(screenshotTooLarge({ w: 2560, h: 13200 })).toMatch(/^The image would be 2560×13200 px \(129 MB\), over the 128 MB limit\. Use\u00a0a/)
  })
})
