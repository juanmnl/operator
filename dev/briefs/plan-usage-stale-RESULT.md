# Usage meter shows numbers known to be wrong — RESULT

**Status: done. `tsc` clean · `npm run build` clean · **495** JS tests · **122** Rust tests (117 → 122).**

## Poll interval, and why

| | |
|---|---|
| **Tick** | 30s — and it spawns **nothing**. It moves a clock, so "Updated 4m ago" counts up instead of freezing at whatever React last drew, and so the predicate below gets asked at all. |
| **Refetch** | only when `age ≥ FRESH_MS`, and `FRESH_MS` **is** the backend's `TTL` (5 min). Polling faster would burn a subprocess for a value the cache would hand back unchanged, which is exactly what you warned about. |
| **Only while visible** | the interval is torn down on `visibilitychange → hidden` and re-armed on return. A meter nobody can see must not spawn `claude -p "/usage"`. |
| **Also on** | window `focus`, `visibilitychange → visible`, and **popover open** — the moments the number is actually read. All three go through the same age check first, so they cost nothing on a warm meter. |
| **`inFlight`** | respected; untouched. |

## How an elapsed window is detected

`resetAtOf(clause, fetchedAt)` parses the clause into a **separate optional instant** used only for
the expiry check. **Nothing below ever feeds display** — the verbatim rule from `resets_in` stands,
for the reason its comment gives.

**Parsed:**

| phrasing | notes |
|---|---|
| `Jul 30 at 8:30pm (America/Guayaquil)` | what the CLI emits today — I sampled it live |
| `Jul 30 at 2am (America/Guayaquil)` | whole hour |
| `Aug 4 at 12:59am (…)` | the 12am/12pm modulo trap has its own test |
| `Jul 30 at 2am` | no zone → read as local |
| `in 3 hours` · `in 45 minutes` · `in 4 hr 55 min` | anchored to `fetchedAt` |

**Declined — every one returns `null` and falls back to the plain age thresholds:** `tomorrow`,
`Sunday`, `Aug 4` (no time of day), `later`, `in 3` (no unit), `in a while` (no number), empty, a
missing/unparseable `fetchedAt`, and **an unknown timezone** (`Mars/Olympus`) — which declines
rather than silently using local. Every one of those is a fixture already in `planlimits.rs`'s
tests, plus the live phrasing.

The year is never in the clause, so it's inferred from `fetchedAt` and rolled forward when the
date lands meaningfully before the fetch (tested across a Dec→Jan boundary). Zoned wall-clock
conversion is two-pass, because the offset depends on the instant being solved for — one pass is
wrong across a DST edge. Tests pass under `TZ=America/Guayaquil`, `Europe/Berlin`, `UTC`, and the
machine default.

## Where the parse lives — a deliberate split, and it's a capability boundary

**Renderer owns the zoned forms. Rust owns the relative ones.**

`planlimits.rs` is std-only on purpose (`now_iso` hand-rolls civil-from-days precisely because
there is no date crate). Converting `Jul 30 at 8:30pm (America/Guayaquil)` without a timezone
database means guessing an offset — the "print the wrong hour" mistake `resets_in` exists to
avoid, moved one layer down where nobody would see it. The renderer has `Intl`, which has the
whole database, and it is the only place the number is ever displayed.

So the Rust side got what it can do **exactly**:

- `resets_at_ms` parses the relative forms and declines everything else;
- `window_ended` says whether the session window has closed;
- **both TTL checks in `fetch()` now require `c.at.elapsed() < TTL && !window_ended(…)`** — a cache
  entry past its own reset boundary is a miss, independently of the 5 minutes, exactly as asked;
- `Cache` carries `fetched_ms`, because `Instant` cannot be compared to a wall-clock reset time.

And the renderer closes the hole Rust can't reach for today's phrasing: on detecting an ended
window it calls `planLimits(force: true)`, which bypasses the TTL entirely. Net effect — **a
provably-closed window is never served and never displayed**, for every phrasing either side can
read.

## Making staleness legible — three states, not two

"Updated 1h ago" was honest and the quietest thing in the popover. Now:

