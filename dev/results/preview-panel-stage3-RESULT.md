# Preview side panel — stage 3 (layout grid) — RESULT

Code lane, 2026-09-14, branch `operator/4f0a00`, on top of stage 2 (`1b6955c`). Implements §6,
§7 (`--grid` only), §8 (grid rows only) and §11 step 3 of
`dev/results/preview-panel-and-design-tools-design.md` (worktree `operator-b11dc0`). No redlines.

**While the native inspect view is up, the grid is not drawn.** That view covers the stage and
nothing the renderer draws can paint above it. Drawing the grid inside that page is stage 4. The
Grid button's tooltip says "not drawn while Inspect is on".

## What changed

### Geometry and spec — `src/shared/layout-grid.ts` (new, pure) + `layout-grid.test.ts`

- `GridSpec` lives in `src/shared/types.ts:387`. `Project.previewGrid?: GridSpec` is at
  `types.ts:457`; absent means Auto.
- `layoutGrid(spec, pageW)` (`:48`) is the one geometry function. It implements the §6 formula and
  Auto's tiers (4 columns below 600px, 8 from 600, 12 from 840, with the matching gutter and
  margin). It returns the container box, `clamped` (max width narrower than the page), `colW`, and
  `cols`, which is empty when `colW <= 0`.
- **It is self-contained on purpose**: no runtime imports, no module constants, no calls out. That
  way the stage-4 script can be given `String(layoutGrid)` and run the same code in the page. A
  test rebuilds the function from its string and checks that the output matches. Auto's values are
  therefore written out inside the function rather than read from `GRID_PRESETS`; another test
  holds the two in agreement.
- Helpers:
  - `DEFAULT_GRID_SPEC` (Auto) (`:9`);
  - `GRID_PRESETS` and `applyGridPreset` (`:72`, `:79`);
  - `GRID_FIELD_BOUNDS` (`:87`): columns 1–24, gutter 0–200, margin 0–400, max width ≥ 240;
  - `parseGridField` (`:96`): whole px only; `undefined` = invalid, `null` = empty max width;
  - `stepGridField` (`:107`);
  - `editGridField` (`:116`);
  - `coerceGridSpec` for stored data (`:125`);
  - `formatColumnWidth` (`:146`), e.g. `72.67px`.
- **Deviation:** editing Max width does **not** switch the spec to Custom. No preset sets a max
  width, and the spec says max width applies across Auto's tiers. Switching to Custom would make
  "Auto with a max width" reachable only by setting the width first and then clicking Auto.
  Editing columns, gutter or margin does switch to Custom, starting from the values in effect on
  the current page (an Auto grid on a 768 page keeps its 8 columns).

### Drawing — `src/renderer/components/session/AppPreviewPanel.tsx`

- `gridLayout = layoutGrid(grid.spec, pageBox.w)` (`:441`) is computed in **page** px, so the device
  presets move Auto.
- The grid layer (`:808`) sits inside the stage:
  - absolutely positioned at `pageBox` size, with the iframe's `transform: scale()` and
    `transform-origin: top left`;
  - `pointer-events: none`, z-index 1: above the iframe, below the annotation overlay (2) and the
    pins (3);
  - outside the iframe, so it stays fixed while the page scrolls.
- Column fill is `color-mix(in srgb, var(--grid) 10%, transparent)` (`GRID_FILL`, `:1049`). When
  max width clamps, the container edges are 1px dashed at `var(--grid)` 45%. Their width is
  `1 / scale` px, so they stay one screen pixel at a scaled preset.
- The layer is not rendered while `inspecting`, or when there are no columns.

### Controls

- **Tools row** (`AppPreviewPanel.tsx:707`): a hairline divider (1 × 14px `--border`), then two
  buttons, only while a server is up:
  - `Grid` shows or hides the grid (accent ink when on, `CONTROL_OFF_INK` when off);
  - `▾` / `▴` opens or closes the settings band.
