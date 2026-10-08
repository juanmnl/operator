import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import {
  deliverScreenshot, dipRect, freePath, pageDrawingVisibilityJs, saveErrorReason, stitchTiles, tileOffset,
  OPERATOR_PAGE_DRAWING, type Tile,
} from './preview-screenshot'
import { tilePlan, tileShift, tileWindow } from '../../../src/shared/preview-screenshot'

/** A solid BGRA tile. */
function solid(at: Tile['at'], dpr: number, bgra: [number, number, number, number]): Tile {
  const width = Math.round(at.w * dpr), height = Math.round(at.h * dpr)
  const bitmap = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i++) bitmap.set(bgra, i * 4)
  return { at, width, height, bitmap }
}

const px = (img: { width: number; bitmap: Buffer }, x: number, y: number) => [...img.bitmap.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)]

describe('stitchTiles', () => {
  it('puts each tile at its page position times the ratio, and the image is the page at the ratio', () => {
    const red: [number, number, number, number] = [0, 0, 255, 255]
    const blue: [number, number, number, number] = [255, 0, 0, 255]
    const page = { w: 7, h: 3 }
    const tiles = [solid({ x: 0, y: 0, w: 4, h: 3 }, 2, red), solid({ x: 4, y: 0, w: 3, h: 3 }, 2, blue)]
    const img = stitchTiles(tiles, page, 2)
    expect([img.width, img.height]).toEqual([14, 6])
    expect(px(img, 0, 0)).toEqual(red)
    expect(px(img, 7, 5)).toEqual(red)
    expect(px(img, 8, 0)).toEqual(blue)
    expect(px(img, 13, 5)).toEqual(blue)
  })

  it('clips a tile that runs past the image instead of writing out of bounds', () => {
    const white: [number, number, number, number] = [255, 255, 255, 255]
    const tile = solid({ x: 0, y: 0, w: 5, h: 5 }, 1, white)
    const img = stitchTiles([tile], { w: 3, h: 2 }, 1)
    expect([img.width, img.height]).toEqual([3, 2])
    expect(px(img, 2, 1)).toEqual(white)
  })

  it('a missing tile leaves its pixels clear rather than failing', () => {
    const img = stitchTiles([], { w: 2, h: 2 }, 1)
    expect(px(img, 1, 1)).toEqual([0, 0, 0, 0])
  })
})

describe('pageDrawingVisibilityJs', () => {
  it('names every element Operator draws in a page', () => {
    for (const sel of ['[data-operator-overlay]', '[data-operator-edit]', '[data-operator-inspector]', '#__op_compose']) {
      expect(OPERATOR_PAGE_DRAWING).toContain(sel)
    }
  })

  /** A page stand-in: one existing element, and a MutationObserver the test can fire. */
  function fakePage() {
    const calls: string[] = []
    const mkEl = (name: string) => {
      const props = new Map<string, [string, string]>()
      return {
        name,
        nodeType: 1,
        matches: () => true,
        querySelectorAll: () => [],
        style: {
          getPropertyValue: (p: string) => props.get(p)?.[0] ?? '',
          getPropertyPriority: (p: string) => props.get(p)?.[1] ?? '',
          setProperty: (p: string, v: string, pr: string) => { props.set(p, [v, pr]); calls.push(`set ${name} ${p} ${v} ${pr}`) },
          removeProperty: (p: string) => { props.delete(p); calls.push(`remove ${name} ${p}`) },
        },
      }
    }
    const el = mkEl('old')
    const observers: { cb: (r: unknown[]) => void; on: boolean }[] = []
    class MutationObserver {
      o: { cb: (r: unknown[]) => void; on: boolean }
      constructor(cb: (r: unknown[]) => void) { this.o = { cb, on: false }; observers.push(this.o) }
      observe() { this.o.on = true; calls.push('observe') }
      disconnect() { this.o.on = false; calls.push('disconnect') }
    }
    const document = { documentElement: {}, querySelectorAll: (sel: string) => { calls.push(`query ${sel}`); return [el] } }
    const window: Record<string, unknown> = {}
    const run = (hidden: boolean) => new Function('document', 'window', 'MutationObserver', pageDrawingVisibilityJs(hidden))(document, window, MutationObserver)
    const fire = (records: unknown[]) => observers.filter((o) => o.on).forEach((o) => o.cb(records))
    return { calls, run, fire, mkEl }
  }

  it('hides with an inline !important and shows by removing it, removing nothing else', () => {
    const page = fakePage()
    page.run(true)
    page.run(false)
    expect(page.calls).toEqual([
      `query ${OPERATOR_PAGE_DRAWING}`, 'set old visibility hidden important', 'observe',
      'disconnect', `query ${OPERATOR_PAGE_DRAWING}`, 'remove old visibility',
    ])
  })

  it('hides an element of Operator\'s added during the capture, and a style rewrite of one', () => {
    const page = fakePage()
    page.run(true)
    const card = page.mkEl('card')
    page.fire([{ type: 'childList', addedNodes: [card] }])
    expect(card.style.getPropertyValue('visibility')).toBe('hidden')
    // The inspector's paint() rewrites cssText, which drops the visibility.
    card.style.removeProperty('visibility')
    page.fire([{ type: 'attributes', target: card }])
    expect(card.style.getPropertyPriority('visibility')).toBe('important')
    // Already hidden: no second write, so the observer does not feed itself.
    const n = page.calls.length
    page.fire([{ type: 'attributes', target: card }])
    expect(page.calls.length).toBe(n)
    // Shown again: the watch stops.
    page.run(false)
    const added = page.mkEl('late')
    page.fire([{ type: 'childList', addedNodes: [added] }])
    expect(added.style.getPropertyValue('visibility')).toBe('')
  })
})

