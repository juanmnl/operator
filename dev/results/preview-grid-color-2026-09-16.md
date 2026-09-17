# Preview layout grid colour — 2026-09-16

Lane: Design. Branch `operator/666300` (worktree `~/.operator/worktrees/operator-666300`).
Commit: `fdf71e7` (grid colour). Same branch, earlier: `6790878` (Plan usage popover polish).

## Verification

- Renderer suite (`npx vitest run`, repo root): 84 files, 1319 tests passed, 0 failed. Before the grid
  work it was 1310 passed, 0 failed. The difference is the 9 new grid colour tests.
- Electron suite (`electron/`, `npx vitest run`): 32 files, 562 tests passed, 0 failed.
- `tsc --noEmit` passes for the renderer project and for `electron/tsconfig.json`.
- Not verified in the GUI: the band's layout, the native colour picker, and the grid drawn inside the
  native inspect view all still need a look in the app.
- The worktree had no `node_modules`, so `node_modules` and `electron/node_modules` are symlinks to
  the main checkout's copies. Git ignores them and they are not committed.

## Data model

`GridSpec` (`src/shared/types.ts`) has two new optional fields:

| Field | Values | Absent means |
|---|---|---|
| `color` | `#rrggbb`, lowercase | the theme's `--grid` |
| `fill` | `20` or `30` | 10 |

- **Old entries.** A `previewGrid` written before this change has neither key and draws exactly as
  before: `--grid` with a 10% fill and 45% edges. No migration step, and nothing is rewritten on load.
- **Defaults are stored as absent.** Picking Theme removes `color` (`withGridColor(spec, undefined)`), and
  picking 10% removes `fill`. A spec returned to the defaults is byte-identical to what an old build
  wrote, and an older build reading a new file ignores the extra keys.
- **Validation.** `coerceGridSpec` drops an invalid `color` or `fill` on its own and keeps the columns,
  gutter, margin and max width. Only `#rgb`/`#rrggbb` is accepted (normalised to `#rrggbb`), because the
  colour is put into a style string inside the previewed page, and this also blocks CSS injection from
  a hand-edited file.
- `applyGridPreset` and `editGridField` keep `color` and `fill`. `editGridField` previously rebuilt the
  object field by field and would have lost them.

## Opacity

`gridInk(spec, themeGrid)` in `src/shared/layout-grid.ts` is the only place the grid's alpha is set:

| Fill | Column fill | Container edge |
|---|---|---|
| 10 (default) | `color-mix(<c> 10%, transparent)` | 45% |
| 20 | 20% | 60% |
| 30 | 30% | 75% |

- The edges get stronger as the fill does, so the dashed container edge stays visible over a strong fill.
- There is no `opacity` on any element, and `--fg-muted` is not involved.
- `gridInk` is self-contained like `layoutGrid`. It is passed to the page through
  `electron/src/main/overlay-fns.ts`, so the renderer layer and the native inspect view use the same
  function. `preview-overlay.js` falls back to the old 10%/45% theme ink if `F.gridInk` is missing.

## Controls (grid settings band, after the number fields)

`Colour [Theme] [Red] [Magenta] [Blue] [Teal] [Green] [custom] [hex field]   Fill [10%|20%|30%]`

- **Theme** swatch draws `var(--grid)` and is the default.
- **Fixed swatches** (`GRID_SWATCHES`). The grid is drawn over the user's page, which can be white or
  black whatever Operator's theme is, so these do not follow the theme. Each one holds at least 3:1
  against both `#fff` and `#000` at full strength (luminance 0.15–0.27). A test enforces this.

  | Name | Hex | vs white | vs black |
  |---|---|---|---|
  | Red | `#f0283c` | 4.1 | 5.1 |
  | Magenta | `#d6409f` | 4.1 | 5.1 |
  | Blue | `#3e63dd` | 5.2 | 4.0 |
  | Teal | `#0797b9` | 3.4 | 6.1 |
  | Green | `#16a34a` | 3.3 | 6.4 |

  Yellow, orange and near-black were left out because they disappear on a white or a black page.
- **Custom:** a swatch over the native `<input type="color">`. Before a custom colour is picked it shows
  a conic gradient of the fixed swatches. Picker input applies live, like the arrow-key steps on the
  number fields.
- **Hex field:** accepts `#rgb`, `#rrggbb`, with or without `#`. Enter or blur commits, invalid input
  reverts, Esc reverts, and an empty field means Theme (placeholder `theme`). It uses the same input
  style and focus edge as the number fields, now shared through `inputBox`.
- **Fill:** a segmented control in the same style as the preset control, with mono tabular numerals.
- **Selection** is a 2px `--accent` bar under the swatch, drawn by switching its background colour. The
  swatch border stays a static `1px var(--border)`, because a changing border colour on a radiused
  element is the WKWebView freeze rule. Every control has `aria-pressed` and `aria-label`.
- Ink: labels use `CONTROL_OFF_INK` (the 72% `--fg` step-down), never `--fg-muted` with opacity.

## Tests added (`src/shared/layout-grid.test.ts`, plus `overlay-fns.test.ts`)

- An old entry reads unchanged and draws the theme colour at 10%/45%.
- Colour and fill survive a JSON save and load.
- Returning to Theme and 10% writes the same JSON as the old entry.
- A bad colour (`red`, a 5-digit hex, a CSS injection string) or fill (`50`, `"20"`) is dropped alone.
- Presets and field edits keep colour and fill.
- `parseGridColor` accepts and rejects the expected forms.
- Edge strength steps up with fill, and a colour that isn't stored hex falls back to the theme.
- `gridInk` still works as a stringified function, both in the renderer test and in the page copy from `OVERLAY_FNS_JS`.
- Swatch contrast is at least 3:1 against both white and black.

## Still open

- GUI check: how the band wraps at narrow preview widths now that it has one more group, the picker
  opening from the custom swatch, and the grid colour inside the native inspect view in both themes.
- ⌘K has no colour commands. Colour is only set from the band.
