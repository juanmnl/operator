// Preview annotations — visual feedback the user pins onto the running app, then dispatches
// to the agent (Console/Chat) as an actionable punch-list. The preview is a cross-origin
// iframe (the dev server), so we CAN'T read its DOM for a CSS selector or screenshot its
// content; instead an annotation carries resolution-independent geometry (percentages of the
// preview viewport) + the route + the note. The message composer turns that into human-legible
// location hints ("top-left", "~12%,34%") the agent can correlate with the code.

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

function locOf(a: Annotation): string {
  if (a.wPct != null && a.hPct != null) {
    return `${zoneLabel(a.xPct + a.wPct / 2, a.yPct + a.hPct / 2)} · ${Math.round(a.wPct)}%×${Math.round(a.hPct)}% region`
  }
  return `${zoneLabel(a.xPct, a.yPct)} · ~${Math.round(a.xPct)}%,${Math.round(a.yPct)}%`
}

/** Compose a dispatch message from a set of annotations sharing a route. */
export function composeMessage(anns: Annotation[], route: string, viewport?: { w: number; h: number }): string {
  if (anns.length === 0) return ''
  const vp = viewport && viewport.w ? ` (viewport ${Math.round(viewport.w)}×${Math.round(viewport.h)})` : ''
  const header = `UI feedback on ${route || '/'}${vp}:`
  const lines = anns.map((a, i) => `${i + 1}. [${locOf(a)}] ${a.note.trim() || '(no note)'}`)
  return `${header}\n${lines.join('\n')}\n\nPlease locate each in the code and address it.`
}
