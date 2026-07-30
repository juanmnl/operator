# Brief — channel timestamps render UTC, not local time

User: **"the timestamp in conversations is way off, look at my mac time."** Confirmed, with an
exact cause. macOS menu bar read **Thu 30 Jul 5:12 PM**; the channel's newest entry read **22:10**.
Exactly **+5:00** — the machine is `America/Guayaquil` (UTC−5), so the feed is showing raw UTC.

## Cause — a string slice, not a date conversion

Three places slice the ISO timestamp instead of converting it. A slice takes the UTC digits
verbatim and cannot apply an offset:

| file:line | code | shows |
|---|---|---|
| `ProjectChannel.tsx:224` | `{entry.at.slice(11, 16)}` | UTC **time** on every channel row |
| `project-channel.ts:202` | `const day = e.at.slice(0, 10)` | UTC **date** for the day divider |
| `DispatchLog.tsx:54` | `d.at.slice(11, 16)` | UTC time again, different surface |

**The correct pattern already exists in this codebase** — `SessionActivityView.tsx`,
`SessionInfoBar.tsx` and `CanvasConversation.tsx` all use `toLocaleTimeString` /
`toLocaleDateString`. This is an inconsistency, not a missing capability. Match what they do
rather than inventing a fourth convention; if they disagree with each other, pick one, say which,
and note the others.

## The day divider is the worse half, and it hasn't shown itself yet

`groupByDay` buckets on the UTC date. At UTC−5, **every local time from 19:00 onward has
tomorrow's UTC date.** So from 7pm local the separator reads a day ahead and the evening's
messages file under tomorrow — then "today" appears to start at 19:00.

In the user's screenshot (15:36–17:10 local) every entry is still 30 Jul in UTC too, so the
divider looks fine. **It will break in under two hours.** Fix it in the same pass; don't ship the
time fix alone and let the date bug surface tonight looking like a new regression.

Note this also silently affects grouping/continuation logic that keys off day buckets — check
whether `isContinuation` or the new day-separator work from `channel-view-improvement-RESULT.md`
depends on `day` being correct. **Design has uncommitted work in `project-channel.ts`** (the
`paused` tone fix and `CONTINUATION_WINDOW_MS`); re-read the file immediately before editing.

## Constraints

- **Store UTC, display local.** `at` stays an ISO/UTC string on disk — do not rewrite persisted
  timestamps, and do not change what gets written. This is a rendering fix only.
- Don't hardcode a timezone or an offset. Use the platform's local conversion so it follows the
  user's machine, including DST.
- Keep the display terse — `HH:MM`, 24h, matching today's look. Don't take this as licence to
  restyle the row; Design has just reworked that feed.
- `fontVariantNumeric: 'tabular-nums'` is already set on that span; keep it so times stay aligned.

## Verify

- `npm test` — cover `groupByDay` with an entry whose **UTC date and local date differ** (e.g.
  `2026-07-31T01:30:00Z` at UTC−5 must bucket as 30 Jul). That test is the whole point; a test
  written in UTC will pass against the bug. Inject the zone rather than depending on the runner's.
- `npm run build` clean.
- **Acceptance**: open the channel and compare a row against the macOS menu-bar clock — they must
  match to the minute. Check the same for `DispatchLog`.
- Check the day divider after 19:00 local (or with a faked clock) and confirm it still says today.

## Output

`dev/briefs/channel-timestamps-utc-RESULT.md`: what you converted with, the day-bucket fix and its
test, whether anything else in the app renders a raw ISO slice, and confirmation that nothing
persisted changed. Then one OPERATOR-REPLY line.
