import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync, utimesSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = mkdtempSync(join(tmpdir(), 'operator-shots-'))
process.env.OPERATOR_DIR = SANDBOX
const S = await import('./preview-shots')
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

describe('crop rect math', () => {
  it('adds the margin on every side', () => {
    expect(S.cropRect({ x: 100, y: 200, w: 50, h: 20 }, { w: 1000, h: 1000 }, 24)).toEqual({ x: 76, y: 176, w: 98, h: 68 })
  })

  it('clamps to the surface instead of sliding the crop away from an edge target', () => {
    expect(S.cropRect({ x: 5, y: 10, w: 40, h: 40 }, { w: 60, h: 1000 }, 24)).toEqual({ x: 0, y: 0, w: 60, h: 74 })
  })

  it('snaps outward to whole units', () => {
    expect(S.cropRect({ x: 10.4, y: 10.6, w: 5.2, h: 5.1 }, { w: 100, h: 100 }, 0)).toEqual({ x: 10, y: 10, w: 6, h: 6 })
  })

  it('is null when the target is entirely off the surface', () => {
    expect(S.cropRect({ x: 500, y: 10, w: 20, h: 20 }, { w: 300, h: 300 }, 24)).toBeNull()
  })

  it('works inside a clip that does not start at the origin (the stage in the window)', () => {
    const clip = { x: 300, y: 80, w: 400, h: 600 }
    expect(S.cropRectIn({ x: 290, y: 100, w: 50, h: 50 }, clip, 24)).toEqual({ x: 300, y: 80, w: 64, h: 94 })
  })

  it('unions both elements of a measurement note into one crop', () => {
    expect(S.unionRect([{ x: 10, y: 10, w: 20, h: 20 }, { x: 100, y: 50, w: 10, h: 10 }])).toEqual({ x: 10, y: 10, w: 100, h: 50 })
    expect(S.unionRect([])).toEqual({ x: 0, y: 0, w: 0, h: 0 })
  })

  it('maps an outline into device pixels relative to the crop (Retina = 2)', () => {
    expect(S.toBitmapRect({ x: 100, y: 200, w: 50, h: 20 }, { x: 76, y: 176, w: 98, h: 68 }, 2)).toEqual({ x: 48, y: 48, w: 100, h: 40 })
  })

  it('caps the long side, and leaves a small image alone', () => {
    expect(S.fitWidth(3200, 1000)).toBe(1600)
    expect(S.fitWidth(1000, 3200)).toBe(500)
    expect(S.fitWidth(1600, 900)).toBeNull()
  })

  it('a pin box is centred on the point', () => {
    expect(S.pinRect(100, 100, 40)).toEqual({ x: 80, y: 80, w: 40, h: 40 })
  })
})

describe('outline and encoding', () => {
  it('draws the outline one pixel outside the box, clipped to the bitmap, in BGRA', () => {
    const W = 10, H = 10
    const buf = Buffer.alloc(W * H * 4)
    S.drawOutline(buf, W, H, { x: 2, y: 2, w: 4, h: 4 }, { r: 10, g: 20, b: 30 }, 1)
    const px = (x: number, y: number) => [...buf.subarray((y * W + x) * 4, (y * W + x) * 4 + 4)]
    expect(px(1, 1)).toEqual([30, 20, 10, 255])
    expect(px(6, 6)).toEqual([30, 20, 10, 255])
    expect(px(3, 3)).toEqual([0, 0, 0, 0])
    S.drawOutline(buf, W, H, { x: -5, y: -5, w: 30, h: 30 }, { r: 1, g: 1, b: 1 }, 2) // off the edges: no throw
  })

  it('keeps PNG under the budget and falls back to JPEG above it', () => {
    const small = S.chooseEncoding({ png: () => Buffer.alloc(100), jpeg: () => Buffer.alloc(50) }, 200)
    expect(small.ext).toBe('png')
    const tried: number[] = []
    const big = S.chooseEncoding({ png: () => Buffer.alloc(900), jpeg: (q) => { tried.push(q); return Buffer.alloc(q * 3) } }, 220)
    expect(big.ext).toBe('jpg')
    expect(tried).toEqual([85, 70])
    expect(big.bytes.length).toBe(210)
  })
})

describe('storage and cleanup', () => {
  it('stores under preview-shots/<project>/<id>.<ext> and finds it', async () => {
    const path = await S.saveShot('proj-1', 'note-a', Buffer.from('png'), 'png')
    expect(path).toBe(join(SANDBOX, 'preview-shots', 'proj-1', 'note-a.png'))
    expect(await S.findShot('proj-1', 'note-a')).toBe(path)
    expect(await S.shotDataUrl('proj-1', 'note-a')).toBe(`data:image/png;base64,${Buffer.from('png').toString('base64')}`)
  })

  it('a re-capture in the other format replaces the old file', async () => {
    await S.saveShot('proj-1', 'note-b', Buffer.from('png'), 'png')
    const jpg = await S.saveShot('proj-1', 'note-b', Buffer.from('jpg'), 'jpg')
    expect(existsSync(join(SANDBOX, 'preview-shots', 'proj-1', 'note-b.png'))).toBe(false)
    expect(await S.findShot('proj-1', 'note-b')).toBe(jpg)
  })

  it('deleting a note removes its shot, and deleting twice is fine', async () => {
    await S.saveShot('proj-1', 'note-c', Buffer.from('x'), 'png')
    await S.deleteShot('proj-1', 'note-c')
    await S.deleteShot('proj-1', 'note-c')
    expect(await S.findShot('proj-1', 'note-c')).toBeNull()
    expect(await S.shotDataUrl('proj-1', 'note-c')).toBe('')
  })

  it('never writes outside the shots root, whatever the ids say', async () => {
    const path = await S.saveShot('../../etc', '../passwd', Buffer.from('x'), 'png')
    expect(path.startsWith(join(SANDBOX, 'preview-shots') + '/')).toBe(true)
    expect(S.safeSegment('..')).not.toBe('..')
    expect(S.shotDir('')).toBe(join(SANDBOX, 'preview-shots', 'no-project'))
  })

  it('ages out only old Inspect shots, never Annotate notes', async () => {
    const old = Date.now() - S.PICK_SHOT_MAX_AGE_MS - 60_000
    const pOld = await S.saveShot('proj-2', 'pick-old', Buffer.from('x'), 'png')
    await S.saveShot('proj-2', 'pick-new', Buffer.from('x'), 'png')
    const note = await S.saveShot('proj-2', 'note-old', Buffer.from('x'), 'png')
    utimesSync(pOld, old / 1000, old / 1000)
    utimesSync(note, old / 1000, old / 1000)
    expect(await S.prunePickShots('proj-2')).toBe(1)
    expect(readdirSync(join(SANDBOX, 'preview-shots', 'proj-2')).sort()).toEqual(['note-old.png', 'pick-new.png'])
    expect(await S.prunePickShots('missing-project')).toBe(0)
  })
})
