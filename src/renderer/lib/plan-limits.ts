// Plan limits — the pure half. Everything the meter needs to decide, with no DOM and no bridge,
// so every rule below is testable without a subprocess.
//
// The rule that runs through all of it: **absent is not zero.** A user on API billing, a reworded
// CLI, a timed-out subprocess — all of those mean "no data", and rendering them as 0% would say
// "you've used nothing", which is the opposite of unknown. Every function here keeps the two apart.

export interface PlanLimits {
  sessionPct?: number | null
  sessionResets?: string | null
  weekPct?: number | null
  weekResets?: string | null
  modelLabel?: string | null
  modelPct?: number | null
  modelResets?: string | null
  plan?: string | null
  fetchedAt: string
  note?: string | null
}

/** Where the fill changes colour. Past 75% is worth noticing; past 90% is worth acting on. */
export const WARN_AT = 75
export const DANGER_AT = 90

export type LimitTone = 'normal' | 'warn' | 'danger'

export function toneFor(pct: number | null | undefined): LimitTone {
  if (pct == null) return 'normal'
  if (pct >= DANGER_AT) return 'danger'
  if (pct >= WARN_AT) return 'warn'
  return 'normal'
}

/** Fill colour per tone. Tokens only — and the element carrying these must have NO border, since
 *  a colour-CHANGING border on a radiused element re-rasterizes in WKWebView. */
export const TONE_FILL: Record<LimitTone, string> = {
  normal: 'var(--accent)',
  warn: 'var(--status-compacting)',
  danger: 'var(--color-error)',
}

/** A number we can actually draw: a real number in 0–100. `null`/`undefined`/NaN are ABSENT. */
export function readable(pct: number | null | undefined): number | null {
  if (typeof pct !== 'number' || Number.isNaN(pct)) return null
  return Math.max(0, Math.min(100, pct))
}

/** Does this reply carry anything worth drawing? Used to decide between a filled ring and an
 *  empty track — never to decide between a ring and 0%. */
export function hasData(l: PlanLimits | null | undefined): boolean {
  return readable(l?.sessionPct) !== null || readable(l?.weekPct) !== null
}

/** The rows the popover lists, in order, skipping the ones this account doesn't have.
 *  The per-model row carries the CLI's own label — never a hardcoded model name. */
export function limitRows(l: PlanLimits | null | undefined): Array<{
  key: string; label: string; pct: number; resets?: string | null
}> {
  if (!l) return []
  const rows: Array<{ key: string; label: string; pct: number; resets?: string | null }> = []
  const session = readable(l.sessionPct)
  if (session !== null) rows.push({ key: 'session', label: 'Current session', pct: session, resets: l.sessionResets })
  const week = readable(l.weekPct)
  if (week !== null) rows.push({ key: 'week', label: 'Current week', pct: week, resets: l.weekResets })
  const model = readable(l.modelPct)
  if (model !== null) {
    rows.push({ key: 'model', label: `Current week (${l.modelLabel ?? 'per model'})`, pct: model, resets: l.modelResets })
  }
  return rows
}

/** The hover line — a glance that never needs a click. `null` when there's nothing to say. */
export function glanceLine(l: PlanLimits | null | undefined): string | null {
  const session = readable(l?.sessionPct)
  const week = readable(l?.weekPct)
  const parts: string[] = []
  if (session !== null) parts.push(`Session ${session}%`)
  if (week !== null) parts.push(`Week ${week}%`)
  return parts.length ? parts.join(' · ') : null
}

/** "Updated 3m ago". Coarse on purpose: this is a 5-minute-TTL cache, and a seconds-precise
 *  timestamp would imply a freshness it doesn't have. */
export function updatedAgo(fetchedAt: string | undefined, now: number): string | null {
  if (!fetchedAt) return null
  const t = Date.parse(fetchedAt)
  if (Number.isNaN(t)) return null
  const mins = Math.floor((now - t) / 60_000)
  if (mins < 0) return 'just now' // clock skew — never print a negative age
  if (mins < 1) return 'just now'
  if (mins === 1) return '1m ago'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  return hours === 1 ? '1h ago' : `${hours}h ago`
}

/** SVG arc geometry for the ring: the dash pair for a circle of radius `r` swept to `pct`.
 *  Returned rather than drawn so the sweep can be asserted numerically. */
export function ringDash(pct: number | null, r: number): { dash: number; gap: number; circumference: number } {
  const circumference = 2 * Math.PI * r
  const value = readable(pct)
  // No data → dash 0: the track draws, the arc does not. Absent is not zero, but it is also not
  // a full ring — an empty track is the honest picture of "we don't know".
  const dash = value === null ? 0 : (circumference * value) / 100
  return { dash, gap: circumference - dash, circumference }
}
