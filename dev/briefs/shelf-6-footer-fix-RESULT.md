# RESULT — Sidebar footer fix

Both moves landed. The old stats row is gone entirely; its two halves went to the two places
they each belong.

---

## What changed — `components/sidebar/Sidebar.tsx`

### `N active` moved up, inside the lane scroller

It now renders as the last child of the AGENTS scroller, right under the last lane row
(`data-sidebar-active-count`, 9.5 mono muted, `padding: 8px 8px 2px`). Being *inside* the
scroller is the point: it hugs the lanes it counts and scrolls with them, rather than sitting
at the foot of the sidebar where it read as a property of the whole app.

**It is silent at zero.** Every lane above already says `idle`, so `0 active` would be a row
that only ever restates what's on screen. Same habit as the queued chip, the activity label and
ALSO ACTIVE.

It still counts **this project only** — the note in the step-4 brief about not "helpfully"
making it count everything now matters more, not less: it used to sit 40px under ALSO ACTIVE
(which shows *other* projects' counts), and moving it up puts it beside the lanes it's actually
about. That's the whole reason the placement was wrong.

### `Operator v{version}` + the update button moved into the icon row

Now the last items in the footer icon row (`data-sidebar-identity`), right-aligned, with the
update arrow after them. The label dropped the word "Operator" and reads `v0.10.1` — the row is
the app's own row, so the name was restating its context.

**Making it fit needed measurement, not guesswork.** First attempt put it in with
`marginLeft: auto` and it silently **wrapped to a second line** — with `flex-wrap: wrap`, an
item that doesn't fit wraps *before* it shrinks, so `flexShrink` never got a chance. Two fixes:

1. `flex: '1 1 0'` instead of `marginLeft: auto`. At flex-basis 0 the item can't overflow its
   line, so it claims the leftover and ellipsises instead of wrapping. Structural, not tuned.
2. Room made by spacing, not squashing: icon padding `3px 5px → 3px 3px`, row gap `8 → 5`, row
   padding `12 → 6`. The 14px icon box is untouched.

Measured in the browser rather than estimated: **58px available**, and `v0.10.1` needs 49,
`v0.10.11` needs 56. Both fit whole. The mock's `v0.8.8-mock` (92px) ellipsises to `v0.8.8-mo…`
— a fixture-only string, and it's a fair demonstration that the guard works.

## Decisions

1. **Silent at zero** for the active count (above).
2. **`v0.10.1`, not `Operator v0.10.1`.** The word cost ~50px in a row with 58 to spare, and it
   names the app inside the app. The full string is still in the element's `title`.
3. **The update arrow keeps its place after the version and never shrinks.** With an update
   pending, the version yields ~19px and may ellipsise — correct priority: the arrow is the
   actionable thing, and the version is recoverable from the tooltip.
4. `flexWrap` stayed on the row. It's still the right guard for a seventh *icon*; it was only
   the wrong mechanism for the version, which now can't reach it.

## Verification

- `npm test` — **271 passed / 34 files**.
- `npm run build` — clean.
- `node dev/drive-sidebar.mjs` — passes, including the standing assertion that **nothing
  overflows the 220px sidebar** (the one that catches a sliced icon), plus two new checks I
  added for exactly what went wrong here:
  - `active count sits with the lanes, above ALSO ACTIVE: true`
  - `identity shares the icon row (never wrapped below it): true` — compares vertical centres,
    so a future regression to `marginLeft: auto` fails loudly instead of looking like the old
    layout.
- `node dev/drive-navigation.mjs`, `drive-sidebar-ambient.mjs`, `drive-project-rail.mjs` — pass.
- `node dev/drive-theme-pass.mjs` — 6 palettes, **0 below floor**. No new ink: both moved
  elements kept `--fg-muted` at 9.5 mono, already the most-probed combination in the app.

Footer crop: `/tmp/operator-shots/footer-crop.png` — lanes → `3 active` → ALSO ACTIVE →
`+ ▫ ▫ ▫ ▫ ☀  v0.8.8-mo…` on one line.

## One thing worth your eye

With a short roster the sidebar now has a large empty gap between `3 active` and the ALSO
ACTIVE section — the count hugs the lanes at the top, and the section is pinned to the bottom.
That is what "directly under the lanes" asks for, and it reads fine in the screenshot, but it
does make the emptiness more conspicuous than when the stats row sat at the very bottom. If
you'd rather the count floated down with the section instead, that's a one-line move (out of
the scroller, above `<AmbientProjects>`) — say the word.
