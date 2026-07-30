// Rendering an instant in the user's own time.
//
// STORE UTC, DISPLAY LOCAL. Everything on disk stays an ISO/UTC string — nothing here writes, and
// nothing here changes what gets written. This is the display half, and it exists because three
// surfaces were doing it with a string slice:
//
//   entry.at.slice(11, 16)   →  the UTC digits, verbatim
//   e.at.slice(0, 10)        →  the UTC calendar date
//
// A slice cannot apply an offset, so at UTC−5 the channel read 22:10 while the menu bar read
// 17:10. The date slice is the worse half and hides until evening: from 19:00 local onward every
// instant already carries TOMORROW's UTC date, so the day separator jumps a day and the evening's
// messages file under it.
//
// `timeZone` is a parameter on both helpers purely so tests can pin a zone. A test written in the
// runner's own zone passes against the bug — if the runner is UTC, a slice and a conversion agree.

/** `HH:MM`, 24-hour, in local time.
 *
 *  `hourCycle: 'h23'` rather than the `hour12: false` the rest of the app passes: they differ at
 *  midnight, where `hour12: false` renders `24:00` under some ICU versions. Same platform
 *  conversion, same DST handling, one fewer edge case.
 *
 *  This is a deliberate small divergence from `SessionInfoBar` / `SessionActivityView` /
 *  `CanvasConversation`, which pass only `{hour, minute}` and therefore follow the locale into
 *  12-hour time ("05:12 PM"). Those surfaces are prose-adjacent and can afford it; the channel and
 *  the dispatch log are dense mono columns whose current look is 24h, and the brief keeps it. */
export function localTime(iso: string, timeZone?: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(timeZone ? { timeZone } : {}) })
}

/** The LOCAL calendar date as `YYYY-MM-DD` — the bucket key for day separators.
 *
 *  Assembled from `formatToParts` rather than a locale that happens to format this way (`en-CA`),
 *  so the key is the same string on every machine regardless of locale data. It stays sortable and
 *  comparable, which is what the grouping below relies on. */
export function localDay(iso: string, timeZone?: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit', ...(timeZone ? { timeZone } : {}),
  }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}
