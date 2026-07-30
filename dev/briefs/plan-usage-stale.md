# Brief — the usage meter shows numbers that are known to be wrong

Screenshot: `/tmp/operator-shots/usage-mismatch.png` — Operator's Plan-usage popover (left) beside
Claude's own Settings → Usage (right), same machine, same moment.

| | Operator says | Claude says |
|---|---|---|
| Current session | **12% used**, resets Jul 30 at 9:59am | **3% used**, resets in 4 hr 55 min |
| Week / all models | **40% used**, resets Aug 4 at 12:59am | **42% used**, resets Tue 12:59 AM |
| Fable | 0% used | 0% used |
| Freshness | **"Updated 1h ago"** | "Last updated: just now" |

## Root cause — I've traced it, don't re-derive it

**`usePlanLimits` fetches exactly once and never again.** `PlanMeter.tsx:209-212`:

```ts
useEffect(() => {
  const t = setTimeout(() => read(false), 1200)
  return () => clearTimeout(t)
}, [read])
```

One `setTimeout` at mount. No interval, no refetch on window focus, no refetch when the popover
is opened. The backend's 5-minute TTL (`planlimits.rs:24`) is therefore **never exercised** — the
renderer holds its first reading for the entire lifetime of the app process unless the user
clicks Refresh by hand. The app had been open an hour; hence "Updated 1h ago".

That explains both rows, differently, and the difference matters:

- **Week 40 → 42%**: ordinary drift over an hour. Annoying, not alarming.
- **Session 12% → 3%**: the number went **DOWN**, because the session window *rolled over*.
  Operator's own cached string says `resets Jul 30 at 9:59am` — **that time has already passed.**
  So Operator is displaying a percentage from a window that no longer exists, next to a reset
  time it can see is in the past.

**That second one is the real bug.** A cached reading whose own reset time has elapsed is not
stale, it is *known to be false*, and we have everything needed to know that locally.

## The job

1. **Refresh on a schedule.** Add a poll to `usePlanLimits`. The backend TTL is 5 min and it
   spawns `claude -p "/usage"` (a subprocess — see `run_usage`, `planlimits.rs:204`), so do not
   poll faster than the TTL or you just burn processes for cached values. Also refetch when the
   popover is opened and on window focus — those are the moments the number is actually being
   read. Respect the existing `inFlight` guard.
2. **Treat an elapsed reset as expired.** If `session_resets` / `week_resets` parses to a time in
   the past, the cached percentage must not be presented as current — refetch, and until fresh
   data lands say so rather than showing a number you know is wrong. Same on the Rust side:
   `fetch()` should treat a cache entry past its own reset boundary as a miss, independently of
   the 5-minute TTL.
   ⚠️ Parsing that string is the delicate part. `resets_in` (`planlimits.rs:68-73`) deliberately
   keeps the clause **verbatim** ("the string already carries a [timezone]") and the tests cover
   wildly varying phrasings — `"Jul 30 at 2am (America/Guayaquil)"`, `"tomorrow"`,
   `"in 3 hours"`. **Do not re-format the display string.** Parse defensively into a separate
   optional field for the expiry check, and when you cannot parse it, fall back to the plain TTL
   rather than guessing. Add tests for every phrasing already in `planlimits.rs` tests.
3. **Make staleness legible.** "Updated 1h ago" is honest but it's the quietest thing in the
   popover, and it's the only warning the numbers are wrong. Surface it properly when the data is
   past TTL — and distinguish "a bit old" from "we know this window ended".

## Worth aligning while you're here (judgement call, argue if you disagree)

- **Vocabulary.** We say "Current week" / "Current week (Fable)"; Claude says "All models" /
  "Fable". Ours reads as if the second row were a different time period rather than a different
  scope. Claude's is clearer — but our string comes from parsing Claude's own `/usage` output
  (`"Current week (all models)"`, `planlimits.rs:303`), so check what we're actually given before
  inventing labels.
- **Relative vs absolute reset.** Claude shows the session as "Resets in 4 hr 55 min"; we show an
  absolute time which, in this very screenshot, had already passed and looked authoritative. A
  relative rendering degrades far better. The verbatim-string rule above is what stands in the
  way — resolve that tension deliberately, don't just break the rule.

## File collision — read this before editing

**Design is actively working in `PlanMeter.tsx` right now** (`dev/briefs/rail-foot-balance.md` —
it's resizing the 22px ring at `PlanMeter.tsx:64,73` because it optically outweighs its
neighbours). You own the **data layer only**: the `usePlanLimits` hook (`:190-215`),
`planlimits.rs`, and the popover's freshness/label text. **Do not touch the button geometry, the
ring svg, or the popover's box styling.** Re-read the file immediately before you edit it — it
will likely have changed under you — and keep your diff tight so both changes merge cleanly.

## Verify

- `cargo test` inside `src-tauri/` (there are real fixtures in `planlimits.rs` tests — extend
  them, including a cache entry whose reset time has passed).
- `npm test`, `npm run build` clean.
- **Acceptance is the side-by-side**: open Operator's popover and Claude's Settings → Usage at the
  same moment and confirm the session and week percentages agree. Paste both. That comparison is
  the whole point of this task — a green test suite proves nothing here.
- Leave the app open past a session reset boundary if you can, and confirm the meter follows the
  rollover instead of holding the old window's number.

## Output

Write `dev/briefs/plan-usage-stale-RESULT.md`: the poll interval you chose and why, how you detect
an elapsed window, which reset phrasings you can and cannot parse, the before/after side-by-side,
and what you left alone. Then one OPERATOR-REPLY line.
