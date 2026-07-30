# Channel timestamps render UTC, not local — RESULT

**Status: done, before the 19:00 deadline. `tsc` clean · `npm run build` clean · 508 tests pass
(495 → 508) · green under `America/Guayaquil`, `Europe/Berlin`, `UTC`, `Pacific/Auckland`.**

## What I converted with

New `src/renderer/lib/local-time.ts` — two helpers, no dependencies, both taking an optional
`timeZone` **for tests only**:

```ts
localTime(iso, tz?)  // "17:10" — toLocaleTimeString, hourCycle: 'h23'
localDay(iso, tz?)   // "2026-07-30" — Intl.DateTimeFormat formatToParts, assembled
```

**On matching the existing convention.** `SessionInfoBar`, `SessionActivityView` and
`CanvasConversation` all agree with each other: `toLocaleTimeString([], {hour, minute})`. I used
the same call and the same platform conversion, with **one deliberate difference**: `hourCycle:
'h23'` instead of letting the locale choose. Passing only `{hour, minute}` follows the locale into
12-hour time — `en-US` renders `05:12 PM` — which would have changed the channel's look from 24h,
against the brief's "keep it terse, `HH:MM`, 24h". `hourCycle: 'h23'` also avoids the `24:00`
midnight rendering some ICU versions produce for `hour12: false`. Those three prose-adjacent
surfaces are left alone; noted here so the divergence is on the record rather than discovered.

`localDay` is assembled from `formatToParts` rather than the `en-CA` trick, so the bucket key is
the same string on every machine regardless of locale data — and stays sortable and comparable,
which the grouping relies on.

## The three sites

| file | before | after |
|---|---|---|
| `ProjectChannel.tsx:224` | `entry.at.slice(11, 16)` | `localTime(entry.at)` |
| `DispatchLog.tsx:54` | `d.at.slice(11, 16)` | `localTime(d.at)` |
| `project-channel.ts:207` | `e.at.slice(0, 10)` | `localDay(e.at, timeZone)` |

`groupByDay(entries, timeZone?)` gained the optional zone purely so the test can pin one.

## The day-bucket fix, and its test

`groupByDay` bucketed on the UTC calendar date. At UTC−5 every instant from **19:00 local** already
carries tomorrow's UTC date, so the evening's messages filed under tomorrow and "today" appeared to
start at 7pm. It looked correct all afternoon, which is why it survived.

The test that matters — an entry whose **UTC date and local date differ**, with the zone injected
rather than inherited from the runner:

```ts
localDay('2026-07-31T01:30:00.000Z', 'America/Guayaquil')  // → '2026-07-30'
```

plus a walk across the whole window that used to misfile (19:00, 22:59, 23:59 → the 30th; 00:00 →
the 31st), the mirror case east of Greenwich where the error runs the other way, month and year
boundaries, and DST (Berlin at +2 in July, +1 in January — a fixed offset gets one wrong).

**One pre-existing test was rewritten, not deleted.** `buckets consecutive days without reordering`
passed a UTC-dated fixture and read the UTC bucket back — precisely the shape the brief warns
about, and it went green over the bug. It now pins `'UTC'` explicitly, keeping what it was actually
for (consecutive days separate, order preserved) while no longer depending on where the runner is.

## Acceptance

Driven through the real renderer with the browser zone set to `America/Guayaquil` and a fixture
carrying two **fixed** evening instants — a driver run in the afternoon would go green over this,
so the fixture straddles the boundary on purpose (`node dev/drive-channel-time.mjs`, screenshot
`/tmp/operator-shots/channel-local-time.png`):

```
day separators : ["2026-07-30"]          ← one divider, the LOCAL day
row times      : ["16:00","20:30"]

for 2026-07-31T01:30:00.000Z at UTC-5:
  machine says  : 20:30 on 2026-07-30
  the SLICE said: 01:30 on 2026-07-31   ← the bug
  rendered time matches the machine : true
  divider stays on the local day    : true
  divider is NOT the UTC date       : true
```

Before, those two rows read `21:00` and `01:30` and sat under **two** dividers, the second reading
`2026-07-31`. The `+5:00` you measured against the menu bar is gone.

`DispatchLog` takes the identical `localTime` helper, so the same fix covers it — I checked the
call site rather than driving that surface separately.

## Anything else rendering a raw ISO slice?

**No.** I swept `src/renderer` and `src/shared` for `.slice(11,16)`, `.slice(0,10)`, `substring(11`
and `substr(11`. The only other hits are `DashboardView.tsx` array slices (`recentProjects`
capped at 10) — not timestamps. The brief's list of three was complete.

## Nothing persisted changed

`at` is still written as an ISO/UTC string, by the same code, in the same place. Nothing in this
change writes a timestamp, rewrites a stored one, or alters what `logDispatch` records — it is
rendering only. `unreadEntries` still compares raw ISO strings, which is correct: those are
instants being ordered, not dates being displayed.

## Grouping / continuation

The brief flagged that day buckets might feed `isContinuation` or the new day-separator work.
**Neither `isContinuation` nor `CONTINUATION_WINDOW_MS` exists in `project-channel.ts` in this
worktree** — Design's uncommitted work hasn't landed here, so there was nothing to merge around and
nothing else keying off `day`. `groupByDay`'s output is consumed in exactly one place
(`ProjectChannel.tsx`'s separator render, which prints `group.day` verbatim). If Design's version
adds a continuation rule that reads `day`, it will now get the local one — which is the correct
input, but worth a glance when the two branches meet.

## What I left alone

Row styling, the separator's look, `fontVariantNumeric: 'tabular-nums'` (kept — times still align),
and the three prose-adjacent surfaces that legitimately use 12-hour locale time.
