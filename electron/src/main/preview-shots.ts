// SCREENSHOTS FOR PREVIEW NOTES. Every Annotate and Inspect note carries a crop of what the user
// was looking at, so the agent gets the picture along with the location.
//
// WHERE THE PIXELS COME FROM. The renderer cannot read them: in Annotate the page is a cross-origin
// iframe, and in Inspect it is a separate native view. Main can, with `capturePage(rect)`:
//   - Annotate: the main window's webContents. Its capture includes the out-of-process iframe.
//   - Inspect:  the inspect view's own webContents (see `previewApi.capture` in preview-inspect.ts).
//
// Everything that is arithmetic or bytes is a pure function here and tested: the crop rect (margin,
// clamping to the surface), the outline drawn into the bitmap, the output size cap and the
// encoding choice, and the on-disk layout with its cleanup.
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { operatorDir } from './store'

export interface Rect { x: number; y: number; w: number; h: number }

/** Space around the picked element or region, in the surface's own units (DIP). */
export const SHOT_MARGIN = 24
/** A point pin gets a box this big around it, so the crop has something to show. */
export const PIN_BOX = 120
/** Longest side of the stored image, in device pixels. */
export const SHOT_MAX_LONG = 1600
/** Try PNG first; past this size, JPEG. */
export const SHOT_MAX_BYTES = 500 * 1024
/** Inspect notes have no stored note to delete with, so their shots age out. */
export const PICK_SHOT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