- **Settings band**: `GridSettingsBand.tsx` (new), mounted under the tools row (`:727`), inside the
  bar. The bar is now an outer block (`:486`) holding the row container and the band, so the band
  **pushes the stage down**. The inspector-move effect already depends on `box`, so the native view
  follows.
  - Preset segment `Auto 4 8 12 Custom`, styled like the pointer-mode control. With Auto selected,
    the fields show the resolved values and the band shows `Auto → 8`.
  - Fields Columns / Gutter / Margin / Max width (`NumberField`, `:114`): mono 11px,
    `--overlay-subtle` ground, a transparent edge that changes on focus, no focus ring, 44px wide,
    tabular numbers.
  - ↑/↓ step ±1, ⇧ ±8, and commit at once. Typing commits on Enter or blur. Invalid input reverts
    on blur. Esc reverts; a ref (`:163`) stops the blur from then committing what Esc abandoned.
    An empty Max width = none (placeholder `none`).
  - Readout: `72.67px columns`, or `Columns don’t fit at this width`, then `· Saved to <project>`
    or `· Not saved — this session has no project`. A `Done` button closes the band.
  - **The band wraps at every width, not only below 520.** Its content measures about 850px, so it
    cannot fit one line in the 520–880 two-row tier. It is one line when it fits, and each wrapped
    line is 30px because every group is band-high.
- `CONTROL_OFF_INK` moved into `lib/preview-toolbar.ts:39` so the band and the bar share it.

### State and persistence — `src/renderer/views/DashboardView.tsx`

- **Spec per project** (`:4266-4282`). `gridSpec` = `coerceGridSpec(project.previewGrid)` or Auto.
  `changeGridSpec` writes `updateProject(id, { previewGrid })`. A session with no project keeps an
  in-memory spec (Auto to start), which resets on session switch, and the band says it is not saved.
- **Visibility per session**: `SessionLayout.tools.grid`. `LayoutPatch`
  (`lib/session-layout.ts:49`) merges `tools` field by field (`:52`), so `patchLayout({ tools: { grid } })`
  cannot clear `redlines`.
- **Opening the settings turns the grid on** (`editGrid`, `:4279`). The settings-open state resets
  on session switch.
- The grid props are passed in `renderPreview` (`:4631`). They are owned by DashboardView because
  ⌘' and ⌘K reach them, and because the preview remounts on every move between slots.

### ⌘' — View-menu accelerator (F4)

- `electron/src/main/app-menu.ts` (new) builds the application menu. The app set none before, so
  Electron used its default. The template rebuilds that default role by role (`appMenu` on macOS,
  `fileMenu`, `editMenu`, View, `windowMenu`), so ⌘C/⌘V/⌘A, ⌘W, ⌘Q, reload, devtools, zoom and full
  screen stay as they were.
  - View gains "Show or Hide Layout Grid" with accelerator `CmdOrCtrl+'` (`:24`). Its click sends
    `toggle-grid`.
  - Electron's default Help menu (a "Learn More" link to electronjs.org) is not included.
- `electron/src/main/index.ts:288` installs the menu and broadcasts the command over a new
  `onMenuCommand` event: `operator-api.ts:152` and `env.d.ts:222` (optional, Electron only).
  DashboardView subscribes at `:4286`.
- `isAppChord` claims `'` (`lib/key-routing.ts:22`), so the terminal lets ⌘' through to the menu.
  The window keydown handler deliberately does nothing with ⌘': a `preventDefault` there would
  block the menu accelerator, and handling it in both places would toggle twice.
- The three dev bridges (`dev/mock-bridge.ts`, `dev/qa-real-bridge.ts`, `dev/qa-tuning-bridge.ts`)
  got `onMenuCommand: () => noop`. Their Proxy catch-all returns a Promise, which would have thrown
  in the subscription's cleanup.

### ⌘K — Preview group (DashboardView `:4405-4411`)

- These entries show only while a preview is mounted in either slot:
  - `Preview: Show layout grid` / `Hide layout grid`, with hint ⌘';
  - `Preview: Grid — Auto (4 · 8 · 12)` / `4 columns` / `8 columns` / `12 columns`, with ✓ on the
    current preset; picking one also turns the grid on;
  - `Preview: Edit layout grid…`.
- `Preview` is added to the palette's group order after View (`CommandPalette.tsx:22`).

### Tokens

`--grid` is added to all six palettes, per §7:

