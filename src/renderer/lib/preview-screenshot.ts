// The Preview screenshot, renderer side: the tile loop that moves the iframe under the stage, and
// the layers of Operator's that are hidden while it runs. The arithmetic is in
// src/shared/preview-screenshot.ts; the capture and the stitch are in main
// (electron/src/main/preview-screenshot-capture.ts).
//
// LAYOUT IS FROZEN FOR THE CAPTURE by refusing to go on when it moves: the tiles are planned from one
// stage rect at one pixel ratio, so a window resize, a side-panel drag, a panel toggle or a display
// change partway through aborts the capture rather than stitching tiles of two layouts. The iframe
// then gets the transform React wants NOW (the scale may have changed), not the one read at the
// start, which React would never write again.
import type { PreviewScreenshotTileRequest } from '../../shared/types'
import {
  screenshotPixels, screenshotTooLarge, tilePlan, tileShift, tileWindow, type Size,
} from '../../shared/preview-screenshot'

export interface StageBox { left: number; top: number; width: number; height: number }

/** A tile that has not come back by then is a stalled capture. Longer than main's own capture
 *  timeout, so main normally answers first. */
export const TILE_TIMEOUT_MS = 4000
/** Hiding or showing Operator's drawing in the page. Main bounds it too. */
export const HIDE_TIMEOUT_MS = 1500

export interface TileLoopDeps {
  /** The iframe, whose inline transform the loop writes. */
  frame: { style: { transform: string } }
  stage: () => StageBox
  viewport: () => Size
  /** `window.devicePixelRatio`: the screen's scale times the zoom. */
  dpr: () => number
  /** The transform React wants on the iframe now: `scale(…)`, or '' when it fits. */
  wantTransform: () => string
  hide: (hidden: boolean) => Promise<void>
  tile: (req: PreviewScreenshotTileRequest) => Promise<boolean>
  /** Wait for the renderer to paint the shifted iframe. */
  paint: () => Promise<void>
  /** Before each tile, after the paint: hide any layer that has come up over the stage since. */
  beforeTile?: () => void
  id?: string
  tileTimeoutMs?: number
  hideTimeoutMs?: number
}

export type TileLoopResult = { ok: true; id: string } | { ok: false; reason: string }

/** Resolve with `fallback` when `p` has not settled within `ms`, or rejects. */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p.catch(() => fallback).finally(() => clearTimeout(timer)),
    new Promise<T>((r) => { timer = setTimeout(() => r(fallback), ms) }),
  ])
}

const sameBox = (a: StageBox, b: StageBox) =>
  Math.abs(a.left - b.left) < 0.01 && Math.abs(a.top - b.top) < 0.01
  && Math.abs(a.width - b.width) < 0.01 && Math.abs(a.height - b.height) < 0.01

/** Capture the page as tiles. Always leaves the iframe with the transform React wants and the page's
 *  drawing shown, whether it succeeds, aborts, or a tile never returns. */
export async function runTileLoop(page: Size, d: TileLoopDeps): Promise<TileLoopResult> {
  const stage0 = d.stage()
  const vp0 = d.viewport()
  const dpr0 = d.dpr()
  const win = tileWindow(stage0, vp0)
  if (!win) return { ok: false, reason: 'The preview is not on screen.' }
  const tooLarge = screenshotTooLarge(screenshotPixels(page, dpr0))
  if (tooLarge) return { ok: false, reason: tooLarge }
  /** Why the layout no longer matches the plan, or null. */
  const moved = (): string | null => {
    if (d.dpr() !== dpr0) return 'The window’s pixel density changed during the capture (another display, or zoom).'
    const vp = d.viewport()
    if (vp.w !== vp0.w || vp.h !== vp0.h || !sameBox(d.stage(), stage0)) return 'The preview moved or changed size during the capture.'
    return null
  }
  const id = d.id ?? crypto.randomUUID()
  const tileMs = d.tileTimeoutMs ?? TILE_TIMEOUT_MS
  const hideMs = d.hideTimeoutMs ?? HIDE_TIMEOUT_MS
  await withTimeout(d.hide(true), hideMs, undefined)
  try {
    for (const t of tilePlan(page, win)) {
      const before = moved()
      if (before) return { ok: false, reason: before }
      const shift = tileShift(stage0, win, t)
      d.frame.style.transform = `translate(${shift.x}px, ${shift.y}px)`
      await d.paint()
      d.beforeTile?.()
      // A rejected tile is a failed one; only silence is a timeout.
      const ok = await withTimeout(d.tile({ id, rect: { x: win.x, y: win.y, w: t.w, h: t.h }, at: t }).catch(() => false), tileMs, null)
      if (ok === null) return { ok: false, reason: `A tile was not captured within ${Math.round(tileMs / 1000)} s.` }
      if (!ok) return { ok: false, reason: 'The preview could not be captured.' }
      const after = moved()
      if (after) return { ok: false, reason: after }
    }
  } finally {
    d.frame.style.transform = d.wantTransform()
    await withTimeout(d.hide(false), hideMs, undefined)
  }
  return { ok: true, id }
}

