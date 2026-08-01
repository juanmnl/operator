# Result — the rail tile has a right-click menu, and it is the gallery's menu, not a second one

Brief: `dev/briefs/rail-tile-context-menu.md`. Lane: Code.

## What landed

Right-clicking a `ProjectTile` in `ProjectRail` opens the same menu the gallery card opens, with a
shorter item list. Four files:

| file | change |
|---|---|
| `src/renderer/components/CardMenu.tsx` | **new.** `CardMenu` + `CardMenuItem` + `CONFIRM_MS`, lifted verbatim out of `ProjectGallery`, plus two additions: an `at` prop (fixed positioning + viewport clamp) and an optional `title`. Its hand-rolled Escape + outside-mousedown pair is **gone**, replaced by `lib/use-dismiss`. |
| `src/renderer/components/dashboard/ProjectGallery.tsx` | imports it; local copy deleted (−78 lines). Both `⋯` buttons gained `data-popmenu-trigger` + `aria-expanded`. |
| `src/renderer/components/sidebar/ProjectRail.tsx` | `ProjectTile` gained `onContextMenu` / `onMenu` / `menuOpen`; `ProjectRail` gained `onTileMenu` + `menuProjectId`. |
| `src/renderer/views/DashboardView.tsx` | `railMenu` state, `railMenuItems`, and the `<CardMenu at=… />` render beside `AccentPicker`. |

`dev/drive-project-rail.mjs` gained section 8.

## The item set, argued

```
  operator                       ← title (see below)
  Reveal in Finder
  Project Claude files
  ─────────────────────────
  Close project · end 3 agents   ← confirm-gated
```

- **Reveal in Finder** and **Project Claude files** — carried straight over with the same handlers
  (`window.operator.revealPath`, `handleOpenFolderPrefs`), both `disabled` when `!project.path`,
  exactly as on the card. They act on the folder, need no room, and are the two things you want
  about a project you are working *beside*.

- **Rename / Edit description** — left on the card, as briefed. Not reproduced.

