# Preview side panel — stage 2 (toolbar at every width) — RESULT

Code lane, 2026-09-14, branch `operator/4f0a00`, on top of stage 1 (`d32ff14`). Implements §3, §4
and §11 step 2 of `dev/results/preview-panel-and-design-tools-design.md` (worktree `operator-b11dc0`).

## Overrides that still apply

- The panel width never changes on its own (the user's override from stage 1). So the scale
  readout (`768 · 62%`) is plain text in **both** slots, and there is no `→ 1:1` button.
- Grid ▾ and Redlines were not built, and no space is reserved for them. Adding them later means
  appending two controls to the tools row. The `ONE_ROW_MIN_W` threshold already counts their width
  (the spec's ~840px estimate includes them), so no re-tiering is needed.

## What changed

**New: `src/renderer/lib/preview-toolbar.ts`** (pure) and its test file.

- `toolbarTier(width)` (`:15`) returns `one` at ≥ 880 (`ONE_ROW_MIN_W`, `:9`), `two` at ≥ 520
  (`TWO_ROW_MIN_W`, `:11`), and `narrow` below that.
- `originChipLabel(url, port, tier)` (`:23`): an external target shows its host. Otherwise the
  label is `localhost:5173`, or `:5173` when narrow. With neither it reads `no server`.
- `scaleReadout(preset, stageW)` (`:31`) returns `768 · 62%` only when a preset is wider than the
  stage; it is null for Fit, a preset that fits, or an unmeasured stage.
- `pointerMode(annotate, inspecting)` (`:42`) returns exactly one of `interact` / `annotate` /
  `inspect`. If both flags are briefly on, Annotate wins.

**`src/renderer/components/session/AppPreviewPanel.tsx`**

- **Measured tier.** A `rootRef` on the component root (`:133`, `:470`) is measured by a
  ResizeObserver in a layout effect (`:257`). The effect stores the tier, not the width, so a
  panel drag re-renders only when a threshold is crossed. The tier depends on the component's
  width, not on which slot holds it.
- **Bar structure.** The bar is one block with an address row and a tools row
  (`barRow` / `toolGroup` styles at `:997`, `:1002`):
  - `one`: the two rows sit side by side, and the address row takes the free width.
  - `two`: the tools row goes under the address row.
  - `narrow`: the tools row may wrap. Each group is 30px high (`PANEL_SUBHEAD_H`), so a wrapped
    line is as tall as the rows above it.
  - The order is the same at every width: `◀ ▶ ⟳ · origin chip · path · ↩ · ↗`, then
    `Fit 375 768 1280 · readout · Interact Annotate Inspect`.
  - The tools group (`:636`) has no overflow menu.
- **Origin chip** uses `originChipLabel` with the tier (`:290`), so it drops `localhost` below 520.
- **F5.** The right-hand `⟳ Reload preview` button is gone. The reload stays in the nav cluster.
  `↗` moved to the end of the address group (`:548`), as in the spec's layouts.
- **F6.** Inspect is a third segment of the pointer-mode control (`POINTER_MODES` `:28`, rendered
  at `:677`). The segment only exists while there is a page. `setPointerMode` (`:433`) sets both
  flags, so exactly one mode is on. ⌘E sets Annotate from DashboardView, bypassing that handler,
  so an effect (`:145`) turns Inspect off whenever Annotate turns on. The highlighted segment comes
  from `pointerMode(annotating, inspecting && !!display)` (`:432`).
- **F7.** Unselected presets and mode segments use
  `OFF_INK = color-mix(in srgb, var(--fg) 72%, transparent)` (`:994`). The active mode segment
  gets `--overlay-subtle` ground with accent ink, per the §3 control table. The mode track keeps
  its static `1px solid var(--border)`, radius 6.
- **Scale readout** (`:430`, `:663`): mono 9.5px `--fg-muted`, tabular numbers, plain text.
- **R1.** `hideInspect = inspectHidden || pickerOpen || editing` (`:339`). The inspector effect
  hides the native view while that is true. When it goes false, the effect moves the view to the
  stage's **current** rect and then shows it. The effect's deps are now
  `[box, preset, inspecting, panelW, hideInspect, tier]` (`:351`); `tier` is included because a
  change of rows moves the stage.
- **Picker anchoring (a stage-1 defect, fixed here).** The server picker and the port editor are
  `position: absolute; top: 32px`. They used to resolve against the nearest positioned ancestor.
  In the side panel that is the panel box, whose top edge is above its own 44px tab row, so the
  picker would have covered the tab row. The bar is now `position: relative`, so both anchor under
  the address row in either slot. The picker also gets `maxWidth: calc(100% - 16px)` (`:561`), and
  below 520 both move to `left: 8` (`:616`), so a 320px picker fits a 360px panel.

**`src/renderer/views/DashboardView.tsx:4589`**: `inspectHidden` is now
`resizingPanel || paletteOpen || !!quitRequest`. The ⌘K palette and QuitGuard hide the native view
while open. The prop's doc comment names all three (`AppPreviewPanel.tsx:68`).

## Tests

- Renderer (`npx vitest run`, repo root): **79 files, 1201 passed, 0 failed**. 9 of those tests
  are new in `preview-toolbar.test.ts`. They cover the tier boundaries at 880/879 and 520/519, the
  origin label per tier (including an external host and no server), the readout present/absent
  cases, and pointer-mode exclusivity.
- Electron (`electron/`, `npx vitest run`): **30 files, 552 passed, 0 failed**. There were no
  electron changes in this stage.
- `tsc --noEmit` (root): clean. `electron npm run typecheck`: clean. `vite build` (root): builds.
- Harness check: nothing under `dev/`, `scripts/` or `electron/probes/` selects the removed
  `Inspect ⧉` button, the `Reload preview` button or the old mode labels.
  `dev/drive-preview-centre.mjs` selects `[data-preview-stage]`, which is unchanged.

## Deliberately not done

- Grid, redlines, their settings row, tokens, `setZoomFactor`, ⌘' / ⌘⇧' (stages 3–4).
- §8 menu accelerators. F4 still applies: while the page inside the preview has focus, ⌘E and ⌘K
  do not reach the window's key handler. So R1's palette case only arises when focus is outside
  the page.
- §10.2 toasts over a panel-hosted native view. Toasts still sit bottom-right and would be covered.
- The nav buttons (`◀ ▶ ⟳ ↩`) keep their existing `--fg-muted` ink; F7 names presets and mode
  labels only.

## Unverified in a real window

None of this has been run in the app. To check:

- **Tiers.** Drag the side panel across 880 and 520 with the preview in it, and resize the window
  with the preview in the main view:
  - one row → two rows → wrapped tools row, with no clipping at 360px;
  - the chip reads `:5173` below 520;
  - no flicker loop at a threshold (the tier changes the bar's height, not the root's width, so
    there should be none).
- **Rule lines.** The bar's single bottom rule sits under whichever row is last. In `two`, the two
  30px bands sit under the panel's 44px tab row without a gap.
- **F6.**
  - Clicking Inspect while Annotate is on turns Annotate off and the pins go away.
  - ⌘E while Inspect is on switches to Annotate and closes the native view.
  - The Inspect segment is absent when no server is up.
- **R1**, with Inspect on:
  - opening the server picker, the port editor ("Other port or URL…"), ⌘K (focus outside the page)
    or the quit dialog hides the native view, and the picker/palette is visible above the iframe;
  - closing it brings the view back at the right rect, including after the tier changed while it
    was hidden.
- **Picker in the panel.** It opens under the address row, not over the tab row, and fits inside a
  360px panel.
- **Scale readout.** `1280` in a 640px stage reads `1280 · 50%`, and it disappears at Fit and at
  presets that fit.
- **Contrast.** `OFF_INK` on the preview bar in all six palettes (`dev/drive-theme-pass.mjs` was
  not run).
