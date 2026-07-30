# Brief — the bottom-left corner: rail foot + sidebar footer, one balance pass

Two user complaints, ONE seam. Do them together — they are adjacent strips that currently
disagree with each other, and fixing either alone will make the mismatch worse.

- **(a)** `/tmp/operator-shots/sidebar-rail-balance.png` — "these buttons are not balanced"
  (the 44px `ProjectRail` foot: robot, usage ring, hairline, grid, plus)
- **(b)** a second screenshot showing rail + sidebar footer together — "the footer of the
  sidenav needs balancing" (the row: folder · globe · gear · sun ……… `v0.11.2`)

Read both as OPTICAL complaints, not spec bugs.

---

# Part A — ProjectRail foot

## What's actually there today (`src/renderer/components/sidebar/ProjectRail.tsx:106-152`)

The foot is a column, `gap: 4`, `padding: '8px 0 10px'`:

| # | control | box | ink |
|---|---------|-----|-----|
| 1 | Agents (robot) | `RailFootButton` 26×26, `borderRadius: 7` | 13×13 svg, `strokeWidth 1.2`, `--fg-muted` |
| 2 | Usage (`PlanMeter`) | 26×26 button (`PlanMeter.tsx:64`) | **22×22 svg ring** |
| 3 | hairline | `width: 22, height: 1, margin: '5px 0'` | `--border` |
| 4 | All projects (grid) | 26×26 | 13×13 svg, 4 rects |
| 5 | Open folder (plus) | 26×26 | 13×13 svg |

## The imbalance to fix

1. **Ink mass is wildly uneven.** Every hit box is 26×26, but the ring draws at **22px** while the
   glyphs draw at **13px** — the ring is ~2.9× the optical area of its neighbours and reads as a
   different tier of control. In the screenshot it's the loudest thing in the strip, and it's the
   one control that is passive telemetry rather than a verb.
2. **The gaps read unevenly** because the hairline's `margin: 5px 0` composes with the `gap: 4`
   (→ 9px above and below the seam vs 4px elsewhere), while the ring's visual bulk eats its own
   4px gap so robot↔ring looks tighter than grid↔plus.
3. **Glyph weight differs across the icons themselves**: the grid's four filled-looking rects at
   1.2 stroke read heavier than the plus's two strokes, so even the two navigation verbs don't
   match each other.
4. Bottom padding is 10 vs top 8 — asymmetric for no reason once the ring is tamed.

## What I want back for Part A

Not a redesign of the rail. A **rhythm pass on the foot** so the five things read as one
family with a deliberate hierarchy: the two navigation verbs matched to each other, Agents
matched to them, and the usage ring recessive enough to be telemetry rather than the hero.
Your call on *how* — shrinking the ring to sit inside the same optical box as the glyphs is the
obvious first move, but if you think the ring belongs at a different size or the seam belongs
somewhere else, argue it.

---

# Part B — Sidebar footer row

`src/renderer/components/sidebar/Sidebar.tsx:459-560`. A flex row, `padding: '6px 6px 10px'`,
`gap: 5`, `flexWrap: 'wrap'`: four icon buttons (folder / globe / gear / sun), then the version
string at `flex: 1 1 0`.

Each button: `padding: '3px 4px'`, `borderRadius: 8`, 14×14 svg, viewBox 16, stroke 1.1
(gear is viewBox 24 at stroke 1.6 for the same ratio).

## The imbalance to fix

1. **The two strips don't share a baseline.** In screenshot (b) the rail's `+` and the sidebar
   footer's icon row sit at visibly different heights, and the rail's foot padding
   (`8px 0 10px`) is not the sidebar footer's (`6px 6px 10px`). They are 1px apart across a
   border and read as two unrelated toolbars glued together. Pick ONE baseline for the corner.
2. **The version string is stranded.** `flex: 1 1 0` pushes `v0.11.2` to the far right of a
   220px row while the four icons huddle at the far left — a big dead gap in the middle with
   nothing to justify it. The comment explains why it's `flex: 1 1 0` and not `marginLeft: auto`
   (wrap behaviour) — respect that reasoning, but the *result* is still unbalanced. Solve the
   optics without reintroducing the wrap bug.
3. **Icon hit boxes are tiny and uneven vs the rail's.** `3px 4px` around a 14px glyph = a
   ~20×22 non-square target, next to the rail's clean 26×26. Non-square `borderRadius: 8`
   buttons in a row of four read as slightly different widths.
4. 🔴 **`opacity: 0.85` is stacked on `var(--fg-muted)` strokes** on all four buttons
   (lines 489, 504, 523, 538) — that is the documented *never stack opacity on `--fg-muted`*
   violation; the token IS the recede, and this lands invisible on the three light palettes.
   Fix it by token, and re-measure. The disabled folder button's `opacity: 0.35` is a separate
   case — disabled ink needs its own treatment, not a third opacity.
5. Active state is `--overlay-subtle` background on some buttons, nothing on the theme toggle —
   inconsistent within the same row.

## What I want back for Part B

The footer row balanced *as the sidebar's bottom edge*, aligned with the rail's foot so the
bottom-left corner reads as one deliberate corner rather than two strips that happen to touch.
Version string placement is yours to argue — anchored, or given something to sit beside.

---

## Constraints for both parts (house rules, non-negotiable):
- Rail width stays 44; sidebar width stays 220. Hit targets must not shrink; the rail's 26×26
  is already at the floor, and the footer's ~20×22 is *below* it.
- The footer row must still FIT inside 220px with `flexWrap` intact — read the comment at
  `Sidebar.tsx:446-458` before changing any size or gap there. It documents a real bug (the
  seventh icon getting sliced, and the version wrapping to its own line). Don't reintroduce it.
- No solid accent fills for state; transparent badges only. No browser focus rings.
- **No colour-CHANGING border on a border-radius element** (WKWebView re-rasterizes → freeze).
  Both rail components already dodge this — keep it that way.
- **Never stack opacity on `--fg-muted`**; the token IS the recede. (This is finding B4.)
- `SidebarRail.tsx`'s bottom "+" is a *different*, accent-filled 34×34 button in the 64px
  collapsed inner rail (`SidebarRail.tsx:175-194`). Check whether your new baseline makes it
  disagree with the other two strips; fix it if so, leave it if not.

## Verify before you call it done

- `npm run build` clean.
- Eyeball it against the dev server on **port 1433** (already live — do NOT start another).
  Check BOTH sidebar states: expanded (footer row visible) and collapsed (64px `SidebarRail`).
- All 6 palettes: `node dev/drive-theme-pass.mjs` — contrast table must not regress, and B4's
  fix should IMPROVE the three light palettes. Quote the before/after numbers.

## Output

Write `dev/briefs/rail-foot-balance-RESULT.md`: what you changed and why, before/after of the
size/gap tables above, the contrast numbers for B4, and anything you decided NOT to do.
Then post one OPERATOR-REPLY line.