- **Close project · end N agents** — in, and it is the one item that belongs here more than
  there. Rail membership *is* liveness: a tile is on screen because something is running in that
  project (or because it's the current one). The rail is therefore the only surface where "this is
  still live" is the reason you're looking at it.

- **Forget project** — **NO**, and I'll argue it rather than just assert it. The brief's instinct
  is right for a reason stronger than crowding: rail membership is liveness, so the rail is the
  one surface where Forget would sit next to a *running agent*. It destroys roster, tasks and
  notes for a project that is working right now. The gallery is ⌘⇧O away, and Forget is already
  there — last, separated, danger-toned, confirm-gated. Adding it here would be a second, less
  guarded route to the same irreversible thing on the strip you *navigate* by.

- **No "Open project" item.** Trap 3: left-click on a tile enters the project. Nothing in this
  menu navigates, so a mis-aimed left-click cannot be confused with any menu verb.

### One thing I added that the brief didn't ask for: a title row

The tile carries a two-letter acronym and nothing else, and trap 1 requires the hover card —
which is where the full name lives — to be **dismissed** the moment the menu opens. Without a
header the menu is therefore unattributed at the exact moment it offers to end three agents.
`PopMenu` already carries a title, so this is house pattern rather than invention. It is **not**
uppercased, unlike the app's other section labels: `fastrack` / `Fastrack-landing` / `FastTrack`
are precisely the projects this row exists to separate, and case is one of the few things that
separates them.

### One correction to the brief

> "It already has a confirm in the gallery; keep the guard proportional and do not invent a
> lighter one."

The gallery's Close item has **no** `confirm: true` — its only guard is the Undo toast
`closeProject` raises afterwards. So there was no confirm to carry over. I went **stronger**, not
lighter: the rail's Close is `confirm: true`, so the first click arms and relabels it
(`… — click again`, 2500ms) and the second fires, and the Undo toast still follows. Two clicks
from a mis-aimed right-click on the strip you navigate by, for a verb that kills ptys that cannot
be brought back.

It is deliberately **not** `danger: true`. Red is the gallery's mark for Forget; the same verb
must not read as two different weights on two surfaces.

## The traps, each one and what was done about it

1. **The hover card sticking over the menu — real, and it happened on the first build.** The card
   is `position: fixed` at the tile's *right edge* — exactly where the menu opens — and
   right-clicking never moves the cursor off the tile, so no `mouseleave` ever arrives. The shared
   hook hardens against a row moving under the cursor and against the cursor leaving the *window*;
   a menu opening over a stationary anchor is neither. `onContextMenu` calls `hoverCard.dismiss()`
   (the escape hatch `use-hover-card` already exports for this) and `setHover(false)`. The driver
   hovers the tile *first*, on purpose, and asserts the card is gone once the menu is up.

2. **The existing dismissal contract.** No third pair was hand-rolled — but there already *was*
   one, inside `CardMenu` itself (`document.addEventListener('mousedown' | 'keydown')`). Moving the
   component out was the moment to kill it, so `CardMenu` now uses `useDismiss`, which is the whole
   reason that hook exists. Consequences, all verified: outside **pointer**-down (not click) closes,
   Escape closes and returns focus, focus leaving closes, and scroll closes — the last one matters
   here because the rail's tile column is a scroller and the menu is anchored to a tile inside it.
   The gallery's two `⋯` buttons needed `data-popmenu-trigger`, or the toggle would close on the
   way down and reopen on the click; `drive-gallery-cards`, `drive-gallery-shelf` and
   `drive-close-project` all confirm the ⋯ path still works, arm-and-confirm included.

3. **Two verbs never share a gesture.** Left-click enters, right-click opens the menu, and the
   menu contains no navigation. `e.stopPropagation()` on the contextmenu so nothing above sees it.
   Asserted: the ringed (current) tile is unchanged after a right-click.

4. **`e.preventDefault()`** — done, plus the same on the panel itself, so a right-click *inside*
   the menu doesn't raise the native one on top of it (`AccentPicker` does the same).

5. **Positioning.** The menu is **not** a child of the tile. `ProjectRail` reports an anchor and
   nothing else; `DashboardView` holds `railMenu` and renders the `CardMenu`, in the same block as
   `AccentPicker` and for the same reason. Anchor = the tile's `top` and `right + 8` — the same
   offset the hover card uses, so the menu lands where the card the user was just reading was.
   `at` mode clamps to the viewport once measured (AccentPicker's clamp, same 8px margin), so a
   tile near the bottom of a full rail can't open its menu off-screen. Measured: the menu spans
   x 48..213, i.e. it clears the 44px rail rather than being clipped at it.

6. **`CONTENT_INSET_R` and the tile geometry are untouched.** The only style change on the tile is
   the background mix, which now reads `hover || menuOpen` instead of `hover` — a tint, not a box.
   `drive-rail-invariant.mjs` re-run on all six palettes below.

## Verification

### `npx tsc --noEmit`

Clean. (This worktree had no `node_modules`; I symlinked the root repo's, per the `.gitignore`
note that exists for exactly that.)

### `npm test`

`45 files · 569 tests · all passing.`

### `THEMES=all node dev/drive-rail-invariant.mjs`

```
PALETTE     WORST |Δaxis| GLYPH SPREAD   RHYTHM
mc·D        0.75px        0.50px         ok
mc·L        0.75px        0.50px         ok
pink·D      0.75px        0.50px         ok
pink·L      0.75px        0.50px         ok
1984·D      0.75px        0.50px         ok
1984·L      0.75px        0.50px         ok

CLEAN on every palette measured
```

Tile pitch constant at 40.0 across every pair, plain gaps 12.0, ring pairs exactly 2px tighter,
foot pairs 18/18 around a seam with 22 above and below. Unchanged, as it should be — nothing here
moved a box.

### `node dev/drive-project-rail.mjs` — section 8, the new one

```
8 card up before the right-click: "operator1 needs you" (expect a project name)
8 right-click opens a menu: {"title":"operator","items":["Reveal in Finder","Project Claude files","Close project · end 3 agents"],"left":48,"top":56,"right":213}
8 the HOVER CARD is gone while it is open: null (expect null)
8 it escapes the 44px rail (not clipped): true (menu spans 48..213)
8 it does NOT reproduce the card's editors: true
8 …and does NOT carry Forget: true
8 right-click did NOT also navigate (trap 3): true (current project still operator-b7bf23af)
8 Escape closes it: true
8 reopened: true
8 an outside click closes it: true
8 destructive item: "Close project · end 3 agents"
8 first click ARMS it, does not fire: "Close project · end 3 agents — click again"
8 …and nothing was closed yet: true
8 an armed item disarms with the menu: true
```

Sections 1–7 are unchanged from before this work.

### Gallery drivers (the shared-component regression risk)

- `drive-gallery-cards.mjs` — clean; the ⋯ menu still opens on click and still reaches the
  description editor.
- `drive-gallery-shelf.mjs` — clean, including §8's Forget arm → confirm → undo through the
  now-shared `CardMenu`.
- `drive-close-project.mjs` — clean, and byte-identical to a `git stash` baseline run.

## Deliberately left out / known

- **Not added to `SidebarRail`.** It already has its own two `onContextMenu` handlers (`:101`,
  `:227`); the brief scoped this to `ProjectRail` and I stayed there.
- **The hover card does not come back** while the cursor sits on the tile after the menu closes —
  you have to leave and re-enter. Same behaviour the gallery card has had, and re-arming it would
  mean re-entering hover state with no `mouseenter` to justify it.
- **Two pre-existing driver complaints, both present on a `git stash` baseline and untouched by
  this work:** `drive-rail-tiles.mjs` §1b `top matches the sides: false`, and
  `drive-close-project.mjs` §3 `this project's sessions gone: false`.
