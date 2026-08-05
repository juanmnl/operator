// Preview annotations — visual feedback the user pins onto the running app, then dispatches
// to the agent (Console/Chat) as an actionable punch-list. The preview is a cross-origin
// iframe (the dev server), so we CAN'T read its DOM for a CSS selector or screenshot its
// content; instead an annotation carries resolution-independent geometry (percentages of the
// preview viewport) PLUS the session-side context we DO know: the full URL loaded, the device
// preset / pixel viewport it was seen at (layout bugs are width-specific), and the note. The
// message composer turns that into human-legible location hints ("top-left", "~12%,34%",
// "≈ 154,272px") the agent can correlate with the code.

export interface Annotation {
  id: string
  /** Position as a percentage of the preview viewport (0–100), so it survives resizes. */
  xPct: number
  yPct: number
  /** Box size as a percentage of the viewport; absent for a point pin. */
  wPct?: number
  hPct?: number
  note: string
  /** Route (pathname) the preview showed when the note was made. */
  route: string
  /** Full URL loaded (host + path + query + hash) — SPA state lives in the query/hash,
   *  so the pathname alone (route) often isn't enough to reproduce. Best-effort: the URL
   *  WE loaded, not any in-app navigation after (cross-origin, unobservable). */
  url?: string
  /** Pixel viewport of the preview frame at capture time — lets the composer turn the
   *  percentage geometry into concrete pixel coordinates the agent can reason about. */
  viewport?: { w: number; h: number }
  /** Device preset being previewed ("Fit", "375px", …). Layout defects are width-specific,
   *  so which breakpoint the note was made at is first-class context. */
  device?: string
  /** GEOMETRY GENERATION. Absent (or 1) means the percentages are of the preview PANEL; 2 means
   *  they are of the PAGE. See `migrateAnnotations` — this field is what makes that a one-time
   *  upgrade instead of a rebase that compounds on every load. */
  v?: number
  createdAt: string
}

/** Percentages are of the PAGE. */
export const ANNOTATION_GEOM_VERSION = 2

const keyOf = (storageKey: string) => `operator.preview.annotations.${storageKey}`

/** "375px" → 375. "Fit", absent, or anything else → null. */
function presetOf(device?: string): number | null {
  const m = /^(\d+)px$/.exec(device ?? '')
  const n = m ? Number(m[1]) : NaN
  return Number.isFinite(n) && n > 0 ? n : null
}

/** RE-BASE v1 GEOMETRY ONTO THE PAGE.
 *
 *  A v1 annotation's percentages were of the preview PANEL, because the pins, the capture overlay
 *  and the iframe were all children of the same full-width wrapper. That was only ever the same
 *  thing as "of the page" while the frame FILLED the wrapper — at any preset narrower than the
 *  panel the page occupied the left part of that box and the rest was empty gutter, so a note
 *  pinned to a page feature was stored against a box wider than the page and pointed somewhere
 *  else. `AppPreviewPanel`'s stage fixed the live coordinate system; this carries the notes
 *  already on disk across with it.
 *
 *  IT IS RECOVERABLE because a v1 note recorded the two numbers the rebase needs: `viewport` (the
 *  wrapper's pixel box at capture time) and `device` (the preset). At capture:
 *
 *      W = viewport.w                 the wrapper's width
 *      pageW = min(preset, W)         the page's PAINTED width inside it, pinned to the left
 *      x_px = xPct / 100 * W    →     xPct' = x_px / pageW * 100    i.e. × (W / pageW)
 *
 *  ONLY THE HORIZONTAL AXIS MOVES. The frame was full-height in both cases (a preset scales the
 *  iframe's own height by `1/scale` so the painted height stays the panel's), so `yPct` and `hPct`
 *  already meant "of the page" and are left exactly as they are.
 *
 *  A PRESET WIDER THAN THE PANEL IS A NO-OP for geometry: `pageW` clamps to `W`, the factor is 1,
 *  and nothing shifts — which is right, because the page filled the wrapper in that case and never
 *  drifted. Its `viewport` is still restated in page pixels below, so `pxOf` quotes coordinates on
 *  the page rather than in the panel.
 *
 *  PINS DROPPED IN THE GUTTER ARE NOT CLAMPED. The old overlay covered the whole wrapper, so a
 *  note could be left beside the page; rebasing puts it past 100%, which is exactly where its
 *  author left it. The stage does not clip, so it still renders there. Clamping would silently
 *  move a note onto a feature it was never about. */
