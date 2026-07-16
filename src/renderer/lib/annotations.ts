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
  createdAt: string
}

const keyOf = (storageKey: string) => `operator.preview.annotations.${storageKey}`

export function loadAnnotations(storageKey: string): Annotation[] {
  try { const r = localStorage.getItem(keyOf(storageKey)); return r ? JSON.parse(r) : [] } catch { return [] }
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
