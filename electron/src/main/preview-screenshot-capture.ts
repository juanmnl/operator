// The Electron half of the Preview screenshot: capture tiles from the main window, stitch, encode,
// save to ~/Downloads and copy to the clipboard. The decisions are in preview-screenshot.ts and
// src/shared/preview-screenshot.ts; this file only moves bytes through `NativeImage`.
//
// THE WEB PREVIEW is captured in steps the renderer drives, because only the renderer can move the
// iframe: it hides Operator's drawing (`setHidden`), shifts the iframe under the stage and asks for
// one tile at a time (`tile`), then asks for the file (`save`). Tiles wait here, keyed by the
// capture's id, until `save` stitches them or a newer capture replaces them.
import { app, clipboard, nativeImage, type BrowserWindow, type NativeImage } from 'electron'
import type { PreviewScreenshot, PreviewScreenshotTileRequest } from '../../../src/shared/types'
import { screenshotFileName, screenshotPixels, screenshotTooLarge, type Size } from '../../../src/shared/preview-screenshot'
import { deliverScreenshot, dipRect, saveScreenshot, stitchTiles, tileOffset, type Tile } from './preview-screenshot'

/** Let the page paint a moved iframe or hidden drawing before the capture reads it. */
const settle = () => new Promise((r) => setTimeout(r, 50))

/** A `capturePage` that has not answered by then has stalled (a minimized or occluded window can wait
 *  for a frame that never comes). The capture is dropped; the renderer has its own, longer timeout
 *  on the whole call, so it restores the preview either way. */
export const TILE_CAPTURE_TIMEOUT_MS = 3000

/** The capture in progress. One at a time: the Preview toolbar has one button. `scale` and `zoom`
 *  are the first tile's; a tile at another screen scale or zoom (the window moved to another
 *  display, or ⌘+ during the capture) fails the capture rather than stitching mixed densities. */
let pending: { id: string; scale: number; zoom: number; tiles: Tile[] } | null = null

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<null>((r) => { timer = setTimeout(() => r(null), ms) }),
  ])
}

/** Capture one tile. False when it failed, and the capture's tiles are dropped: the renderer stops
 *  there, and a partial image is never saved. `beforeCapture` waits for the page to paint the area
 *  the shift just moved into view (preview-inspect.ts `framePainted`). */
export async function captureTile(
  win: BrowserWindow | null, req: PreviewScreenshotTileRequest, beforeCapture?: () => Promise<void>,
): Promise<boolean> {
  try {
    const r = req.rect
    if (!win || win.isDestroyed() || !(r.w >= 1 && r.h >= 1)) { pending = null; return false }
    const zoom = win.webContents.getZoomFactor()
    if (!pending || pending.id !== req.id) pending = { id: req.id, scale: 0, zoom, tiles: [] }
    const cap = pending
    if (cap.zoom !== zoom) { pending = null; return false }
    await beforeCapture?.()
    await settle()
    const dip = dipRect(r, zoom)
    const img = await withTimeout(win.webContents.capturePage({ x: dip.x, y: dip.y, width: dip.w, height: dip.h }), TILE_CAPTURE_TIMEOUT_MS)
    // A late answer to a capture that timed out, or was replaced, is dropped.
    if (pending !== cap) return false
    if (!img || img.isEmpty()) { pending = null; return false }
    const { width, height } = img.getSize()
    const scale = width / dip.w
    if (!cap.scale) cap.scale = scale
    else if (Math.abs(cap.scale - scale) > 0.01) { pending = null; return false }
    const o = tileOffset(r, dip, zoom, cap.scale)
    cap.tiles.push({ at: req.at, width, height, bitmap: Buffer.from(img.toBitmap()), ox: o.x, oy: o.y })
    return true
  } catch (e) {
    console.error('[preview-screenshot] tile failed:', e)
    pending = null
    return false
  }
}

/** The page image from the tiles of capture `id`, which are then dropped. Null when there are none
 *  (a failed tile, or a newer capture). Throws past the size cap, which the renderer checks first. */
export function takeTiles(id: string, page: Size): NativeImage | null {
  const cap = pending && pending.id === id ? pending : null
  pending = null
  if (!cap || !cap.tiles.length) return null
  // Device px per page CSS px: the screen's scale times the zoom.
  const dpr = cap.scale * cap.zoom
  const tooLarge = screenshotTooLarge(screenshotPixels(page, dpr))
  if (tooLarge) throw new Error(tooLarge)
  const { width, height, bitmap } = stitchTiles(cap.tiles, page, dpr)
  return nativeImage.createFromBitmap(bitmap, { width, height })
}

/** Stitch the tiles of capture `id` into the page image and deliver it. */
export async function saveTiles(id: string, project: string, page: Size): Promise<PreviewScreenshot | null> {
  try {
    const img = takeTiles(id, page)
    return img ? await deliver(img, project, page) : null
  } catch (e) {
    console.error('[preview-screenshot] save failed:', e)
    return null
  }
}

/** A PNG captured whole (an Electron app over CDP) at `css` size. */
export async function savePng(png: Buffer, project: string, css: Size): Promise<PreviewScreenshot | null> {
  try {
    const img = nativeImage.createFromBuffer(png)
    if (img.isEmpty()) return null
    return await deliver(img, project, { w: Math.round(css.w), h: Math.round(css.h) })
  } catch (e) {
    console.error('[preview-screenshot] save failed:', e)
    return null
  }
}

/** Put the image on the clipboard, then write the PNG to Downloads. Either can fail without the
 *  other (preview-screenshot.ts `deliverScreenshot`); the renderer words each case. */
async function deliver(img: NativeImage, project: string, page: Size): Promise<PreviewScreenshot> {
  const png = img.toPNG()
  const done = await deliverScreenshot(
    () => clipboard.writeImage(img),
    () => saveScreenshot(app.getPath('downloads'), screenshotFileName(project, page, new Date()), png),
  )
  const size = img.getSize()
  return { ...done, cssWidth: page.w, cssHeight: page.h, width: size.width, height: size.height }
}
