# Brief — the rail tiles don't share an optical axis. The pip's overhang is ONE-SIDED.

Third pass. User, on the merged build with two tiles (`OP` plain+pipped, `OL` ringed+pipped):
**"still completely unbalanced."** They are right, and the previous fix could not have solved it.

## The false assumption — it's written in the code

`ProjectRail.tsx`, the scroller comment you added:

> *"Both ornaments overhang the box by the same 2px (the ring is `0 0 0 2px`; the pip is offset
> -3 but its StatusWave svg carries a pixel of its own padding, so it PAINTS 2 past the edge).
> **So a ringed or pipped tile clears 6 on every side** and a plain one clears 8, uniformly."*

The magnitude is right. **"On every side" is not.**

- **Ring** — `boxShadow: '0 0 0 2px'` → overhangs all four sides. Symmetric.
- **Pip** — `position: absolute; right: -3; bottom: -3` → overhangs **bottom and right ONLY**.
  Nothing is added to the left or the top.

The tile wrapper (`data-rail-slot`) has `borderTop`/`borderBottom` of 2px and **no left/right
borders**, so horizontal centring is `justifyContent: center` on the 28px box inside 44px.

## What that actually produces

```
tile state            left   right    top   bottom
plain                   8      8       8      8
pipped        (OP)      8      6       8      6     ← asymmetric
ringed+pipped (OL)      6      6       6      6     ← symmetric
```

**The real defect is not any single tile's padding — it is that tiles in the same column are
centred on different axes.** `OP`'s painted mass sits ~1px left of `OL`'s. A vertical strip whose
items don't share a centre line reads as broken no matter how correct each item's own numbers are,
and that is what the user is looking at. It also means the *current* tile shifts sideways as the
ring appears and disappears.

Vertically the same one-sidedness makes a pipped tile sit 8 above / 6 below.

## What I want

**Every tile centred on the same axis, in every combination of ring and pip.** The box is centred
today; the *painted mass* is not, and the painted mass is what the eye aligns.

Your call on mechanism — argue it. Options I can see, not ranked:

- Reserve the ornament's extent symmetrically on the wrapper (pad all four sides by the overhang)
  so the box centres inside a slot that already accounts for the pip.
- Make the pip's overhang symmetric about the corner — e.g. seat it so it paints equally inside
  and outside — which fixes the axis at the source rather than compensating downstream.
- Optically centre against the drawn extent rather than the box.

**Do not solve it by removing the pip's overhang entirely** unless you can show the corner pip
still reads as a corner pip; overlapping the tile's edge is what makes it read as attached to that
tile rather than floating beside it.

Whatever you choose, the invariant to state in the comment — and to test — is: **a tile's painted
centre is independent of its ring and pip state.**

## Constraints

- Rail stays 44; tile stays 28×28; ring stays a `box-shadow`; pip stays a `StatusWave`.
- The wrapper's 2px top/bottom borders are the drag drop-line and must stay constant-width.
- Shape vocabulary and the motion rule unchanged.

## Verify — this is the part that failed twice

Measure the **painted** bounding box (not the 28px box, not `getBoundingClientRect` on the tile
element, which excludes a box-shadow and an overflowing absolute child) for all four states:
plain, pipped, ringed, ringed+pipped. Assert **the centre x is identical across all four**, and
report the four sets of clearances.

Two tiles in different states, stacked, is the case the user screenshotted — put exactly that in
the driver and look at it.

`npm test`, `npm run build` clean.

## Where to work

Your branch is merged into `main` (`8b40454`). Make this a **new commit in your own worktree**
(`~/.operator/worktrees/operator-1cf818`); I'll merge it forward. Do not edit
`/tmp/claude-501/merge-main`.

## Output

`dev/briefs/rail-tile-optical-axis-RESULT.md`: the mechanism, the four measured states with centre
x, and the corrected comment replacing the "on every side" claim. Then one OPERATOR-REPLY line.
