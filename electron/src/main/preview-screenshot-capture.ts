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
import { capturedDpr, screenshotFileName, type Size } from '../../../src/shared/preview-screenshot'
import { saveScreenshot, stitchTiles, type Tile } from './preview-screenshot'

/** Let the page paint a moved iframe or hidden drawing before the capture reads it. */
const settle = () => new Promise((r) => setTimeout(r, 50))

/** The capture in progress. One at a time: the Preview toolbar has one button. */
let pending: { id: string; dpr: number; tiles: Tile[] } | null = null

/** Capture one tile. False when it failed, and the capture's tiles are dropped: the renderer stops
 *  there, and a partial image is never saved. */
export async function captureTile(win: BrowserWindow | null, req: PreviewScreenshotTileRequest): Promise<boolean> {
  try {
    const r = req.rect
    if (!win || win.isDestroyed() || !(r.w >= 1 && r.h >= 1)) { pending = null; return false }
    if (!pending || pending.id !== req.id) pending = { id: req.id, dpr: 0, tiles: [] }
    const cap = pending
    await settle()
    const img = await win.webContents.capturePage({ x: r.x, y: r.y, width: r.w, height: r.h })
    if (!img || img.isEmpty()) { pending = null; return false }
    const { width, height } = img.getSize()
    // Every tile of one capture is stitched at the first tile's ratio.
    if (!cap.dpr) cap.dpr = capturedDpr(width, r.w)
    cap.tiles.push({ at: req.at, width, height, bitmap: Buffer.from(img.toBitmap()) })
    return true
  } catch (e) {
    console.error('[preview-screenshot] tile failed:', e)
    pending = null
    return false
  }
}

/** The page image from the tiles of capture `id`, which are then dropped. Null when there are none
 *  (a failed tile, or a newer capture). */
export function takeTiles(id: string, page: Size): NativeImage | null {
  const cap = pending && pending.id === id ? pending : null
  pending = null
  if (!cap || !cap.tiles.length) return null
  const { width, height, bitmap } = stitchTiles(cap.tiles, page, cap.dpr)
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

/** Write the PNG to Downloads and put the image on the clipboard. The file is the result; a
 *  clipboard failure is logged and reported, not fatal. */
async function deliver(img: NativeImage, project: string, page: Size): Promise<PreviewScreenshot> {
  const path = await saveScreenshot(app.getPath('downloads'), screenshotFileName(project, page, new Date()), img.toPNG())
  let copied = true
  try { clipboard.writeImage(img) } catch (e) { copied = false; console.error('[preview-screenshot] clipboard failed:', e) }
  const size = img.getSize()
  return { path, cssWidth: page.w, cssHeight: page.h, width: size.width, height: size.height, copied }
}