/** Layers that sit over a stage whenever they are open: the overlaid side panel and the toast stack.
 *  Whatever else is over the stage is found by hit-testing (`hideLayersOver`). */
export const KNOWN_LAYERS = '[data-side-panel-slot="overlay"],[data-toast-stack]'

/** The outermost ancestor of `el` that does not contain the stage: the whole layer `el` belongs to,
 *  hidden as one. */
export function layerOf(el: Element, stage: Element): Element {
  let top = el
  while (top.parentElement && !top.parentElement.contains(stage)) top = top.parentElement
  return top
}

/** The layers drawn over `stage` inside `rect`, by hit-testing a grid of points. Hit-testing finds
 *  what takes the pointer; a `pointer-events: none` layer is only found through `KNOWN_LAYERS`. The
 *  stage's own children (the screenshot's input shield, hidden pins) are passed over; the frame, the
 *  stage and its ancestors end the stack at a point. */
export function layersOver(
  stage: Element, frame: Element | null, rect: { x: number; y: number; w: number; h: number },
  hit: (x: number, y: number) => Element[], steps = 8,
): Set<Element> {
  const out = new Set<Element>()
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const x = rect.x + 1 + ((rect.w - 2) * i) / steps
      const y = rect.y + 1 + ((rect.h - 2) * j) / steps
      for (const el of hit(x, y)) {
        if (el === frame || el === stage || el.contains(stage)) break
        if (stage.contains(el)) continue
        out.add(layerOf(el, stage))
      }
    }
  }
  return out
}

/** Hide every layer of Operator's over the stage for the capture, with an inline `!important`
 *  visibility, and put each one's own value back after. `refresh` hides layers that came up since. */
export function hideLayersOver(stage: HTMLElement, frame: HTMLElement | null): { refresh: () => void; restore: () => void } {
  const saved = new Map<HTMLElement, { value: string; priority: string }>()
  const hideOne = (el: Element) => {
    if (!(el instanceof HTMLElement) || saved.has(el) || el.contains(stage)) return
    saved.set(el, { value: el.style.getPropertyValue('visibility'), priority: el.style.getPropertyPriority('visibility') })
    el.style.setProperty('visibility', 'hidden', 'important')
  }
  const refresh = () => {
    document.querySelectorAll(KNOWN_LAYERS).forEach(hideOne)
    if (typeof document.elementsFromPoint !== 'function') return
    const r = stage.getBoundingClientRect()
    const rect = { x: Math.max(0, r.left), y: Math.max(0, r.top), w: Math.min(window.innerWidth, r.right) - Math.max(0, r.left), h: Math.min(window.innerHeight, r.bottom) - Math.max(0, r.top) }
    if (rect.w < 2 || rect.h < 2) return
    layersOver(stage, frame, rect, (x, y) => document.elementsFromPoint(x, y)).forEach(hideOne)
  }
  const restore = () => {
    for (const [el, { value, priority }] of saved) {
      if (value) el.style.setProperty('visibility', value, priority)
      else el.style.removeProperty('visibility')
    }
    saved.clear()
  }
  refresh()
  return { refresh, restore }
}

/** The input shield's wheel handler: a wheel over the stage during the capture would scroll the
 *  page between tiles and tear the image. Registered non-passive, so it can prevent the scroll. */
export function swallowWheel(e: Event): void {
  e.preventDefault()
  e.stopPropagation()
}
