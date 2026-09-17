// Screenshot crops on Preview notes, renderer side: which rects to outline, and how a note's text
// names its screenshot. The capture itself is in main (electron/src/main/preview-shots.ts), because
// the renderer cannot read the pixels of a cross-origin iframe or of the native inspect view.
import type { PreviewShotRequest } from '../../shared/types'
import type { PreviewPick } from './preview-pick'

export interface Rect { x: number; y: number; w: number; h: number }

/** A point pin's outline: a small box on the point. */
export const PIN_MARK = 18
/** A point pin's crop reaches this far around the mark, so there is something to see. */
export const PIN_MARGIN = 72

/** Where an Annotate note sits, in WINDOW px, from its page percentages and the stage's rect. */
export function annotationTargets(
  geom: { xPct: number; yPct: number; wPct?: number; hPct?: number },
  stage: { left: number; top: number; width: number; height: number },
): { targets: Rect[]; margin?: number } {
  const x = stage.left + (geom.xPct / 100) * stage.width
  const y = stage.top + (geom.yPct / 100) * stage.height
  if (geom.wPct != null && geom.hPct != null) {
    return { targets: [{ x, y, w: (geom.wPct / 100) * stage.width, h: (geom.hPct / 100) * stage.height }] }
  }
  return { targets: [{ x: x - PIN_MARK / 2, y: y - PIN_MARK / 2, w: PIN_MARK, h: PIN_MARK }], margin: PIN_MARGIN }
}

/** An Inspect pick's outlines: the element, and the redline anchor when the note measures from one,
 *  so a measurement note shows both elements in one crop. Page CSS px. */
export function pickTargets(p: PreviewPick): Rect[] {
  const out: Rect[] = []
  if (p.box) out.push(p.box)
  if (p.anchorBox) out.push(p.anchorBox)
  return out
}

/** Build the capture request for an Inspect pick, or null when the pick carries no box (a shell
 *  whose inspector predates it). */
export function pickShotRequest(p: PreviewPick, project: string, id: string, outline?: PreviewShotRequest['outline']): PreviewShotRequest | null {
  const targets = pickTargets(p)
  if (!targets.length) return null
  return { source: 'inspect', project, id, targets, scale: p.scale, outline }
}

/** The line a note carries for its screenshot. The path is ALSO attached as an image when the note
 *  goes to the Console; in a task it is the only reference, and the agent can read the file. */
export function withScreenshot(text: string, path: string | undefined | null): string {
  return path ? `${text}\n\nScreenshot: ${path}` : text
}

/** The folder a project's shots go in. A lane with no project still gets one. */
export function shotProject(projectId: string | null | undefined): string {
  return projectId || 'no-project'
}

/** `rgb(47, 227, 154)` / `rgba(…)` / `#2fe39a` → channels. Undefined when it cannot be read. */
export function parseRgb(css: string): { r: number; g: number; b: number } | undefined {
  const hex = /^#([0-9a-f]{6})$/i.exec(css.trim())
  if (hex) {
    const n = parseInt(hex[1], 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
  }
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(css)
  if (!m) return undefined
  return { r: Math.round(Number(m[1])), g: Math.round(Number(m[2])), b: Math.round(Number(m[3])) }
}
