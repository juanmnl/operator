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
 *  empty track — never to decide between a ring and 0%. Every limit counts, including the
 *  per-model one: an account that only reports that row still has a reading, and drawing the
 *  bare track next to a populated popover would be the meter contradicting itself. */
export function hasData(l: PlanLimits | null | undefined): boolean {
  return readable(l?.sessionPct) !== null
    || readable(l?.weekPct) !== null
    || readable(l?.modelPct) !== null
}

// --- Freshness: STALE IS NOT CURRENT ------------------------------------------------------
//
// The sibling of "absent is not zero", and the same mistake one axis over. A reading was fetched
// once and then displayed forever: a session percentage sat on the ring all day while the window
// it described rolled over underneath it, and the only hint was a line inside a popover nobody had
// open. A number you can't stand behind is worse than no number — you act on it.
//
// So age is a rendering input, not a footnote. Two thresholds, because "go and check" and "stop
// claiming this" are different decisions:

/** How long a reading stays CURRENT. Deliberately the backend's own cache TTL (planlimits.rs
 *  `TTL`) — that constant is this app's statement of how long a reading means anything, and the
 *  two must stay equal: revalidating faster than the cache just burns IPC on the same value, and
 *  slower leaves the meter behind the data it already has. */
export const FRESH_MS = 5 * 60_000

/** …and how long before the meter stops ASSERTING a percentage. Much longer than FRESH_MS,
 *  because these are different failures: a six-minute-old reading is worth re-checking and still
 *  worth showing, while an hour with no successful read means we genuinely do not know — the app
 *  was asleep, or the CLI is gone. Falling back to the unknown state is the honest picture, and it
 *  self-heals the moment any read lands. */
export const STALE_MS = 60 * 60_000

/** Milliseconds since this reading was fetched; `null` when there is no usable timestamp.
 *  A clock skew that puts the fetch in the future reads as age 0, never as negative — the same
 *  rule `updatedAgo` already follows. */
export function ageOf(fetchedAt: string | undefined, now: number): number | null {
  if (!fetchedAt) return null
  const t = Date.parse(fetchedAt)
  if (Number.isNaN(t)) return null
  return Math.max(0, now - t)
}

/** Too old to put a number on screen. No reading at all is NOT stale — it's absent, which the
 *  meter already has an honest state for and a different sentence to say about. */
export function isStale(l: PlanLimits | null | undefined, now: number): boolean {
  const age = ageOf(l?.fetchedAt, now)
  return age !== null && age > STALE_MS
}

/** Should we go and ask again? True when there is no reading yet, when its timestamp is
 *  unusable, or when it has aged out of FRESH_MS. Callers gate this on the window being VISIBLE:
 *  a meter nobody can see must not spawn a subprocess, which is why this is a predicate rather
 *  than a timer of its own. */
export function needsRevalidate(l: PlanLimits | null | undefined, now: number): boolean {
  const age = ageOf(l?.fetchedAt, now)
  return age === null || age >= FRESH_MS
}

// --- The reset clause, and the window it names --------------------------------------------
//
// THE REAL BUG the freshness work above only half-covered: a session read at 12% whose own
// recorded clause says `resets Jul 30 at 9:59am`, displayed after 10am. That is not a stale
// number, it is a number we can prove is false — from data already in hand — sitting next to the
// evidence. Age says "possibly out of date"; an elapsed reset says "this window no longer exists".
//
// PARSING IS THE DELICATE PART, and the rule from `planlimits.rs` `resets_in` stands: the clause
// is carried VERBATIM for display, because it is already localised and already carries its zone,
// and re-deriving a local time from an already-localised one is how you print the wrong hour.
// So nothing below ever feeds display. It parses into a SEPARATE optional instant used only to
// answer "has this window ended?", and every form it cannot pin exactly returns `null` — which
// falls back to the plain age thresholds rather than guessing.
//
// Why this lives here and not in the Rust cache: the live phrasing is
// `Jul 30 at 8:30pm (America/Guayaquil)`, an IANA zone, and `planlimits.rs` is deliberately
// std-only (`now_iso` hand-rolls civil-from-days precisely because there is no date crate).
// Converting a zoned wall-clock without a timezone database is the wrong-hour mistake in a new
// costume. The renderer has `Intl`, which has the whole database. See the RESULT for what the
// Rust side does instead.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** A zone's UTC offset (ms) at a given instant, via `Intl`. Throws for an unknown zone, which is
 *  the caller's signal to give up rather than guess. */
function zoneOffsetAt(utcMs: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs))
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
  // `hour12: false` renders midnight as 24 in some ICU versions; normalise or the offset is a day out.
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'))
  return asUtc - utcMs
}

/** The instant at which `y-mo-d h:mi` (wall clock) occurs in `zone`. Two passes, because the
 *  offset depends on the very instant being solved for — one pass is wrong across a DST edge. */
function wallClockInZone(y: number, mo: number, d: number, h: number, mi: number, zone: string): number {
  let guess = Date.UTC(y, mo, d, h, mi)
  for (let i = 0; i < 2; i++) guess = Date.UTC(y, mo, d, h, mi) - zoneOffsetAt(guess, zone)
  return guess
}

