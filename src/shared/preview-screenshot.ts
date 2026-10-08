// THE PREVIEW SCREENSHOT: the page at the viewport size the preview is set to, at the display's
// device pixel ratio, with nothing of Operator's in it. Not a note crop (preview-shot.ts): this is
// the whole page, saved to ~/Downloads and put on the clipboard.
//
// WHY TILES. A preset wider than the panel is shown scaled down with a CSS transform, so a capture of
// the window over the stage has `scale × dpr` pixels per page px, not `dpr`. Chromium will not
// screenshot the out-of-process iframe on its own ("Command can only be executed on top-level
// targets"), and `Page.captureScreenshot` with `clip.scale` on the window upscales the iframe's
// low-resolution raster: measured blurry (electron/probes/preview-screenshot.cjs). So for the capture
// the iframe is drawn at scale 1, and the page, which is now larger than the stage, is captured one
// stage-sized window at a time: the iframe is shifted under the stage for each tile and the tiles are
// stitched in main. The page's own viewport never changes, so it does not re-lay out or scroll.
//
// Everything here is arithmetic, shared by the renderer (plan, shift) and main (stitch, name).

export interface Size { w: number; h: number }
export interface Rect { x: number; y: number; w: number; h: number }

/** The page's viewport in whole CSS px: the image's size before the device pixel ratio. A preset
 *  page is `preset × panel height / scale`, which need not be whole. */
export function screenshotPageSize(pageBox: Size): Size {
  return { w: Math.max(1, Math.round(pageBox.w)), h: Math.max(1, Math.round(pageBox.h)) }
}

/** The capture window: the largest whole-px rect inside the stage's box, in window CSS px, and
 *  inside the window's viewport (`capturePage` cannot read past it). Null when nothing is left. */
export function tileWindow(
  stage: { left: number; top: number; width: number; height: number },
  viewport: Size,
): Rect | null {
  const x0 = Math.max(0, Math.ceil(stage.left))
  const y0 = Math.max(0, Math.ceil(stage.top))
  const x1 = Math.min(Math.floor(viewport.w), Math.floor(stage.left + stage.width))
  const y1 = Math.min(Math.floor(viewport.h), Math.floor(stage.top + stage.height))
  if (x1 - x0 < 1 || y1 - y0 < 1) return null
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** The tiles that cover the page, row by row, each at most the window's size, in page CSS px. A page
 *  that fits the window is one tile. */
export function tilePlan(page: Size, tile: Size): Rect[] {
  const out: Rect[] = []
  if (page.w < 1 || page.h < 1 || tile.w < 1 || tile.h < 1) return out
  for (let y = 0; y < page.h; y += tile.h) {
    for (let x = 0; x < page.w; x += tile.w) {
      out.push({ x, y, w: Math.min(tile.w, page.w - x), h: Math.min(tile.h, page.h - y) })
    }
  }
  return out
}

/** The iframe's `translate` for one tile, at scale 1: it puts the tile's page origin on the capture
 *  window's whole-px origin. The iframe's untransformed origin is the stage's top-left. */
export function tileShift(stage: { left: number; top: number }, win: Rect, tile: Rect): { x: number; y: number } {
  return { x: win.x - stage.left - tile.x, y: win.y - stage.top - tile.y }
}

/** The image's size in device pixels. */
export function screenshotPixels(page: Size, dpr: number): Size {
  const k = dpr > 0 ? dpr : 1
  return { w: Math.max(1, Math.round(page.w * k)), h: Math.max(1, Math.round(page.h * k)) }
}

/** Where a tile's pixels start in the stitched image. */
export function tileOrigin(tile: Rect, dpr: number): { x: number; y: number } {
  const k = dpr > 0 ? dpr : 1
  return { x: Math.round(tile.x * k), y: Math.round(tile.y * k) }
}

/** The device pixel ratio a capture came back at: its pixel width over the CSS width asked for. */
export function capturedDpr(pixelWidth: number, cssWidth: number): number {
  return cssWidth > 0 && pixelWidth > 0 ? pixelWidth / cssWidth : 1
}

/** A project name as a file-name prefix: letters, digits, `.`, `_` and `-`; spaces become `-`. */
export function fileStem(project: string | null | undefined): string {
  const s = String(project ?? '').trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9._-]/g, '').replace(/^[.-]+/, '')
  return s || 'preview'
}

const pad = (n: number) => String(n).padStart(2, '0')

/** `<project>-<W>x<H>-<YYYYMMDD-HHMMSS>.png`, local time, with W×H the page's CSS size. */
export function screenshotFileName(project: string | null | undefined, page: Size, at: Date): string {
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  return `${fileStem(project)}-${page.w}x${page.h}-${stamp}.png`
}

/** A second capture in the same second gets `-2`, `-3`… before the extension. */
export function withSuffix(name: string, n: number): string {
  return n <= 1 ? name : name.replace(/\.png$/, `-${n}.png`)
}
