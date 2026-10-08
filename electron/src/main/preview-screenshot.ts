// THE PREVIEW SCREENSHOT, main side: stitch the tiles, hide Operator's drawing in the page, and write
// the file. The arithmetic is shared with the renderer (src/shared/preview-screenshot.ts); the
// Electron half that captures and touches the clipboard is preview-screenshot-capture.ts.
import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { screenshotPixels, tileOrigin, withSuffix, type Rect, type Size } from '../../../src/shared/preview-screenshot'

/** One captured tile: where it sits on the page (CSS px), and its BGRA pixels. */
export interface Tile {
  at: Rect
  width: number
  height: number
  bitmap: Buffer
}

/** Copy the tiles into one BGRA bitmap of the page at `dpr`. A tile whose pixels run past the image
 *  (a rounding pixel at a fractional ratio) is clipped to it; a pixel no tile covered stays clear. */
export function stitchTiles(tiles: readonly Tile[], page: Size, dpr: number): { width: number; height: number; bitmap: Buffer } {
  const { w: width, h: height } = screenshotPixels(page, dpr)
  const out = Buffer.alloc(width * height * 4)
  for (const t of tiles) {
    const o = tileOrigin(t.at, dpr)
    const cols = Math.min(t.width, width - o.x)
    const rows = Math.min(t.height, height - o.y)
    if (cols <= 0 || rows <= 0 || o.x < 0 || o.y < 0) continue
    for (let y = 0; y < rows; y++) {
      const src = y * t.width * 4
      t.bitmap.copy(out, ((o.y + y) * width + o.x) * 4, src, src + cols * 4)
    }
  }
  return { width, height, bitmap: out }
}

/** Everything Operator draws inside a previewed page: the overlay host (grid, redlines, the anchor),
 *  the CSS controls' handles, the inspector's hover box and label, and its compose card. */
export const OPERATOR_PAGE_DRAWING = '[data-operator-overlay],[data-operator-edit],[data-operator-inspector],#__op_compose'

/** A script that hides (or shows again) Operator's drawing in the page, for one capture. Inline
 *  `!important` rather than a <style>, so a page whose CSP refuses inline styles still obeys it, and
 *  nothing is removed: the compose card keeps its text and the anchor stays set. */
export function pageDrawingVisibilityJs(hidden: boolean): string {
  return `;(function () {
  var els = document.querySelectorAll(${JSON.stringify(OPERATOR_PAGE_DRAWING)});
  for (var i = 0; i < els.length; i++) {
    ${hidden ? "els[i].style.setProperty('visibility', 'hidden', 'important');" : "els[i].style.removeProperty('visibility');"}
  }
})();`
}

/** The first free path for `name` in `dir`: `name`, then `name-2.png`, `name-3.png`… */
export async function freePath(dir: string, name: string, exists: (p: string) => Promise<boolean> = pathExists): Promise<string> {
  for (let n = 1; n < 1000; n++) {
    const p = join(dir, withSuffix(name, n))
    if (!(await exists(p))) return p
  }
  return join(dir, withSuffix(name, Date.now()))
}

async function pathExists(p: string): Promise<boolean> {
  try { await stat(p); return true } catch { return false }
}

/** Write the PNG to the first free name in `dir`. Returns the path. */
export async function saveScreenshot(dir: string, name: string, png: Buffer): Promise<string> {
  const path = await freePath(dir, name)
  await writeFile(path, png, { flag: 'wx' })
  return path
}
