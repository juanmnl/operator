// The note an Inspect pick becomes. The inspector inside the previewed page composes the message and
// sends this payload back; the renderer turns it into the text dispatched to the Console or added
// to Tasks. Pure, so the wording is tested without the page.

/** What `preview:pick` carries, as `src/shared/preview-inspector.js` builds it. */
export interface PreviewPick {
  selector?: string
  tag?: string
  text?: string
  component?: string | null
  source?: string | null
  message?: string
  target?: 'console' | 'tasks'
  /** Where the element sits relative to the redline anchor, when one was set (`16px below Header`). */
  measurement?: string
  /** The element's box in the page's CSS px, for the note's screenshot. */
  box?: { x: number; y: number; w: number; h: number }
  /** The redline anchor's box, when the note measures from one. */
  anchorBox?: { x: number; y: number; w: number; h: number }
  /** The page's emulated scale when it was picked. */
  scale?: number
}

/** `<message>\n\n↳ PlanCard @ src/Pricing.tsx:42 — 16px below Header — “Pro”`. The location names
 *  the component and its source when React reports them, else the tag and selector. */
export function formatPick(p: PreviewPick): string {
  const who = p.component || p.tag || 'element'
  const loc = p.source ? `${who} @ ${p.source}` : `${who}${p.selector ? ` (${p.selector})` : ''}`
  const measurement = p.measurement ? ` — ${p.measurement}` : ''
  const text = p.text ? ` — “${p.text}”` : ''
  return `${(p.message || '').trim()}\n\n↳ ${loc}${measurement}${text}`.trim()
}
