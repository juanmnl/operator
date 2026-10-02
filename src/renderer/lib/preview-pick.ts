// The note an Inspect pick becomes. The inspector inside the previewed page composes the message and
// sends this payload back; the renderer turns it into the text dispatched to the Console or added
// to Tasks. Pure, so the wording is tested without the page.
//
// THE PAYLOAD IS THE PAGE'S WORD, NOT THE USER'S. The inspector runs in the previewed page's own
// main world, so the page (or any script it loads) can post a pick itself, with any text, and no
// click inside the page proves a person made it. A pick therefore never sends anything: it becomes
// a note in an Operator-drawn card, and the user's click on that card decides whether it goes and
// where. Security audit 2026-10-01, H1.

import { stripControlChars, stripInvisibleChars } from '../../shared/control-chars'

/** What `preview:pick` carries, as `src/shared/preview-inspector.js` builds it. */
export interface PreviewPick {
  selector?: string
  tag?: string
  text?: string
  component?: string | null
  source?: string | null
  message?: string
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
 *  the component and its source when React reports them, else the tag and selector. The result is
 *  passed through `cleanNote`, so it is the text the confirm card shows and the text that is sent. */
export function formatPick(p: PreviewPick): string {
  const who = p.component || p.tag || 'element'
  const loc = p.source ? `${who} @ ${p.source}` : `${who}${p.selector ? ` (${p.selector})` : ''}`
  const measurement = p.measurement ? ` — ${p.measurement}` : ''
  const text = p.text ? ` — “${p.text}”` : ''
  return cleanNote(`${(p.message || '').trim()}\n\n↳ ${loc}${measurement}${text}`)
}

/** A note as the user will see it in the confirm card, with nothing laid out to hide part of it:
 *  control characters out and line endings as `\n` (the rule every pty write applies anyway),
 *  bidi controls and zero-width characters out, the Unicode line and paragraph separators as `\n`,
 *  and any run of three or more blank lines (empty or whitespace only) cut to one blank line. A page
 *  can no longer push an instruction below the user's own words with forty newlines.
 *  Security review 2026-10-02, R1. */
export function cleanNote(text: string): string {
  return stripInvisibleChars(stripControlChars(text))
    .replace(/[\u2028\u2029]/g, '\n')
    .replace(/\n(?:[^\S\n]*\n){3,}/g, '\n\n')
    .trim()
}

/** A pick that arrived from the page, if it may become a pending note: only while the user has
 *  Inspect on, only when no other note is waiting on the user, and only when it parses to an object.
 *  A second pick while one waits is dropped rather than replacing it, so the page cannot swap the
 *  text under the user's cursor between reading it and clicking Send.
 *  Only the fields `PreviewPick` names are kept, and only with the type it gives them: strings for
 *  the text fields, finite numbers for the boxes and the scale. Anything else is left out, as if
 *  the page had not sent it. A `message` of `1` used to reach `formatPick` and throw there, which
 *  left the panel believing a note was waiting and dropped every later pick (security review
 *  2026-10-02, R2). Any `target` the page put in the payload goes the same way: the renderer's own
 *  buttons choose Console or Tasks. */
export function acceptPick(data: unknown, state: { inspecting: boolean; pending: boolean }): PreviewPick | null {
  if (!state.inspecting || state.pending || typeof data !== 'string') return null
  let p: unknown
  try { p = JSON.parse(data) } catch { return null }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null
  const raw = p as Record<string, unknown>
  const pick: PreviewPick = {}
  for (const k of PICK_STRINGS) if (typeof raw[k] === 'string') pick[k] = raw[k]
  const box = pickBox(raw.box)
  if (box) pick.box = box
  const anchorBox = pickBox(raw.anchorBox)
  if (anchorBox) pick.anchorBox = anchorBox
  if (isFiniteNumber(raw.scale)) pick.scale = raw.scale
  return pick
}

const PICK_STRINGS = ['selector', 'tag', 'text', 'component', 'source', 'message', 'measurement'] as const

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** A box from the payload, when it is an object whose x, y, w and h are all finite numbers. */
function pickBox(v: unknown): PreviewPick['box'] {
  if (!v || typeof v !== 'object') return undefined
  const { x, y, w, h } = v as Record<string, unknown>
  return isFiniteNumber(x) && isFiniteNumber(y) && isFiniteNumber(w) && isFiniteNumber(h) ? { x, y, w, h } : undefined
}
