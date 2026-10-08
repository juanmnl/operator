// THE PREVIEW SCREENSHOT, main side: stitch the tiles, hide Operator's drawing in the page, and write
// the file. The arithmetic is shared with the renderer (src/shared/preview-screenshot.ts); the
// Electron half that captures and touches the clipboard is preview-screenshot-capture.ts.
import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { screenshotPixels, tileOrigin, withSuffix, type Rect, type Size } from '../../../src/shared/preview-screenshot'

/** One captured tile: where it sits on the page (CSS px), and its BGRA pixels. `ox`/`oy` are where
 *  the tile's own area starts in the bitmap, in device px: the capture is grown to whole DIPs, so at
 *  a fractional zoom it starts a pixel or two before the tile (see `tileOffset`). */
export interface Tile {
  at: Rect
  width: number
  height: number
  bitmap: Buffer
  ox?: number
  oy?: number
}

/** The rect `capturePage` is asked for. The renderer measures in window CSS px; `capturePage` takes
 *  the view's DIPs, which are CSS px times the zoom factor (⌘+ / ⌘- change it). Grown to whole DIPs,
 *  so it always contains the CSS rect. The epsilon keeps a product like 10 × 1.1 = 11.000000000000002
 *  from growing a whole DIP. */
export function dipRect(css: Rect, zoom: number): Rect {
  const z = zoom > 0 ? zoom : 1
  const e = 1e-6
  const x = Math.floor(css.x * z + e), y = Math.floor(css.y * z + e)
  const x1 = Math.ceil((css.x + css.w) * z - e), y1 = Math.ceil((css.y + css.h) * z - e)
  return { x, y, w: Math.max(1, x1 - x), h: Math.max(1, y1 - y) }
}

/** Where the CSS rect starts inside a capture of `dip`, in device px, at `screenScale` device px per
 *  DIP. Zero at zoom 1 with whole CSS px. */
export function tileOffset(css: Rect, dip: Rect, zoom: number, screenScale: number): { x: number; y: number } {
  const z = zoom > 0 ? zoom : 1
  return {
    x: Math.max(0, Math.round((css.x * z - dip.x) * screenScale)),
    y: Math.max(0, Math.round((css.y * z - dip.y) * screenScale)),
  }
}

/** Copy the tiles into one BGRA bitmap of the page at `dpr` (screen scale × zoom). Each tile fills
 *  exactly its own page area, from `tileOrigin(at)` to `tileOrigin(at + size)`, so neighbours meet
 *  without a gap at a fractional ratio. When a capture is a pixel short of that area (rounding at a
 *  fractional ratio), its last row or column is repeated rather than left clear. A tile that runs
 *  past the image is clipped; a pixel no tile covered stays clear. */
export function stitchTiles(tiles: readonly Tile[], page: Size, dpr: number): { width: number; height: number; bitmap: Buffer } {
  const { w: width, h: height } = screenshotPixels(page, dpr)
  const out = Buffer.alloc(width * height * 4)
  for (const t of tiles) {
    const o = tileOrigin(t.at, dpr)
    const end = tileOrigin({ x: t.at.x + t.at.w, y: t.at.y + t.at.h, w: 0, h: 0 }, dpr)
    const ox = t.ox ?? 0, oy = t.oy ?? 0
    const cols = Math.min(end.x, width) - o.x
    const rows = Math.min(end.y, height) - o.y
    const have = Math.min(cols, t.width - ox)
    if (cols <= 0 || rows <= 0 || have <= 0 || o.x < 0 || o.y < 0 || oy >= t.height) continue
    for (let y = 0; y < rows; y++) {
      const src = (Math.min(oy + y, t.height - 1) * t.width + ox) * 4
      const dst = ((o.y + y) * width + o.x) * 4
      t.bitmap.copy(out, dst, src, src + have * 4)
      for (let x = have; x < cols; x++) out.copy(out, dst + x * 4, dst + (have - 1) * 4, dst + have * 4)
    }
  }
  return { width, height, bitmap: out }
}

