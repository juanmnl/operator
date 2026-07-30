# RESULT — plan limits, permanently visible

Session and weekly limits are now a ring in the rail foot, beside Agents. No app switching, no
credential reading, no HTTP endpoint — `claude -p "/usage"`, parsed defensively.

---

## The parse shape

`src-tauri/src/planlimits.rs`. Every field `Option`, matched on **shape, not exact strings**:

- a line containing `current session` → session; a line containing `current week` → weekly
- the parenthesised label decides which weekly line it is: something containing `all model` (or no
  label at all) is the overall one, anything else is the per-model one, and **its label is carried,
  never hardcoded** — "Fable" today is not a promise
- the percentage is "digits immediately before the first `%`"; the reset clause is everything after
  the word `resets`, **verbatim**, because the string already carries a localised time *and* its
  timezone
- parsing **stops** at "What's contributing" — those lines carry percentages too (92%, 87%), and
  `usage.rs` already computes that section locally

Out-of-range clamps rather than rejects: a plan reporting 120% has genuinely blown its limit and a
full bar is the honest picture. Only a non-number is a parse failure.

**Every failure yields `None`s plus a `note` that reaches the UI.** An empty meter with no
explanation is indistinguishable from a broken one.

## Real numbers from this machine

```
$ claude -p "/usage"                                    # 1.5s wall clock
Current session: 66% used · resets Jul 30 at 2am (America/Guayaquil)
Current week (all models): 39% used · resets Aug 4 at 1am (America/Guayaquil)
Current week (Fable): 0% used · resets Aug 4 at 1am (America/Guayaquil)
```

Parsed to `session 66 / week 39 / Fable 0`, resets carried verbatim, no note.

## Subprocess behaviour

- **Login shell**, `$SHELL -ilc 'claude -p "/usage"'` — the same resolution `terminal_spawn` uses. A
  bare `Command::new("claude")` from a GUI app doesn't see the user's PATH, and this must not be the
  one place that guesses differently.
- **15s timeout**, polled at 60ms, and the child is **killed** on expiry — not detached.
- **One process at a time** (`FETCHING` mutex). A caller arriving mid-fetch waits and then finds the
  fresh value in the cache rather than spawning a second.
- **5-minute TTL**, `force` for the explicit refresh. **Never polled on a timer, never per render.**
- Runs on a blocking thread (`spawn_blocking`) so the async runtime's workers aren't parked on a
  network round-trip, and **the first read is deferred 1.2s past mount** — app start never waits on
  a subprocess. The meter renders empty and fills in.
- The command **never rejects**: a failure is a `PlanLimits` with no numbers and a note, because the
  meter has to render something honest either way.

## When `/usage` output is unrecognised

Three distinct behaviours, all tested:

| case | result |
|---|---|
| reworded but recognisable (different punctuation/casing/reset phrasing) | parses fine |
| lines found, no percentages in them | `None`s + "the CLI's wording may have changed" |
| nothing recognisable (API billing, empty, garbage) | `None`s + a note quoting the first two lines |

The UI then draws the **track with no arc and a centre dot**, the button carries no percentage, and
the popover prints the note instead of any rows. **Never `0%`.**

## Absent is not zero

This is the distinction the whole feature turns on, and it is enforced in three places rather than
assumed once: `readable()` (only a real number in range is a number — `null`/`undefined`/`NaN` are
absent), `ringDash()` (no data → dash 0, so the arc isn't drawn at all), and `limitRows()` (a limit
this account doesn't have produces no row). A genuine `0%` **is** data — the Fable weekly line is
exactly that — and renders as a row with an empty bar. Driver group 7 asserts the popover contains
no `0%` anywhere when the reading failed.

## Placement

Rail foot: **Agents · Usage · seam · All projects · Open folder** — the two cross-project *views*
together, then the two navigation verbs. Verified live at the gallery with nothing scoped, which is
the case the placement exists for; the data needs no session and no project.

**One surface only** — nothing was added to the session actions footer. If the rail ever feels too
far while working inside a session, that's a placement call for you, not a second button.

The ring is 22px, `--accent` → `--status-compacting` past 75% → `--color-error` past 90%, **no
transition** (motion in this app means "busy"). The popover is a popover, not a dialog: Escape
closes and returns focus, outside click closes, no focus trap, no full-screen overlay. Bars are 4px,
`borderRadius: 2`, **border-width 0** — their fill changes colour, and a colour-changing border on a
radiused element re-rasterizes in WKWebView. `tabular-nums` on every percentage.

**No cost figures anywhere.** Percentages and reset times only.

## Verification

- `cargo test` — **117 passed** (was 102): 15 new, covering the real sample, the contributing-section
  trap, a missing model line, rewording, an unlabelled weekly line, >100 clamping, empty stdout, a
  non-subscription account, six garbage inputs, verbatim reset text, the ISO stamp, **the cache
  serving five reads without respawning**, and staleness past the TTL.
- `npm test` — **413 passed / 42 files**; 19 new in `plan-limits.test.ts`, most of them about
  absent-vs-zero and the threshold boundaries (75 and 90 inclusive).
- `npm run build` — clean.
- **`dev/drive-plan-limits.mjs`, 7 groups, all green:**

```
1 ring swept to the SESSION figure: 66 · one deferred read, not a poll
2 rows: session 66%/66% · week 39%/39% · "Current week (Fable)" 0%/0% · resets verbatim w/ timezone
2 no border on a colour-changing bar: 0px
3 Escape closes it · focus returns to the button
4 Refresh skipped the cache: [false, true]
5 still there at the GALLERY with nothing scoped
6 tones at 93/78/0: danger / warn / normal — three visibly different fills
7 no reading → no percentage, no arc, 0 rows, and NO "0%" anywhere; the note explains why
```

- **`drive-theme-pass` — 6 palettes, 0 below floor.** Percentage 11.84–17.58, reset line 3.80–7.38.
  The threshold fills stay separable on every palette: **min pairwise ΔRGB 84** on the tightest
  light one (Mission Control light: `#c0392b` / `#b8860b` / `#0ca678`), 261 on 1984 dark.
- One probe of mine was wrong first: it asserted `border-style: none` on the bar and got `solid`.
  Tailwind's preflight sets `border: 0 solid` on **every** element, so style is always "solid" and
  only the **width** says whether anything is painted. Checking style would have failed forever on a
  correct bar.

## Fixture

`dev/mock-bridge.ts` gained `planLimits`, shape-exact with the command, values verbatim from this
machine. `?usage=high` puts it past both thresholds; `?usage=none` is the account the CLI can't
report on — the case that must render as absent rather than 0%.

## Worth knowing

The 5-minute TTL means the ring can be up to 5 minutes stale, and the footer says so (`Updated 3m
ago`) rather than implying it's live. Given a read costs a process spawn plus a round-trip, and
session limits move in minutes, that seemed the right trade — but the number is one constant
(`TTL` in `planlimits.rs`) if you'd rather it were tighter.