function rebase(a: Annotation): Partial<Annotation> {
  const preset = presetOf(a.device)
  const vp = a.viewport
  // Nothing recoverable (a bare note), or nothing to do (`Fit`, where wrapper == page already).
  if (!preset || !vp || !vp.w || !vp.h) return {}
  const pageW = Math.min(preset, vp.w)
  const k = vp.w / pageW
  const scale = Math.min(1, vp.w / preset)
  return {
    xPct: a.xPct * k,
    ...(a.wPct != null ? { wPct: a.wPct * k } : null),
    // The PAGE's own pixel box — `preset` CSS px wide however it was scaled to fit, and as tall as
    // the panel divided by that scale. This is what `pxOf` multiplies by, and what the live panel
    // records for new notes.
    viewport: { w: preset, h: vp.h / scale },
  }
}

/** Bring a stored list up to the current geometry generation. Pure, and returns the SAME array
 *  reference when there was nothing to do — which is how `loadAnnotations` knows whether to write
 *  back, so a load that changes nothing never touches localStorage.
 *
 *  Every annotation is stamped, including the ones with nothing to rebase: the stamp records that
 *  they were examined, so a bare note is not re-examined (and re-written) on every single load. */
export function migrateAnnotations(list: Annotation[]): Annotation[] {
  let changed = false
  const next = list.map((a) => {
    if ((a.v ?? 1) >= ANNOTATION_GEOM_VERSION) return a
    changed = true
    return { ...a, ...rebase(a), v: ANNOTATION_GEOM_VERSION }
  })
  return changed ? next : list
}

export function loadAnnotations(storageKey: string): Annotation[] {
  try {
    const r = localStorage.getItem(keyOf(storageKey))
    const list: Annotation[] = r ? JSON.parse(r) : []
    // UPGRADE ON READ, and persist it once. Migrating in the panel instead would leave the stored
    // copy in the old system, so every load would rebase again from a moving baseline.
    const next = migrateAnnotations(list)
    if (next !== list) saveAnnotations(storageKey, next)
    return next
  } catch { return [] }
}
export function saveAnnotations(storageKey: string, list: Annotation[]): void {
  try { localStorage.setItem(keyOf(storageKey), JSON.stringify(list)) } catch { /* quota */ }
}

/** A coarse human zone from a point — "top-left", "center", "bottom-right", … */
export function zoneLabel(xPct: number, yPct: number): string {
  const col = xPct < 34 ? 'left' : xPct < 67 ? 'center' : 'right'
  const row = yPct < 34 ? 'top' : yPct < 67 ? 'middle' : 'bottom'
  if (row === 'middle' && col === 'center') return 'center'
  if (row === 'middle') return col
  if (col === 'center') return row
  return `${row}-${col}`
}

/** Concrete pixel hint from the percentage geometry × the captured viewport, or null. */
function pxOf(a: Annotation): string | null {
  const vp = a.viewport
  if (!vp || !vp.w || !vp.h) return null
  if (a.wPct != null && a.hPct != null) {
    return `≈ ${Math.round((a.wPct / 100) * vp.w)}×${Math.round((a.hPct / 100) * vp.h)}px`
  }
  return `≈ ${Math.round((a.xPct / 100) * vp.w)},${Math.round((a.yPct / 100) * vp.h)}px`
}

function locOf(a: Annotation): string {
  const base = a.wPct != null && a.hPct != null
    ? `${zoneLabel(a.xPct + a.wPct / 2, a.yPct + a.hPct / 2)} · ${Math.round(a.wPct)}%×${Math.round(a.hPct)}% region`
    : `${zoneLabel(a.xPct, a.yPct)} · ~${Math.round(a.xPct)}%,${Math.round(a.yPct)}%`
  const px = pxOf(a)
  return px ? `${base} · ${px}` : base
}

/** Compose a dispatch message from a set of annotations sharing a page. Page-level
 *  context (URL, device, viewport) is taken from the annotations themselves when present,
 *  falling back to the passed route/viewport for older/bare annotations. */
export function composeMessage(anns: Annotation[], route: string, viewport?: { w: number; h: number }): string {
  if (anns.length === 0) return ''
  const first = anns[0]
  const page = first.url || route || '/'
  const vp = first.viewport ?? viewport
  const parts: string[] = []
  if (first.device) parts.push(first.device)
  if (vp && vp.w) parts.push(`viewport ${Math.round(vp.w)}×${Math.round(vp.h)}`)
  const ctx = parts.length ? ` (${parts.join(' · ')})` : ''
  const header = `UI feedback on ${page}${ctx}:`
  const lines = anns.map((a, i) => `${i + 1}. [${locOf(a)}] ${a.note.trim() || '(no note)'}`)
  return `${header}\n${lines.join('\n')}\n\nPlease locate each in the code and address it.`
}
