# RESULT — the Agents hub moved to the rail foot

Moved, not duplicated. It exists in exactly one place now, and **the gallery case works** — which was
the point.

---

## What moved

- **Out of `Sidebar.tsx`**: the robot button, plus its `onOpenAgents` prop *and* `agentsViewActive`,
  which had no other reader. No dead props left; `tsc`'s `noUnusedLocals` confirmed it rather than my
  reading it.
- **Into `ProjectRail`'s foot** via the existing `RailFootButton` — icon-only at 26px inside the 44px
  strip, same glyph, `aria-label="Agents"` so the accessible name isn't a glyph, and `title` carrying
  the description. `WebkitAppRegion: 'no-drag'` comes free: the foot group already sets it, and only
  the rail's *top* padding is the `DragRegion`.

**Order: Agents, then the seam, then All projects / Open folder** — one hairline, not two. The brief
asked for Agents first and separated by the existing seam treatment; putting it *above* the existing
hairline does both without inventing a divider, and the two navigation verbs stay adjacent as a pair.
Above it is the tile scroller, which is its own boundary.

## One thing I added beyond the brief

`RailFootButton` gained an optional `active`. Agents is a *view*, unlike the two navigation verbs, so
it can be the current one — and a control that opens the view you're already looking at with no
indication was worse than the sidebar button it replaced (that one did show state). Background-only
plus `aria-current`, matching the foot's existing hover treatment; no border colour change on a
radiused element.

## The gallery case, verified rather than assumed

`drive-project-rail.mjs` group 7:

```
7 agents control in the rail foot: {"name":"Agents","title":"Agents (every agent across your projects)","current":null}
7 …and it exists exactly ONCE in the app: 1
7 AT THE GALLERY — sidebar gone but the agents button is present: {"sidebarRows":0,"agents":true}
7 it opens the hub FROM THE GALLERY: Agents
7 and reads as the current view: true
```

`sidebarRows: 0` is the sidebar genuinely being gone, with the button still there and still working.

## Verification

- `npm test` — 362 passed / 39 files. `npm run build` — clean.
- `drive-project-rail.mjs` — groups 1–6 unchanged and green (membership, identity colour/acronym
  stability, all three sidebar states, the shelved-but-live case, the virgin app), plus the new group 7.
- `drive-sidebar.mjs` — green: rows, no folder groups, no overflow, the footer's `3 active` still hugs
  the lanes and the version still shares the icon row without wrapping. A five-icon row became four,
  untouched otherwise.
- `drive-theme-pass.mjs` — 6 palettes, **0 below floor**. It needed one fix: the sweep reached the hub
  by the sidebar button's old `title`, so it now clicks `[data-rail-agents]`. Hub ink unchanged
  (title 12.99–17.15, subtitle 4.16–7.03).

## What else in that footer is misplaced for the same reason

You asked. Two candidates, one clear:

1. **"Global settings" (`~/.claude`) — clearly misplaced, same reason exactly.** It is not scoped to
   the project either; it opens the user's global Claude config. It sits one icon away from *this
   project's* `.claude` button, which is the genuinely project-scoped one, and the pair is
   distinguishable only by tooltip. Global belongs beside Agents at the rail foot, or in Preferences.
2. **Theme toggle — arguable, and I'd leave it.** App-wide, so by the letter it's misplaced; but it's
   an ambient toggle rather than a destination, and it's muscle-memory where it is. Moving it buys
   consistency at the cost of a control people already find.

That leaves the footer as: this project's `.claude`, Preferences, theme — which is a coherent set. I
did **not** move either; flagging, per the brief's question.
