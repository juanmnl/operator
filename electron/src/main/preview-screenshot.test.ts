import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { freePath, pageDrawingVisibilityJs, stitchTiles, OPERATOR_PAGE_DRAWING, type Tile } from './preview-screenshot'

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

  it('hides with an inline !important and shows by removing it, removing nothing else', () => {
    const calls: string[] = []
    const el = { style: { setProperty: (...a: string[]) => calls.push(`set ${a.join(' ')}`), removeProperty: (p: string) => calls.push(`remove ${p}`) } }
    const document = { querySelectorAll: (sel: string) => { calls.push(`query ${sel}`); return [el] } }
    new Function('document', pageDrawingVisibilityJs(true))(document)
    new Function('document', pageDrawingVisibilityJs(false))(document)
    expect(calls).toEqual([
      `query ${OPERATOR_PAGE_DRAWING}`, 'set visibility hidden important',
      `query ${OPERATOR_PAGE_DRAWING}`, 'remove visibility',
    ])
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
