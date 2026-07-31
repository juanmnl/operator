# Brief — stop fixing the rail by eye. Assert the invariant, then fix what it reports.

User, fourth time on this strip: **"these are not centered correctly, nor balanced."**

## Why this keeps recurring

Four passes, each correct about what it measured and blind to something else:

1. **foot balance** — sized the ring and the seam gaps; measured *drawn extent* between items.
2. **padding** — matched the column's air to the sides; measured the *box*, 8 = (44−28)/2.
3. **optical axis** — found the pip overhangs bottom-right only while the ring overhangs all four;
   measured *painted* boxes across ring/pip states.
4. **centring + seam** — found `border-box` ate a pixel, made the seam a shadow; measured painted
   centre x against the rail's outer centre, reported 22.00 = 22.00 on all six palettes.

Every one of those reported success. The user still sees it wrong. **So the measurements are not
covering what the eye is judging** — and another targeted fix will just be a fifth partial view.

## What I want instead

**A single assertion over every element in the rail**, run by a driver, printing one table. Then
fix whatever it reports — and the fix is finished when the table is clean, not when it looks right.

Measure the **painted** bounding box — `getBoundingClientRect` excludes a `box-shadow` and an
overflowing absolutely-positioned child, which is precisely how passes 1–3 measured 28×28 and found
perfect symmetry. Use whatever gets you real painted extents.

**Every element, not a sample:**

- a project tile in **all four states**: plain, pipped, ringed, ringed+pipped
- each foot control's **glyph** — robot, the usage ring, grid, plus — not its 26×26 button box
- the usage ring specifically: it is an SVG stroke, and its painted extent is not its viewBox
- the foot's horizontal seam
- the project badge/acronym text, if it paints outside its box

**Assert two things:**

1. **Horizontal:** every element's painted centre x is identical, and equals the rail's outer
   centre (22 of 44). Report each as a delta, not a pass/fail.
2. **Vertical:** the painted gaps between consecutive items follow a stated rhythm. The foot has
   four controls, a seam and two group boundaries; say what the intended rhythm is and show the
   measured gaps against it.

## Then fix

Whatever the table says. My guesses, worth nothing against a measurement: the glyphs are different
painted widths inside identical 26×26 boxes (a robot is wider than a plus), so *box*-centred is not
*ink*-centred; and the usage ring's stroke may not be concentric with its button.

**If the table comes back clean**, that is a real and important result — it would mean the defect is
something measurement doesn't capture (e.g. the strip's background against the sidebar, or the tile
being top-heavy in a tall empty column) and we should stop attacking it as alignment. Say so plainly
rather than adjusting something to look busy.

## Constraints

- Rail stays 44 outer; tile 28×28; ring a `box-shadow`; seam an `inset` shadow at the established
  mix. Don't undo passes 1–4 — they were each right about their own axis.
- The driver must be re-runnable: this is the fourth pass, and there will be a fifth.
- All six palettes for anything ink-related.

## Verify

- The table itself is the deliverable. Before and after.
- `npm test`, `npm run build` clean.

## Where to work

`main` is at `32616ea`. Commit in your own worktree; I'll merge forward. Do not touch
`/tmp/claude-501/merge-main`.

## Output

`dev/briefs/rail-assert-the-invariant-RESULT.md`: the full table before and after, what the
assertion covers, what it found, what you changed — or, if it came back clean, why you believe the
remaining complaint is not alignment. Then one OPERATOR-REPLY line.