| Palette | `--grid` | Line |
|---|---|---|
| Mission Control | `var(--red)` | `mission-control.ts:50` |
| Mission Control light | `var(--red)` | `mission-control-light.ts:55` |
| 1984 | `var(--yellow)` | `1984.ts:48` |
| 1984 light | `var(--yellow)` | `1984-light.ts:56` |
| Mr Pink | `var(--yellow)` | `mr-pink.ts:46` |
| Mr Pink light | `var(--yellow)` | `mr-pink-light.ts:53` |

The underlying hex values match the spec's table.

## Tests

- Renderer (`npx vitest run`, repo root): **80 files, 1223 passed, 0 failed**. 22 are new:
  - 19 in `src/shared/layout-grid.test.ts`:
    - the §6 worked example: container 1200, x0 72, content 1136, column 72.67, three four-column
      cards = (1136 − 48) / 3, the last column ending on the content edge;
    - no columns when they don't fit or the page is unmeasured, and no edges without clamping;
    - Auto's 599/600/839/840 boundaries, Auto agreeing with the presets, Auto keeping a max width;
    - the stringified-function check;
    - presets, edits, parsing, stepping, and coercion of stored data.
  - 1 in `session-layout.test.ts` (tools patch merges).
  - 2 in `key-routing.test.ts` (⌘' claimed, bare `'` left to the terminal).
- Electron (`electron/`, `npx vitest run`): **31 files, 556 passed, 0 failed**. 4 are new in
  `app-menu.test.ts`: default roles kept on macOS and elsewhere, ⌘' bound and sending
  `toggle-grid`, and the default View roles kept.
- `tsc --noEmit` (root): clean. `electron npm run typecheck` (main + renderer): clean.
  `vite build` builds from both the repo root and `electron/`.

## Deliberately not done

- Redlines, `--measure`, `setZoomFactor`, drawing the grid inside the inspect view's page, ⌘⇧'
  (stage 4).
- ⌘E and ⌘K are not moved to menu accelerators. They still die while the page has focus (F4).
- The spec's three pointer-mode ⌘K entries (§8) are not added. The existing single
  `preview-annotate` entry stays in the View group.
- With classic (non-overlay) scrollbars, the iframe-hosted grid can run up to 15px wider than the
  page's real viewport, because the renderer cannot see the page's scrollbar (§6, noted in the
  spec). macOS overlay scrollbars make this 0.
- There is no ⌘' outside Electron (the retired Tauri shell, the browser mock harness). The ⌘K
  entries and the Grid button work there.

## Unverified in a real window

None of this has been run in the app. To check:

- **⌘'**:
  - toggles the grid with focus in the Console, in the preview iframe, and in the native inspect
    view (a menu accelerator should fire for that view too; not confirmed);
  - toggles exactly once;
  - is never typed into the terminal.
- **The menu rebuild**: ⌘C/⌘V/⌘A in the terminal and in inputs, ⌘W (still lane-scoped through the
  renderer), ⌘Q (quit guard), ⌘R, zoom and full screen all behave as before. The View menu shows
  the grid item.
- **Drawing**:
  - columns at Fit, 375 (Auto → 4), 768 (→ 8) and 1280 scaled into a narrow panel (→ 12, scaled
    with the page);
  - dashed container edges when max width clamps, one screen pixel wide at 50% scale;
  - the grid under pins and the annotate overlay, and never catching a click;
  - columns staying put while the page scrolls.
- **Settings band**:
  - it opens under the tools row and pushes the stage (not covering it), in both slots and all
    three tiers;
  - it wraps cleanly in a 360px panel;
  - with Inspect on, the native view re-aligns under the band;
  - fields: arrows (±1, ⇧ ±8), Enter, blur with invalid text, Esc, empty Max width;
  - the readout and the Auto hint follow the device presets.
- **Persistence**: a spec edited in one lane shows in another lane of the same project and survives
  a restart (`projects.json` gains `previewGrid`). Visibility is per session. A session without a
  project shows "Not saved — this session has no project".
- **⌘K**: the Preview group shows only with a preview mounted, the ✓ follows the preset, and
  "Edit layout grid…" opens the band with the grid on.
- **Visuals**: the grid hue on all six palettes, distinct from each accent and readable as a 10%
  fill over white and dark pages. `dev/drive-theme-pass.mjs` was not run.
