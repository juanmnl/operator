// The Electron half of preview-note screenshots: capture, crop, outline, encode, store. The
// decisions (rects, outline pixels, size cap, encoding, storage) are the pure functions in
// preview-shots.ts; this file only moves bytes through `NativeImage`.
import { nativeImage, type BrowserWindow, type NativeImage } from 'electron'
import type { PreviewShot, PreviewShotRequest } from '../../../src/shared/types'
import {
  chooseEncoding, cropRectIn, drawOutline, fitWidth, pageToView, prunePickShots, saveShot, toBitmapRect,
  unionRect, PICK_PREFIX, type Rect,
} from './preview-shots'

export interface CaptureSources {
  window: () => BrowserWindow | null
  /** The inspect view: its size, and a capture of a rect in its own DIP. Null when it is not up. */
  inspect: {
    size: () => { width: number; height: number } | null
    capture: (rect: Rect) => Promise<NativeImage | null>
  }
}

/** Let a frame or two paint first: the note card the user just clicked away is removed in the same
 *  tick the request is sent, and a capture of the previous frame would still show it. */
const settle = () => new Promise((r) => setTimeout(r, 50))

const THUMB_W = 240

export async function capturePreviewShot(req: PreviewShotRequest, sources: CaptureSources): Promise<PreviewShot | null> {
  try {
    let targets: Rect[]
    let clip: Rect
    let grab: (rect: Rect) => Promise<NativeImage | null>
    if (req.source === 'inspect') {
      const size = sources.inspect.size()
      if (!size) return null
      targets = req.targets.map((t) => pageToView(t, req.scale ?? 1))
      clip = { x: 0, y: 0, w: size.width, h: size.height }
      grab = sources.inspect.capture
    } else {
      const win = sources.window()
      if (!win || !req.clip) return null
      targets = req.targets
      clip = req.clip
      grab = (rect) => win.webContents.capturePage({ x: rect.x, y: rect.y, width: rect.w, height: rect.h })
    }
    // `margin` is in the request's units; an inspect page's CSS px are `scale` DIP on screen.
    const margin = req.margin == null ? undefined : req.margin * (req.source === 'inspect' ? (req.scale ?? 1) : 1)
    const crop = cropRectIn(unionRect(targets), clip, margin)
    if (!crop) return null
    await settle()
    const shot = await grab(crop)
    if (!shot || shot.isEmpty()) return null

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
  } catch (e) {
    console.error('[preview-shot] capture failed:', e)
    return null
  }
}
