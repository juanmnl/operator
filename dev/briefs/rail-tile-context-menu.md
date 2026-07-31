# Brief — the rail tile has no right-click, and it is the only project surface that doesn't

**Lane: Code.** Write your result to `dev/briefs/rail-tile-context-menu-RESULT.md`.

## The complaint

"I still don't have any right click commands." Right-clicking a project tile in the persistent
rail does nothing at all. It is dead in a way the user reads as the feature being missing from the
app, because the rail is the surface they are looking at most of the time.

## What is actually there today

Eight `onContextMenu` handlers exist. None is on `ProjectRail`:

| surface | file | right-click does |
|---|---|---|
| gallery card | `ProjectGallery.tsx:389` | opens the card menu (`onMenu(true)`) |
| archived gallery card | `ProjectGallery.tsx:922` | opens a shorter menu |
| session row | `SessionItem.tsx:143` | accent picker |
| roster rows | `RosterPanel.tsx:544,1032` | accent picker |
| old `SidebarRail` | `SidebarRail.tsx:101,227` | gallery / menu |
| **`ProjectRail` tile** | `ProjectRail.tsx` | **nothing — zero handlers** |

`ProjectRail` was built as the new always-present strip and inherited the tile grammar, the hover
card and the pip, but never the menu its predecessor had.

## What I want

A context menu on `ProjectTile`, reusing what already exists rather than inventing a second menu
system. `ProjectGallery.tsx:618-644` is the precedent and `CardMenuItem` (`:1030`) is the shape.
Take the items that are meaningful for a project you are *inside or beside*, and leave the rest to
the gallery card — the rail is a switcher, not a project admin surface. My reading of that split:

- **Reveal in Finder** and **Project Claude files** — carry straight over, same handlers.
- **Rename** / **Edit description** — belong to the card, where there is room to edit in place.
  Do not reproduce inline editing in a 44px strip.
- **Close project · end N agents** — the one destructive-ish verb that belongs here, because the
  rail is where you notice a project is still live. It already has a confirm in the gallery; keep
  the guard proportional and do not invent a lighter one.
- **Forget project** — my instinct is NO on the rail. Argue it if you disagree, but if it goes in
  it keeps `danger: true` and `confirm: true`, and it does not sit adjacent to a navigation item.

Argue the final set in your result file. A short menu that is obviously right beats a complete one.

## Traps, all of them real and all of them already paid for once

1. **The hover card will stick over the menu.** `ProjectTile` uses the shared `useHoverCard`
   (`lib/use-hover-card`). Opening a menu must dismiss the card — otherwise the card floats above
   the menu and does not clear when the cursor moves into it. See the hover-card hardening notes;
   the shared hook covers rows-moving-under-the-cursor and cursor-leaves-the-window, NOT this.
2. **Use the existing dismissal contract.** `PopMenu` grew a real one in `3354fb3` (and
   `PlanMeter` was migrated onto `lib/use-dismiss` for exactly this reason). Do not hand-roll a
   third Escape + outside-mousedown pair.
3. **Two verbs must never share a glyph or a gesture.** Left-click on a tile ENTERS the project.
   Right-click must not do anything a mis-aimed left-click could be confused with.
4. **`e.preventDefault()`** or you get the native menu on top of yours.
5. **Positioning**: the rail is 44px at the window's left edge and its scroller clips overflow —
   the menu cannot be a child of the tile. `AccentPicker` is rendered up in `DashboardView`
   (outside the rail and sidebar scrollers) precisely because of this; follow that.
6. Do not disturb `CONTENT_INSET_R` or the tile geometry — `dev/drive-rail-invariant.mjs` asserts
   painted centres to ±0.75px across six palettes and it currently passes. Re-run it when done.

## Done means

`drive-rail-invariant.mjs` still CLEAN on all six palettes, `npm test` green, `npx tsc --noEmit`
clean, and a driver (extend `dev/drive-project-rail.mjs`) that asserts: the menu opens on
right-click, Escape closes it, an outside click closes it, the hover card is gone while it is open,
and the destructive item still requires its confirm.
