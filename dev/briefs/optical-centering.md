# Brief — initials aren't optically centred in their discs. Same bug as the rail, different element.

User: **"avatars are not optically centered on their circle."** Screenshot: a column of `OP`
avatars in the channel; the letters sit high and slightly left inside the disc.

## The mechanism

`ProjectChannel.tsx:694-702`:

```ts
display: 'grid', placeItems: 'center',
fontSize: 9.5, fontWeight: 600, letterSpacing: '0.02em', lineHeight: 1,
```

`place-items: center` centres the **line box**, not the **ink**. Two separate offsets fall out:

1. **Vertical.** With `line-height: 1` the box is one em tall and the baseline sits ~0.8em down,
   so capitals occupy roughly 0.1em–0.8em and their optical centre is ~0.45em — about **0.05em
   above** the box centre. At 9.5px that is ~0.5px of "sits high", which is exactly what a 26px
   disc at 2× makes visible.
2. **Horizontal.** `letter-spacing` adds its space **after the last glyph too**, so the painted
   ink is pushed left by half the tracking. Small, and it compounds with the vertical offset into
   "not quite centred" rather than a single obvious error.

**This is the same class as the rail**: box-centred is not ink-centred. Fix it as a rule, not as a
nudge on one component.

## Scope — do all of them, not just the channel

`place-items: center` with text inside a disc or tile appears in at least: `ProjectChannel`,
`ProjectRail` (project tiles — the acronym), `Sidebar`, `ProjectGallery`, `TaskQueue`,
`ChatComposer`, `PlanMeter`, `MoodboardPanel`. **Audit them**; some are icons (unaffected — an SVG
has no baseline problem) and some are text (affected). Report which were which.

Prefer **one shared treatment** over eight nudges. Whether that is a small component, a utility, or
a documented pair of properties is yours — but if the next person adds a ninth disc, they should
get correct centring for free rather than reproducing this.

## How to fix it — measure, don't eyeball

The standard remedies:

- **Vertical**: compensate the cap-height offset. Options include a small `transform: translateY`,
  a padding pair, or `align-items` against a measured baseline. Whatever you use, derive it from
  the font's actual metrics rather than a magic number — **and note that the metrics change when
  Archivo actually loads** (see `dev/briefs/landing-look-and-feel.md`: the app declares Archivo
  and never loads it, so it is rendering in `system-ui` today). A constant tuned against the
  fallback will be wrong the moment the real font lands. Coordinate with that brief or state the
  dependency.
- **Horizontal**: cancel the trailing letter-space — the conventional fix is a negative
  `margin-right` equal to the tracking, or `text-indent` of the same amount.

**Measure the painted ink**, not the element box. `getBoundingClientRect` on the span gives you the
line box, which is the thing that is already "centred" — that is why this passed unnoticed. Compare
the ink's bounding box centre to the disc's centre and report the delta before and after, for one
and two-letter initials.

## Constraints

- Don't change disc sizes, colours, or the accent tint/hairline treatment — this is centring only.
- Two-letter and one-letter initials must both come out right; `initialOf` can produce either.
- Keep `laneTextColor` where it is used; keep the channel's deliberate plain-`--fg` choice for
  avatar letters.

## Verify

- Ink-centre delta before/after for one- and two-letter initials, on the channel avatar and on a
  rail project tile at minimum.
- Screenshot a column of avatars at 4× and look at it — the complaint is optical, and the number
  is the check, not the goal.
- `npm test`, `npm run build` clean.

## Where to work

`main` is at `32616ea`. Commit in your own worktree; I'll merge forward. Do not touch
`/tmp/claude-501/merge-main`.

## Output

`dev/briefs/optical-centering-RESULT.md`: the mechanism as you measured it, the shared treatment,
the audit of every `place-items: center` site with text vs icon, the before/after deltas, and how
you handled the Archivo dependency. Then one OPERATOR-REPLY line.