/** Everything Operator draws inside a previewed page: the overlay host (grid, redlines, the anchor),
 *  the CSS controls' handles, the inspector's hover box and label, and its compose card. */
export const OPERATOR_PAGE_DRAWING = '[data-operator-overlay],[data-operator-edit],[data-operator-inspector],#__op_compose'

/** A script that hides (or shows again) Operator's drawing in the page, for one capture. Inline
 *  `!important` rather than a <style>, so a page whose CSP refuses inline styles still obeys it, and
 *  nothing is removed: the compose card keeps its text and the anchor stays set.
 *
 *  Hiding also watches the page until it is shown again: an element of Operator's created during the
 *  capture (the inspector's compose card, a hover box made on first use) is hidden as it is added,
 *  and a style rewrite (the inspector's `paint()` sets `cssText`) is hidden again. The observer's
 *  callback runs before the next paint, so neither reaches a tile. */
export function pageDrawingVisibilityJs(hidden: boolean): string {
  return `;(function () {
  var SEL = ${JSON.stringify(OPERATOR_PAGE_DRAWING)};
  var KEY = '__operatorScreenshotWatch';
  function hide(el) {
    if (el.style.getPropertyValue('visibility') !== 'hidden' || el.style.getPropertyPriority('visibility') !== 'important') {
      el.style.setProperty('visibility', 'hidden', 'important');
    }
  }
  if (window[KEY]) { window[KEY].disconnect(); window[KEY] = null; }
  var els = document.querySelectorAll(SEL);
  for (var i = 0; i < els.length; i++) {
    ${hidden ? 'hide(els[i]);' : "els[i].style.removeProperty('visibility');"}
  }
  ${hidden ? `if (typeof MutationObserver === 'function' && document.documentElement) {
    var mo = new MutationObserver(function (records) {
      for (var r = 0; r < records.length; r++) {
        var rec = records[r];
        if (rec.type === 'attributes') { if (rec.target.matches && rec.target.matches(SEL)) hide(rec.target); continue; }
        for (var n = 0; n < rec.addedNodes.length; n++) {
          var node = rec.addedNodes[n];
          if (node.nodeType !== 1) continue;
          if (node.matches(SEL)) hide(node);
          var inner = node.querySelectorAll(SEL);
          for (var k = 0; k < inner.length; k++) hide(inner[k]);
        }
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
    window[KEY] = mo;
  }` : ''}
})();`
}

/** A script that resolves after the page's own second animation frame. The preview is an
 *  out-of-process iframe: Chromium rasters only its visible area, so after a shift the area just moved
 *  into view is drawn by the iframe's process, on its own frame. The parent's frames say nothing
 *  about it. */
export const PAGE_PAINTED_JS = 'new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(function () { r(1) }) }) })'

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

/** A failed Downloads write in words. macOS answers a refused privacy prompt for ~/Downloads with
 *  EPERM or EACCES. */
export function saveErrorReason(e: unknown): string {
  const code = (e as { code?: string } | null)?.code
  if (code === 'EPERM' || code === 'EACCES') return 'macOS did not allow Operator to write to Downloads'
  if (code === 'ENOENT') return 'the Downloads folder does not exist'
  if (code === 'ENOSPC') return 'the disk is full'
  return e instanceof Error && e.message ? e.message : String(e)
}

/** What the delivery did: the clipboard copy and the file are independent, so either can fail alone. */
export interface Delivered {
  path: string | null
  copied: boolean
  saveError?: string
}

/** Copy first, then write. The copy needs no file, so a refused or missing Downloads folder still
 *  leaves the image on the clipboard, and the failure is reported with its reason. */
export async function deliverScreenshot(copy: () => void, write: () => Promise<string>): Promise<Delivered> {
  let copied = true
  try { copy() } catch (e) { copied = false; console.error('[preview-screenshot] clipboard failed:', e) }
  try {
    return { path: await write(), copied }
  } catch (e) {
    console.error('[preview-screenshot] save failed:', e)
    return { path: null, copied, saveError: saveErrorReason(e) }
  }
}
