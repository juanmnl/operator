# Brief — ProjectRail tiles: crammed, and not reorderable

Component: `src/renderer/components/sidebar/ProjectRail.tsx` (the tile column, `ProjectTile`).
User verdict: **"projects are a bit crammed up in there, and i should be able to reorder them."**

**Do this AFTER the foot-balance pass** (`dev/briefs/rail-foot-balance.md`). Same file — one
owner, one sequence. Do not start it in parallel with anything else touching `ProjectRail.tsx`.

## What's on screen (user screenshot, dark)

Three tiles stacked in the 44px rail: `WE` (current — accent ring), `OP`, `EE`. Each has a
status pip overlapping its bottom-right corner. They nearly touch; the pips sit in the gap and
collide with the tile below.

## Part 1 — the cramming

Today (`ProjectRail.tsx:77-96`): the scroller is `gap: 7`, `padding: '4px 0'`; each tile is
**28×28**, `borderRadius: 7`, with a **9px `StatusWave` pip at `right: -3, bottom: -3`**.

The pip protrudes 3px below the tile, so the real visual gap between one tile's pip and the
next tile is **7 − 3 = 4px**, not 7 — and directly under the pip it's less. In the screenshot
the `OP` pip visibly crowds the `EE` tile. The ring on the current tile
(`boxShadow: '0 0 0 2px var(--accent)'`) eats another 2px on both sides, so the *current* tile
is effectively 32px in a 28px rhythm and its neighbours look pinched against it.

Fix the rhythm so tiles breathe: the gap must be measured between what's actually DRAWN
(tile + ring + protruding pip), not between the 28px boxes. Rail width stays 44.

## Part 2 — drag to reorder

Today the rail order is **computed, not chosen**: `byActivityThenRecency` (`project-shelf.ts:28`)
— live-first, then `lastActiveAt` desc. So the rail **repaints itself as work happens**. That is
exactly the failure the file's own header comment warns about for *colour* ("a rail coloured by
what a project was doing would repaint itself as work happened and teach you nothing") — and it's
currently true of *position*, which is the stronger memory channel. This is the real reason the
user wants to grab them.

Build user-chosen order, persisted:

- Drag a tile to reorder. `reorderByIds` in `src/renderer/lib/reorder.ts` already exists and is
  what the roster board and sidebar session reorder use — **use it, don't write a second one.**
- **Persist it.** Note the open defect: *sidebar reorder is not persisted across restart.* Do not
  reproduce that here. The order needs a durable field on `Project` (in `~/.operator/projects.json`)
  and must survive a restart. If you fix the sidebar's persistence with the same mechanism, say so.
- Decide and DOCUMENT what happens to the automatic sort once a user order exists. My call:
  a user-set order wins outright and the rail stops resorting itself; live-ness stays visible
  through the pip, which is what the pip is for. Argue if you disagree — but "sometimes it
  resorts" is not an option.
- New projects and projects that appear because something went live in them need a defined
  slot. Say where.
- The rail's membership rule is unchanged: live > 0, plus the current project.

Interaction rules from house feedback:
- **The tile IS the handle.** No separate grip glyph — at 28px in a 44px rail there is no room
  for one, and a hover-only grip must never reserve space at rest.
- A draggable element breaks any `closest('[draggable]')` click predicate — check nothing
  upstream relies on that, and make sure a plain click still OPENS the project (`onOpen`) and
  right-click/hover-card still work.
- The hover card is the shared hardened `useHoverCard`. Dismiss it on drag start, the way the
  right-click accent picker already does in `SidebarRail.tsx:228`.
- Drop indicator: a hairline between tiles. **Never a coloured left-border marker stripe.**

## Constraints (house rules)

- Rail width stays 44. Tile hit target must not shrink below 28×28.
- **SHAPE IS THE GRAMMAR** — a project is a rounded square, a session is a circle. Never break
  that (read `ProjectRail.tsx:12-36` before touching tile geometry).
- Tile colour stays hashed from project id (`projectAccent`), never from status.
- Motion rule: only `running`/`compacting` animate. Do not add a drag animation that makes idle
  tiles move on their own.
- Transparent badges, no solid accent fills for state, no browser focus rings, CSS vars only.
- No colour-CHANGING border on a radiused element (WKWebView freeze). The "you are here" ring is
  a `box-shadow` for exactly this reason — keep it one.
- Never stack opacity on `--fg-muted`.

## Verify

- `npm run build` clean; `npm test` (extend `reorder`/`project-shelf` tests for the new order).
- **Restart-persistence is the acceptance test**: reorder, quit, relaunch, order holds. Verify
  against `~/.operator/projects.json` — read the durable state, not the UI.
- Eyeball on the dev server at **port 1433** (already live — do NOT start another). Check the
  rail in all three states it exists in: sidebar expanded, sidebar collapsed, and the gallery.
- `node dev/drive-theme-pass.mjs` — all 6 palettes.

## Output

Write `dev/briefs/rail-tiles-density-reorder-RESULT.md`: the new spacing numbers (drawn extents,
not box sizes), where the order is persisted and its migration story for existing projects, what
happens to the automatic sort, and what you did NOT do. Then one OPERATOR-REPLY line.