describe('the capture rect at a zoom factor (⌘+ / ⌘-)', () => {
  it('is the CSS rect itself at zoom 1', () => {
    expect(dipRect({ x: 23, y: 57, w: 500, h: 700 }, 1)).toEqual({ x: 23, y: 57, w: 500, h: 700 })
    expect(tileOffset({ x: 23, y: 57, w: 500, h: 700 }, { x: 23, y: 57, w: 500, h: 700 }, 1, 2)).toEqual({ x: 0, y: 0 })
  })

  it('is the CSS rect times the zoom, grown to whole DIPs, and holds the whole CSS rect', () => {
    const css = { x: 23, y: 57, w: 500, h: 700 }
    const d = dipRect(css, 1.25)
    expect(d).toEqual({ x: 28, y: 71, w: 626, h: 876 })
    expect(d.x).toBeLessThanOrEqual(css.x * 1.25)
    expect(d.x + d.w).toBeGreaterThanOrEqual((css.x + css.w) * 1.25)
    // 23 × 1.25 = 28.75 DIP, 28 captured: the CSS rect starts 0.75 DIP in, 1.5 → 2 device px at 2x.
    expect(tileOffset(css, d, 1.25, 2)).toEqual({ x: 2, y: 1 })
  })

  it('does not grow a DIP on float noise (10 × 1.1 = 11.000000000000002)', () => {
    expect(dipRect({ x: 10, y: 10, w: 10, h: 10 }, 1.1)).toEqual({ x: 11, y: 11, w: 11, h: 11 })
  })

  it('a bad zoom counts as 1', () => {
    expect(dipRect({ x: 1, y: 2, w: 3, h: 4 }, 0)).toEqual({ x: 1, y: 2, w: 3, h: 4 })
  })

  /** What `capturePage` returns for a tile, at screen scale `s` and zoom `z`: the window in device px,
   *  where the shifted page shows red left of page x 400 and blue from it. */
  function captureAt(css: { x: number; y: number; w: number; h: number }, at: Tile['at'], z: number, s: number): Tile {
    const d = dipRect(css, z)
    const width = d.w * s, height = d.h * s
    const bitmap = Buffer.alloc(width * height * 4)
    const dpr = s * z
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // The pixel's centre in window CSS px, then in page CSS px.
        const pageX = ((d.x * s + x + 0.5) / dpr) - css.x + at.x
        bitmap.set(pageX < 400 ? [0, 0, 255, 255] : [255, 0, 0, 255], (y * width + x) * 4)
      }
    }
    const o = tileOffset(css, d, z, s)
    return { at, width, height, bitmap, ox: o.x, oy: o.y }
  }

  it('at 125% on a 2x screen, the tiles of a 777×600 page stitch with no gap and the edge in place', () => {
    const z = 1.25, s = 2, dpr = z * s
    const page = { w: 777, h: 600 }
    const stage = { left: 23, top: 57.5, width: 374, height: 299 }
    const win = tileWindow(stage, { w: 1440, h: 900 })!
    const tiles = tilePlan(page, win).map((t) => {
      const shift = tileShift(stage, win, t)
      expect(stage.left + shift.x + t.x).toBe(win.x)
      return captureAt({ x: win.x, y: win.y, w: t.w, h: t.h }, t, z, s)
    })
    const img = stitchTiles(tiles, page, dpr)
    expect([img.width, img.height]).toEqual([Math.round(777 * dpr), Math.round(600 * dpr)])
    let clear = 0
    for (let i = 3; i < img.bitmap.length; i += 4) if (img.bitmap[i] === 0) clear++
    expect(clear).toBe(0)
    // Page x 400 is device column 1000 at 2.5: red just before it, blue from it (±1 px).
    for (const y of [0, 700, img.height - 1]) {
      expect(px(img, 998, y)).toEqual([0, 0, 255, 255])
      expect(px(img, 1001, y)).toEqual([255, 0, 0, 255])
    }
  })

  it('at zoom 1 on a 2x screen a capture has no offset and the stitch is exact', () => {
    const page = { w: 777, h: 300 }
    const stage = { left: 23, top: 57, width: 374, height: 299 }
    const win = tileWindow(stage, { w: 1440, h: 900 })!
    const tiles = tilePlan(page, win).map((t) => captureAt({ x: win.x, y: win.y, w: t.w, h: t.h }, t, 1, 2))
    expect(tiles.every((t) => t.ox === 0 && t.oy === 0)).toBe(true)
    const img = stitchTiles(tiles, page, 2)
    expect(px(img, 799, 10)).toEqual([0, 0, 255, 255])
    expect(px(img, 800, 10)).toEqual([255, 0, 0, 255])
  })
})