/** When the window named by a reset clause ends, in epoch ms — or `null` when the phrasing cannot
 *  be pinned to an instant.
 *
 *  Parsed (every form below is either live output or already in `planlimits.rs`'s tests):
 *    `Jul 30 at 8:30pm (America/Guayaquil)`   absolute, zoned      ← what the CLI emits today
 *    `Jul 30 at 2am (America/Guayaquil)`      absolute, zoned, whole hour
 *    `Jul 30 at 2am`                          absolute, no zone → read as local
 *    `in 3 hours` · `in 45 min` · `in 4 hr 55 min`   relative to when we FETCHED it
 *
 *  Deliberately NOT parsed — each would need a guess, and a wrong guess here blanks a number the
 *  user can see is fine: `tomorrow`, `Sunday`, `Aug 4` (no time of day), `later`.
 *
 *  `fetchedAt` anchors both the relative forms and the YEAR, which the clause never carries: a
 *  reset dated before the fetch has rolled into next year. */
export function resetAtOf(clause: string | null | undefined, fetchedAt: string | undefined): number | null {
  if (!clause) return null
  const anchor = fetchedAt ? Date.parse(fetchedAt) : NaN
  if (Number.isNaN(anchor)) return null
  const text = clause.trim().toLowerCase()

  // Relative: "in 3 hours", "in 4 hr 55 min", "in 45 minutes".
  const rel = /^in\s+(?:(\d+)\s*(?:h|hr|hrs|hour|hours))?\s*(?:(\d+)\s*(?:m|min|mins|minute|minutes))?\s*$/.exec(text)
  if (rel && (rel[1] || rel[2])) {
    return anchor + (Number(rel[1] ?? 0) * 3_600_000) + (Number(rel[2] ?? 0) * 60_000)
  }

  // Absolute: "<Mon> <D> at <H>[:<MM>]<am|pm>" with an optional "(Zone)".
  const abs = /^([a-z]{3})[a-z]*\s+(\d{1,2})\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:\(([^)]+)\))?\s*$/.exec(text)
  if (!abs) return null
  const mo = MONTHS.indexOf(abs[1])
  if (mo < 0) return null
  const day = Number(abs[2])
  let hour = Number(abs[3]) % 12
  if (abs[5] === 'pm') hour += 12
  const minute = Number(abs[4] ?? 0)
  const zone = abs[6]?.trim()

  const at = new Date(anchor)
  const build = (year: number) => {
    if (!zone) return new Date(year, mo, day, hour, minute).getTime()
    try { return wallClockInZone(year, mo, day, hour, minute, zone) } catch { return NaN }
  }
  // No year in the clause. Take the fetch year, and roll forward if that lands meaningfully
  // BEFORE the fetch — a reset is always ahead of the reading that reported it. The day of slack
  // absorbs the zone difference between our anchor and the clause's own zone.
  let ms = build(at.getFullYear())
  if (Number.isNaN(ms)) return null
  if (ms < anchor - 86_400_000) ms = build(at.getFullYear() + 1)
  return Number.isNaN(ms) ? null : ms
}

/** Has the SESSION window this reading describes already ended?
 *
 *  Session only, on purpose. It is the row that rolls over on a scale of hours, so it is the one
 *  that goes visibly wrong within a single sitting; the weekly rows drift by a percent or two and
 *  are re-fetched long before their boundary matters. `null` clause, unparseable phrasing or a
 *  missing timestamp all read as "not known to have ended" — never as ended. */
export function windowEnded(l: PlanLimits | null | undefined, now: number): boolean {
  const at = resetAtOf(l?.sessionResets, l?.fetchedAt)
  return at !== null && now >= at
}

/** How much the meter can stand behind, in one word. The three states are genuinely different
 *  decisions, and collapsing them is what let a known-false number look authoritative:
 *
 *   · `current` — show the numbers.
 *   · `aging`   — past the TTL and not yet re-read. Still show them; say how old they are, louder
 *                 than a whisper, because they are the only warning available.
 *   · `expired` — the window ended, or nothing has landed in an hour. Do NOT show a percentage. */
export type Freshness = 'current' | 'aging' | 'expired'

export function freshnessOf(l: PlanLimits | null | undefined, now: number): Freshness {
  if (windowEnded(l, now) || isStale(l, now)) return 'expired'
  const age = ageOf(l?.fetchedAt, now)
  return age !== null && age >= FRESH_MS ? 'aging' : 'current'
}

/** What the meter should draw a number from: data that exists AND is recent enough to mean it.
 *  Everything on screen keys off this rather than `hasData`, so a reading whose window has closed
 *  degrades to the same "we don't know" the app already renders for an account with no limits. */
export function hasCurrentData(l: PlanLimits | null | undefined, now: number): boolean {
  return hasData(l) && freshnessOf(l, now) !== 'expired'
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

/** The limit the ring should draw: the HIGHEST of the rows, not the session.
 *
 *  The rail has room for exactly one arc, and the honest thing for one arc to say is "how close
 *  are you to being stopped". That is whichever limit is furthest along — you hit the weekly cap
 *  at 100% of the week no matter how fresh the session is. Drawing session alone reported a
 *  quarter full while the week sat at 65%, which is not a partial truth but the wrong one: the
 *  glance disagreed with the popover it summarises.
 *
 *  Ties keep `limitRows` order (session, week, per-model) — the narrower window resets sooner, so
 *  it is the more actionable of two equal numbers. `null` when nothing is readable. */
export function bindingLimit(l: PlanLimits | null | undefined): { key: string; label: string; pct: number } | null {
  let top: { key: string; label: string; pct: number } | null = null
  for (const row of limitRows(l)) {
    if (!top || row.pct > top.pct) top = { key: row.key, label: row.label, pct: row.pct }
  }
  return top
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