| | ring | rows | says |
|---|---|---|---|
| **current** | arc | shown | footer only |
| **aging** (past TTL, window still open) | arc | **still shown** — they're drifting, not false | amber `12m ago — re-reading…` **above the rows** |
| **expired** (window closed, or nothing in an hour) | **empty track + dot** | **none** | *"That window closed — the reading was taken 1h ago and its own reset time has since passed. Re-reading…"* |

`hasCurrentData` keys everything — ring, arc, hover line, rows, aria-label — off the same verdict,
so a ring drawing 12% under a popover saying the reading is dead is structurally impossible.

## Before / after

**The true side-by-side isn't available to me** and I won't pretend otherwise: my code is in an
unmerged worktree, so the running app is the *old* build — opening its popover would only
re-photograph the bug. What I have instead:

**Ground truth, sampled live at 17:13 (`claude -p "/usage"`):**
```
Current session: 26% used · resets Jul 30 at 8:30pm (America/Guayaquil)
Current week (all models): 47% used · resets Aug 4 at 12:59am (America/Guayaquil)
```

**The three states, driven through the real renderer** (`node dev/drive-plan-freshness.mjs`,
screenshots `/tmp/operator-shots/usage-{fresh,aging,expired}.png`):
```
--- fresh ---    freshness: current | ring "66" | arc true  | 3 rows
--- aging ---    freshness: aging   | ring "66" | arc true  | 3 rows + "12m ago — re-reading…"
--- expired ---  freshness: expired | ring ""   | arc false | 0 rows
                 "That window closed — the reading was taken 1h ago and its own reset time has
                  since passed. Re-reading…"

fresh   shows its numbers            : true
aging   STILL shows them, and warns  : true
expired shows NO percentage          : true
expired SAYS the window closed       : true
```

**Behaviour change on your exact report** — a 12% session whose clause says `resets … 9:59am`,
read after 10am: *before* the ring drew 12% indefinitely; *after* the ring empties, the rows
disappear, the popover names the closed window, and a forced refetch is already in flight.

**A fixture bug the driver caught, worth recording.** The mock's reset clause was the hardcoded
`Jul 30 at 2am (America/Guayaquil)` — fine until the meter learned to *read* it, at which point
every fixture rendered as a closed window because 2am was hours past. Hardcoded future dates rot
into the past overnight and then validate nothing; the fixtures now generate genuinely-future
clauses in the CLI's own phrasing.

## The two judgement calls

**Vocabulary — recommended, not done.** You're right that "Current week" / "Current week (Fable)"
reads as two periods rather than two scopes; the CLI gives us `Current week (all models)` and
`Current week (Fable)`, so Claude's "All models" / "Fable" is available. But doing it properly
means a two-level structure in the popover (a *Current week* heading with scoped rows under it),
which is layout in a file Design is actively holding. Recommending it to Design rather than
half-doing it here.

**Relative vs absolute — resolved by not reformatting.** The failure wasn't that the time was
absolute; it was that a *passed* time looked authoritative. That is now impossible: an elapsed
reset removes the number entirely and says why. Rendering "resets in 4h 12m" would also be
inconsistent, since I can only pin some phrasings — the rows that failed to parse would keep the
absolute string and the popover would speak two dialects. The verbatim rule stands; the staleness
is what became legible.

## What I left alone

- **Everything Design owns in `PlanMeter.tsx`**: `R`, `STROKE`, the 22px svg, the 26px button, the
  popover's box styling and position — all untouched (verified against `HEAD`; Design's
  `rail-foot-balance` work hasn't landed in this worktree yet, so there was nothing to merge
  around). My diff is the hook, the freshness logic, and the popover's text.
- **`resets_in` and every display string** — carried verbatim, as designed.
- **The weekly rows' expiry.** `windowEnded` checks the **session** clause only: it's the row that
  rolls on a scale of hours, so it's the one that goes wrong inside a single sitting. The weekly
  rows drift a percent or two and are re-read long before their boundary. Extending it is a
  one-line change if you disagree.

## Not verified

**Leaving the app open across a real session boundary.** Your session resets at 8:30pm; I'd be
guessing to claim I watched it roll. The rollover path is covered by unit tests on both sides and
by the `expired` fixture end-to-end, but the live soak is genuinely outstanding — and it's the one
thing that would confirm the forced refetch fires against a real backend at the moment it matters.