describe('deliverScreenshot — the clipboard first, then the file', () => {
  it('copies before it writes, and returns the path', async () => {
    const order: string[] = []
    const r = await deliverScreenshot(() => { order.push('copy') }, async () => { order.push('write'); return '/d/a.png' })
    expect(order).toEqual(['copy', 'write'])
    expect(r).toEqual({ path: '/d/a.png', copied: true })
  })

  it('a refused Downloads write keeps the clipboard copy and says why', async () => {
    const err = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
    const r = await deliverScreenshot(() => {}, async () => { throw err })
    expect(r).toEqual({ path: null, copied: true, saveError: 'macOS did not allow Operator to write to Downloads' })
  })

  it('a failed copy still writes the file', async () => {
    const r = await deliverScreenshot(() => { throw new Error('no clipboard') }, async () => '/d/a.png')
    expect(r).toEqual({ path: '/d/a.png', copied: false })
  })

  it('both failing reports both', async () => {
    const r = await deliverScreenshot(() => { throw new Error('x') }, async () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }) })
    expect(r).toEqual({ path: null, copied: false, saveError: 'the Downloads folder does not exist' })
  })

  it('names the common write failures, and falls back to the message', () => {
    expect(saveErrorReason(Object.assign(new Error('x'), { code: 'EACCES' }))).toBe('macOS did not allow Operator to write to Downloads')
    expect(saveErrorReason(Object.assign(new Error('x'), { code: 'ENOSPC' }))).toBe('the disk is full')
    expect(saveErrorReason(new Error('something else'))).toBe('something else')
  })
})

describe('freePath', () => {
  it('takes the name when it is free, else the first free -N', async () => {
    const taken = new Set([join('/d', 'a.png'), join('/d', 'a-2.png')])
    const exists = async (p: string) => taken.has(p)
    expect(await freePath('/d', 'b.png', exists)).toBe(join('/d', 'b.png'))
    expect(await freePath('/d', 'a.png', exists)).toBe(join('/d', 'a-3.png'))
  })
})
