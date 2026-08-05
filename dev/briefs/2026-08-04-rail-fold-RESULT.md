# RESULT — Rail: the fold is gone, the rail scrolls

Branch `operator/ac9328`, on `8d41a80`. Two files: `src/renderer/components/sidebar/ProjectRail.tsx`
(the fix) and `dev/drive-rail-fold.mjs` (new — the harness that proves it).

## Did a fold survive? No.

**No cap, at either width.** Every live agent renders; the scroller that was already there
(`overflowY: 'auto'`) is the overflow behaviour, exactly as the brief's point 1 and the user's
"i rather view all the agents, and the whole rail to scroll if needed."

A space-derived cap was considered and rejected, and the brief's own escape hatch ("when in doubt,
prefer the simple version") is not the whole reason — there are two concrete ones:

1. **There is no honest number to measure against at 264.** A member row there is a `SessionItem`,
   whose height is not a constant. Any budget would have been an *estimated* row height, which is
   the same class of thing as the `FOLD = 4` being removed: a guess wearing a measurement's
   clothes. This file's whole comment culture is against that.
2. **A cap computed from rendered height oscillates.** Folding shrinks the group, the next measure
   sees it fitting, it unfolds, it overflows again. Avoiding that needs a natural-height model —
   i.e. back to (1).

Because no fold survives, there is no `+N` to expand, and the second half of the brief resolves by
deletion rather than by rework: **the control that called `onOpenProject` no longer exists.** The
two-verbs-one-glyph trap is closed by removing the glyph, not by re-teaching it a verb. If a
measured fold is ever wanted, expand-in-place is the design it should ship with — that requirement
stands, it just has nothing to attach to today.

## What changed in `ProjectRail.tsx`

- **`const FOLD = 4` deleted** (was :246), and with it `shownLive` / `folded` (:304-305). Both
  render paths — `RailOrb` collapsed, `MemberRow` expanded — now map `live` directly.
- **The `+N` button deleted** (was :445-459), including `data-rail-fold`. Nothing in `src`, `dev`
  or the tests referenced that attribute (re-checked, matching the brief).
- Comments left in place of both, stating why the cap is gone and why the `+N` is not coming back
  as an expander. Untouched: the scroll-into-view effect, `position: relative` on the scroller,
  the member column's geometry, `MEMBER_GAP`, the `+ Start an agent` row.

Nothing else in the file moved. No refactors.

## Verification

`npm test` — **603 passed / 53 files**, the brief's baseline exactly. `npm run build` (`tsc &&
vite build`) — **clean**. (`node_modules` was absent in this worktree; `npm install` first.)

### New harness: `dev/drive-rail-fold.mjs`

The shipped fixtures could not see this bug: `drive-rail-invariant.mjs` gives every synthetic
project exactly **one** live agent, so no fold case ever rendered. The new driver seeds several
agents into one project — a terminal plus a saved session per agent, joined on `terminalId`.

    ./node_modules/.bin/vite --port 1437 --strictPort
    node dev/drive-rail-fold.mjs

All assertions pass on the fix:

```
ok  F1 collapsed (60): fastrack renders 6 of 6 live agents — got 6
ok  F1 collapsed (60): no [data-rail-fold] in the strip — got 0
ok  F2 collapsed (60): six members did not change the open project — control matched
ok  F1 expanded (264): fastrack renders 6 of 6 live agents — got 6
ok  F1 expanded (264): no [data-rail-fold] in the strip — got 0
ok  F2 expanded (264): six members did not change the open project — control matched
ok  F3: all 32 seeded live agents rendered — got 32 (36 in the whole strip)
ok  F3: still no fold under flood — got 0
ok  F3: the rail SCROLLS — scrollHeight 1496 > clientHeight 647
ok  F3: last member reachable — bottom 1482 within content 1496
ok  F4: the open group's own header is IN VIEW — top 117, bottom 141 in 0..647
```

**It fails against the pre-fix source**, which is the check that makes it worth having — the file
was stashed and the driver re-run:

```
FAIL F1 collapsed (60): fastrack renders 6 of 6 live agents — got 4
FAIL F1 collapsed (60): no [data-rail-fold] in the strip — got 1
FAIL F3: all 32 seeded live agents rendered — got 12 (16 in the whole strip)
FAIL F3: still no fold under flood — got 3
```

### One finding worth keeping

Under the flood fixture the OLD code hid **20 of 32 agents** — and the rail scrolled anyway
(`scrollHeight 830 > clientHeight 647`). So the fold was not preventing a scroll; it was hiding
agents *in a strip that scrolled regardless*. The cap bought nothing at any content size, which is
a stronger statement than "there was room in the observed case."

### Against each of the brief's verify bullets

- *5+ live agents with free space shows all, no `+N`* — F1, at 6 agents, both widths. Screenshotted
  at 60 and 264: `S1…S6` in the group, nothing counted away.
- *Enough to overflow: the rail scrolls, no agent unreachable* — F3. 32 seeded agents, 1496px of
  content in a 647px box, and the last member's bottom (1482) lands inside the scrollable range.
- *Clicking `+N` reveals without changing the active project* — moot; no `+N` exists. F2 covers the
  underlying claim instead: rendering six members leaves the open project identical to a
  one-agent-per-project control scene.
- *`npm test` green, `npm run build` clean* — both, above.

### The brief's constraint (scroll-into-view)

**Held, and asserted rather than assumed** — F4. This is the case the constraint was written for: a
group taller than the viewport. With `fastrack` open at 14 live agents, the scroller lands at
`scrollTop 115` and the group's own header sits at y=117–141 inside a 647px box — in view, i.e. it
top-aligns at the name rather than scrolling past it. `position: relative` on the scroller and the
effect's `offsetTop` measurement are untouched.

`MOCK_PORT=1437 node dev/drive-rail-invariant.mjs` — **CLEAN on every palette measured**: axis Δ
0.25, orb Δsize 0.00, foot Δy 0.00, glyph spread 0.50, member pitch 42.0/42.0 spread 0.00, `member
gap 6.0 · group separation 12.0 ok`, 8/8 foot controls. The geometry the strip was tuned to over
four passes is undisturbed.

## Not done

- **No screenshot committed.** Both widths were rendered and inspected (6 orbs at 60, 6 rows at
  264, no `+N` in either); the images are session-scratch, not repo files.
- **Not run in the real app**, only the `dev/mock.html` bridge. The geometry, the counts and the
  scroll behaviour are all renderer-side, so the harness covers them — but "it feels right at your
  real project count" is still a look you may want to take.
