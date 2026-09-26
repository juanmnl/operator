# "+ Add agent" menu clipped under the project header (2026-09-26, Design lane)

Branch `operator/57440`. Reported from a screenshot of a project's Team tab: the preset menu opened
upward, and its top was clipped under the project header, so the first presets could not be seen
or clicked. It got worse when the Infra preset made the list one row taller.

## Cause

`AddAgentControl` (`components/session/RosterPanel.tsx`) always drew the menu with
`position: absolute; bottom: ROW_H + 4`, capped at 300px. The control sits at the foot of the
roster, inside the Team tab's scroll container, just under the project header. With a short roster
the trigger is close to that container's top, so an upward menu overflows the container's top
edge. An absolutely positioned child that overflows a scroller's top cannot be scrolled to. The
`scrollIntoView` on the menu could not help for the same reason, and clamping to the window would
not either: the scroller does the clipping, not the window.

Measured in the Electron dev app on HEAD (1 lane, 6 presets on this branch), at 1000×700 and at
1440×900 alike: the menu's top was at y=72, the scroller's top at y=88, so **16px of the menu
was hidden under the header** and the first preset (Research) was cut in half. Each preset row is
30px, so with the Infra preset (7 presets) the hidden band is ~46px and the first preset
disappears entirely, which is the screenshot.

## Fix

A shared helper, `lib/menu-placement.ts`. The codebase had none that fitted: `planPanelPlacement`
(footer-reading) only opens upward, and `CardMenu`/`AccentPicker` clamp against the window only.
- `placeMenu()` (pure): opens on the preferred side if the whole menu fits there; else on the
  other side if it fits there; else on the side with more room, capped to that room, and the menu
  scrolls inside itself.
- `visibleBounds(el)`: the window cut down by every ancestor whose overflow clips. That is the
  scroller and the card, so "room" stops at the header's edge.
- `useMenuPlacement()`: measures before paint and again on window resize. The natural height
  includes the menu's borders, plus 1px for the rounding of `scrollHeight`. Without those, a menu
  that fitted was capped 2px short (then a fraction short) and drew a scrollbar anyway, which I
  saw in the first after-screenshot.

Applied to:
- **"+ Add agent"**: prefers above, as before. It stays absolutely positioned, so it still moves
  with its row and its existing dismissal code is unchanged. The trigger is scrolled into view
  first, then the menu is placed against what is actually visible.
- **`PopMenu`**, the shared menu behind the session toolbar's Model and Effort chips: same bug
  class (fixed direction, no height cap). Its `placement` is now the preferred side. Horizontal
  anchoring is unchanged, and it flips or caps the same way.

The other popovers were checked and left alone. `CardMenu` and `AccentPicker` are
fixed-positioned and clamp into the window. The footer's plan panel already caps its height to
the room above it. The Preview bar's picker and port editor open downward inside the preview
panel.

## Verification

Electron dev instance on this branch: isolated `OPERATOR_DIR` in the scratchpad, renderer on
1431, CDP on 9345. Roster sizes were built by adding presets through the menu, which only adds
lanes to the roster. The driver blocked any click on a Launch/Resume/Start control (0 attempts),
no lane was launched, and the instance was quit afterwards.

Every configuration: 0 / 1 / 3 / 5 lanes (5 = every preset but one, the smallest menu; with all 6
on the board the button adds a blank lane and there is no menu) × 1000 / 1440 wide × 700 / 900 tall
× dark / light, 40 runs in all.

| Lanes | Menu | Side | Menu top vs scroller top (88) | Items reachable without scrolling |
|---|---|---|---|---|
| 0 | none: the empty state shows the 6 preset cards | — | — | 6 cards |
| 1 | 6 presets + Blank lane, 194px | **below** (above had 173px) | 309, fully visible | 6 / 6 |
| 3 | 4 items, 134px | above | 216 | 4 / 4 |
| 5 | 2 items, 74px | above | 360 | 2 / 2 |

Identical across both widths, both heights and both themes. The roster sits at the top of the Team
tab, so the trigger's position does not depend on window size, and the menu fits one side at 700px.

The cap path, at a 1000×420 window with 1 lane: 173px above, 101px below. Neither fits, so the
menu takes the side above, capped to 172px, and scrolls. 5 of 6 items are visible and the sixth
is reached by scrolling the menu. Nothing sits under the header. A menu that fits shows no
scrollbar (0px gutter); the capped one does.

Before/after screenshots at 1000×700, light, 1 lane: `menu-before-1lane-1000x700.png` (Research
cut under the header) and `menu-after-1lane-1000x700.png` (menu below the trigger, whole). They
are in the Design lane's scratchpad, not committed.

Tests: `lib/menu-placement.test.ts` (5 cases, including the reported one and the no-room cap).
tsc is clean; vitest passes: 104 files, 1515 tests.

## Not verified

- **The Infra preset itself.** It is on another branch (`operator/d91080`), not this one, so
  the 7-preset menu was not drawn. The arithmetic above (one 30px row more) and the 1-lane flip
  cover it: a taller menu has even less reason to fit above.
- **`PopMenu` live.** Its menus exist only inside a running session. Starting a lane was ruled
  out after yesterday's incident, where a launched test lane ran commands on its own. Its change
  is covered by typecheck and by `placeMenu`'s tests. It keeps its downward preference, and at
  700px the Model and Effort menus (4 models plus Other, 6 effort levels) fit below the toolbar,
  so its behaviour there is unchanged.