/** The smallest rect holding every target. Empty input gives an empty rect. */
export function unionRect(rects: readonly Rect[]): Rect {
  const real = rects.filter((r) => Number.isFinite(r.x) && Number.isFinite(r.y) && r.w >= 0 && r.h >= 0)
  if (!real.length) return { x: 0, y: 0, w: 0, h: 0 }
  const x0 = Math.min(...real.map((r) => r.x))
  const y0 = Math.min(...real.map((r) => r.y))
  const x1 = Math.max(...real.map((r) => r.x + r.w))
  const y1 = Math.max(...real.map((r) => r.y + r.h))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** A point pin as a box centred on it. */
export function pinRect(x: number, y: number, size = PIN_BOX): Rect {
  return { x: x - size / 2, y: y - size / 2, w: size, h: size }
}

/** An element box in the inspect page's CSS px → the view's DIP. The page is emulated at the
 *  stage's scale (a 1280 preset in a 640 stage is 0.5), so a CSS px is `scale` DIP on screen. */
export function pageToView(r: Rect, scale: number): Rect {
  const k = scale > 0 ? scale : 1
  return { x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k }
}

/** THE CROP: the targets plus a margin, clamped to the capture surface, in whole DIP.
 *
 *  Clamped rather than shifted: a target at the page edge gets less margin on that side instead
 *  of a crop that slides away from it. `null` when nothing of the target is on the surface. */
export function cropRect(target: Rect, surface: { w: number; h: number }, margin = SHOT_MARGIN): Rect | null {
  const x0 = Math.max(0, Math.floor(target.x - margin))
  const y0 = Math.max(0, Math.floor(target.y - margin))
  const x1 = Math.min(Math.floor(surface.w), Math.ceil(target.x + target.w + margin))
  const y1 = Math.min(Math.floor(surface.h), Math.ceil(target.y + target.h + margin))
  if (x1 - x0 < 1 || y1 - y0 < 1) return null
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** `cropRect` against a clip rect that does not start at the origin (the preview stage inside the
 *  window). Returns window coordinates. */
export function cropRectIn(target: Rect, clip: Rect, margin = SHOT_MARGIN): Rect | null {
  const local = cropRect({ ...target, x: target.x - clip.x, y: target.y - clip.y }, { w: clip.w, h: clip.h }, margin)
  if (!local) return null
  return { x: local.x + Math.floor(clip.x), y: local.y + Math.floor(clip.y), w: local.w, h: local.h }
}

/** An outline target in the captured bitmap's pixels: relative to the crop, times the image's
 *  device scale (the captured image is `crop × scaleFactor` pixels on a Retina display). */
export function toBitmapRect(target: Rect, crop: Rect, pixelScale: number): Rect {
  return {
    x: Math.round((target.x - crop.x) * pixelScale),
    y: Math.round((target.y - crop.y) * pixelScale),
    w: Math.round(target.w * pixelScale),
    h: Math.round(target.h * pixelScale),
  }
}

/** Width to resize to so the long side is at most `max`; `null` when no resize is needed. */
export function fitWidth(width: number, height: number, max = SHOT_MAX_LONG): number | null {
  const long = Math.max(width, height)
  if (long <= max || width <= 0) return null
  return Math.max(1, Math.round(width * (max / long)))
}

/** Draw a rectangle outline into a BGRA bitmap in place (Electron's `toBitmap` order). The
 *  rectangle is clipped to the bitmap; `thickness` grows inward from the rect's edge, plus one
 *  pixel outward, so a box on the element's edge stays visible against it. */
export function drawOutline(
  buf: Buffer, width: number, height: number, r: Rect,
  color: { r: number; g: number; b: number }, thickness = 2,
): void {
  const put = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const i = (y * width + x) * 4
    buf[i] = color.b; buf[i + 1] = color.g; buf[i + 2] = color.r; buf[i + 3] = 255
  }
  const x0 = r.x - 1, y0 = r.y - 1, x1 = r.x + r.w, y1 = r.y + r.h
  for (let t = 0; t < thickness; t++) {
    for (let x = x0 + t; x <= x1 - t; x++) { put(x, y0 + t); put(x, y1 - t) }
    for (let y = y0 + t; y <= y1 - t; y++) { put(x0 + t, y); put(x1 - t, y) }
  }
}

/** PNG when it fits the byte budget, else JPEG at falling quality, else the smallest JPEG. */
export function chooseEncoding(encode: { png: () => Buffer; jpeg: (quality: number) => Buffer }, max = SHOT_MAX_BYTES): { bytes: Buffer; ext: 'png' | 'jpg' } {
  const png = encode.png()
  if (png.length <= max) return { bytes: png, ext: 'png' }
  let last = png
  for (const q of [85, 70, 55]) {
    last = encode.jpeg(q)
    if (last.length <= max) return { bytes: last, ext: 'jpg' }
  }
  return { bytes: last, ext: 'jpg' }
}

// ── storage: ~/.operator/preview-shots/<project>/<note-id>.<png|jpg> ─────────────────────────────

/** A path segment from an id we did not mint. Anything that could climb out is replaced. */
export const safeSegment = (s: string): string => basename(String(s)).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_') || '_'

export const shotsRoot = (): string => join(operatorDir(), 'preview-shots')
export const shotDir = (project: string): string => join(shotsRoot(), safeSegment(project || 'no-project'))

export async function saveShot(project: string, id: string, bytes: Buffer, ext: 'png' | 'jpg'): Promise<string> {
  const dir = shotDir(project)
  await mkdir(dir, { recursive: true })
  // A re-capture of the same note replaces the old file whichever format it was.
  await deleteShot(project, id)
  const path = join(dir, `${safeSegment(id)}.${ext}`)
  await writeFile(path, bytes)
  return path
}

/** The stored file for a note, or null. */
export async function findShot(project: string, id: string): Promise<string | null> {
  for (const ext of ['png', 'jpg']) {
    const p = join(shotDir(project), `${safeSegment(id)}.${ext}`)
    try { if ((await stat(p)).isFile()) return p } catch { /* not this one */ }
  }
  return null
}

export async function deleteShot(project: string, id: string): Promise<void> {
  const base = join(shotDir(project), safeSegment(id))
  await Promise.all(['png', 'jpg'].map((ext) => rm(`${base}.${ext}`, { force: true })))
}

/** A stored shot as a data URL, for the renderer's <img> (a `file://` src is refused by the app's
 *  navigation guard, the moodboard's reason too). Empty when there is none. */
export async function shotDataUrl(project: string, id: string): Promise<string> {
  const p = await findShot(project, id)
  if (!p) return ''
  const mime = p.endsWith('.png') ? 'image/png' : 'image/jpeg'
  try { return `data:${mime};base64,${(await readFile(p)).toString('base64')}` } catch { return '' }
}

/** Inspect notes are sent at once and never stored, so their shots have no note to be deleted
 *  with. Their ids start with this, and only these files age out. */
export const PICK_PREFIX = 'pick-'

/** Remove Inspect-note shots (`pick-*`) older than `maxAgeMs`. Annotate shots are never touched
 *  here: they live exactly as long as their note, and the note's Delete removes them. Returns how
 *  many were removed. */
export async function prunePickShots(project: string, maxAgeMs = PICK_SHOT_MAX_AGE_MS, now = Date.now()): Promise<number> {
  const dir = shotDir(project)
  let names: string[]
  try { names = await readdir(dir) } catch { return 0 }
  let removed = 0
  for (const name of names) {
    if (!name.startsWith(PICK_PREFIX) || !/\.(png|jpg)$/.test(name)) continue
    try {
      const st = await stat(join(dir, name))
      if (now - st.mtimeMs < maxAgeMs) continue
      await rm(join(dir, name), { force: true })
      removed++
    } catch { /* gone already */ }
  }
  return removed
}
