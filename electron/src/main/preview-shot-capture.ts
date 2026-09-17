// The Electron half of preview-note screenshots: capture, crop, outline, encode, store. The
// decisions (rects, outline pixels, size cap, encoding, storage) are the pure functions in
// preview-shots.ts; this file only moves bytes through `NativeImage`.
import { nativeImage, type BrowserWindow, type NativeImage } from 'electron'
import type { PreviewShot, PreviewShotRequest } from '../../../src/shared/types'
import {
  chooseEncoding, cropRectIn, drawOutline, fitWidth, prunePickShots, saveShot, toBitmapRect,
  unionRect, PICK_PREFIX, type Rect,
} from './preview-shots'

export interface CaptureSources {
  window: () => BrowserWindow | null
  /** Hide the in-page inspector's hover outline (the page is the preview iframe; preview-inspect.ts). */
  hideInspector: () => Promise<void>
}

/** Let a frame or two paint first: the note card the user just clicked away is removed in the same
 *  tick the request is sent, and a capture of the previous frame would still show it. */
const settle = () => new Promise((r) => setTimeout(r, 50))

const THUMB_W = 240

export async function capturePreviewShot(req: PreviewShotRequest, sources: CaptureSources): Promise<PreviewShot | null> {
  try {
    // The main window over the preview stage, for both kinds of note. Its capture includes the
    // out-of-process iframe, which is the page in Electron (there is no separate inspect view).
    const win = sources.window()
    if (!win || !req.clip) return null
    const targets: Rect[] = req.targets
    const crop = cropRectIn(unionRect(targets), req.clip, req.margin ?? undefined)
    if (!crop) return null
    if (req.hideInspector) await sources.hideInspector()
    await settle()
    const shot: NativeImage = await win.webContents.capturePage({ x: crop.x, y: crop.y, width: crop.w, height: crop.h })
    if (!shot || shot.isEmpty()) return null
    return await finishShot(shot, crop, targets, req)
  } catch (e) {
    console.error('[preview-shot] capture failed:', e)
    return null
  }
}

/** Outline, size, encode and store a captured crop. `crop` and `targets` share one unit (window DIP
 *  here; a page's CSS px for an Electron app captured over CDP, see preview-cdp.ts). Throws on a
 *  storage failure; the callers catch. */
export async function finishShot(
  shot: NativeImage, crop: Rect, targets: readonly Rect[],
  req: Pick<PreviewShotRequest, 'project' | 'id' | 'outline'>,
): Promise<PreviewShot> {
  // Device pixels: on a Retina display the image is twice the crop's DIP size.
  const { width, height } = shot.getSize()
  const pixelScale = width / crop.w
  const bitmap = Buffer.from(shot.toBitmap())
  const color = req.outline ?? { r: 47, g: 227, b: 154 }
  const thickness = Math.max(2, Math.round(pixelScale * 1.5))
  for (const t of targets) drawOutline(bitmap, width, height, toBitmapRect(t, crop, pixelScale), color, thickness)
  let img = nativeImage.createFromBitmap(bitmap, { width, height })
  const fit = fitWidth(width, height)
  if (fit) img = img.resize({ width: fit, quality: 'best' })

  const { bytes, ext } = chooseEncoding({ png: () => img.toPNG(), jpeg: (q) => img.toJPEG(q) })
  const path = await saveShot(req.project, req.id, bytes, ext)
  if (req.id.startsWith(PICK_PREFIX)) void prunePickShots(req.project)
  const size = img.getSize()
  return {
    path, width: size.width, height: size.height, bytes: bytes.length,
    thumb: img.resize({ width: Math.min(THUMB_W, size.width), quality: 'good' }).toDataURL(),
  }
}
