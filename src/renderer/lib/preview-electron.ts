// Preview for Electron apps, renderer side: fitting the app's frames into the stage and turning DOM
// input into CDP input. Pure, so it is tested; the transport is electron/src/main/preview-cdp.ts.
import type { CdpInput } from '../../shared/types'

/** The app's CSS viewport, fitted inside the panel box and never enlarged past 1:1 (a screencast
 *  frame is at the app's device pixels; blowing it up would only blur it). `scale` is panel px per
 *  page CSS px, which is also what the injected scripts take as `scale`. */
export function fitFrame(box: { w: number; h: number }, css: { w: number; h: number }): { w: number; h: number; scale: number } {
  if (!(css.w > 0 && css.h > 0 && box.w > 0 && box.h > 0)) return { w: 0, h: 0, scale: 1 }
  const scale = Math.min(1, box.w / css.w, box.h / css.h)
  return { w: css.w * scale, h: css.h * scale, scale }
}

/** A point on the canvas (its own CSS px) → the app page's CSS px. */
export function toPage(x: number, y: number, scale: number): { x: number; y: number } {
  const k = scale > 0 ? scale : 1
  return { x: Math.round((x / k) * 100) / 100, y: Math.round((y / k) * 100) / 100 }
}

/** CDP's modifier bits: alt 1, ctrl 2, meta 4, shift 8. */
export function cdpModifiers(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)
}

/** DOM `MouseEvent.button` → CDP's button name. */
export function cdpButton(button: number): 'left' | 'middle' | 'right' | 'none' {
  return button === 0 ? 'left' : button === 1 ? 'middle' : button === 2 ? 'right' : 'none'
}

/** A DOM key event → CDP input. A printable key with no ⌘/⌃ carries `text`, which is what inserts it;
 *  the app's own shortcuts (⌘S) go through as keys without text. */
export function keyInput(
  e: { key: string; code: string; keyCode: number; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  type: 'keyDown' | 'keyUp',
): Extract<CdpInput, { kind: 'key' }> {
  const printable = e.key.length === 1 && !e.metaKey && !e.ctrlKey
  const text = type === 'keyDown' ? (printable ? e.key : e.key === 'Enter' ? '\r' : undefined) : undefined
  return { kind: 'key', type, key: e.key, code: e.code, text, keyCode: e.keyCode, modifiers: cdpModifiers(e) }
}
