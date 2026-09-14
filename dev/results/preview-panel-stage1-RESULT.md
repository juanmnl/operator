# Preview side panel — stage 1 (layout) — RESULT

Code lane, 2026-09-14, branch `operator/4f0a00`. Implements §11 step 1 of
`dev/results/preview-panel-and-design-tools-design.md` (worktree `operator-b11dc0`), with the §10
recommendation accepted: moving the preview between slots remounts it and reloads the page.

## Override of spec §2 (from the user, relayed by the coordinator mid-task)

The side panel keeps **one width** across Plan, Diff and Preview. Switching tabs does not change
the panel width, cause a layout shift or refit the terminal. So, compared with §2 of the spec:

- No `operator.canvasWidth.preview`, no per-tab widths, no "first open = half rowW", no snap.
  The single existing `operator.canvasWidth` is kept.
- The Preview tab's bounds apply **only while the user drags** the handle: min 360, max
  `rowW − MIN_CONSOLE_W` (480). Nothing resizes the panel on its own to meet them; the preview
  scales to whatever width it gets. Plan and Diff drags keep the existing 300–1000.
- Still built: double-click the handle = half of `rowW`; `panelW` in the inspector-move effect
  deps; the native inspect view hidden during a panel drag.

## What changed

**New: `src/renderer/lib/session-layout.ts`** (pure) and its test file.

- Types `MainView`, `PanelTab` (now `'plan' | 'diff' | 'preview'`), `ReadingTab`, `SessionLayout`
  (gains `readingTab` and `tools: { grid, redlines }`, both false and read by nothing yet),
  `DEFAULT_LAYOUT` (`:23`). Moved out of DashboardView so the rules can be tested.
- `previewInBothSlots` (`:34`) is the invariant
  `mainView === 'preview' && panelOpen && panelTab === 'preview'`.
- `applyLayout(prev, patch)` (`:48`) implements the §1 action table:
  - Toolbar Preview while the panel tab is Preview: the panel goes to `readingTab` and stays open.
    This also applies when the panel is closed, so reopening it cannot produce both.
  - Panel tab PREVIEW (or ⌘K) while the main view is Preview: the main view goes to Console.
  - Any other patch that would leave both (only reachable from a stored layout): the panel is kept
    and the main view shows Console.
  - `readingTab` follows every non-preview `panelTab`.
- `coerceLayouts(raw)` (`:74`) holds the body of the old `loadLayouts`. It accepts `'preview'`,
  defaults `readingTab` to `plan` and `tools` to both off, syncs `readingTab` with a reading
  `panelTab`, and resolves a stored layout that shows the preview in both slots to Console.
- Width helpers: `PANEL_MIN_W` 300, `PANEL_MAX_W` 1000, `PREVIEW_PANEL_MIN_W` 360, `MIN_CONSOLE_W`
  480 (`:102-109`), `panelDragBounds(tab, rowW)` (`:114`), `clampPanelW` (`:119`),
  `halfPanelW(tab, rowW)` (`:124`). The spec places `MIN_CONSOLE_W` in DashboardView; it is here
  so the bounds are tested.

**`src/renderer/views/DashboardView.tsx`**

- Imports the layout module (`:68-71`). The local types and the coercion body were removed;
  `loadLayouts` is now a localStorage wrapper around `coerceLayouts`.
- `panelTabs` is `['plan', 'diff', 'preview']`, `previewInPanel` (`:278`). `patchLayout` goes
  through `applyLayout`.
- The stored panel width is accepted at `>= 300` with no upper cap, because a Preview drag in a
  wide window can go past 1000. `panelTabRef` (`:299`) and `cardRef` (`:301`, on the content card
  at `:4718`) are new.
- `startPanelResize` (`:346`): `rowW` = the card's `offsetWidth` + the panel width, measured at
  mousedown. The drag clamps with `panelDragBounds` for the tab showing. A click without movement
  does not change the width. Double-click is detected as `e.detail >= 2` on the second mousedown
  (`:355`), not as `onDoubleClick`: the first click mounts the full-window drag overlay, which can
  become the target of the second click, and then no dblclick reaches the handle. The half width
  is clamped to the tab's drag bounds, so on Plan or Diff it stops at 1000.
- `renderPreview(session)` (`:4569`) builds one `AppPreviewPanel` for either slot. `storageKey`
  stays `main-${session.id}` in both, and it passes `panelW` and `inspectHidden={resizingPanel}`.
  The main overlay renders it when `mainView === 'preview'` (`:5076`). CanvasPanel receives it
  when `previewInPanel` (`:5210`).
- ⌘K: new `panel-preview` "Side panel: Preview" (`:4363`), which sends one patch
  `{ panelTab: 'preview', panelOpen: true }`. The "Show side panel" label now reads
  "(Plan / Diff / Preview)". The existing "Preview: Interact/Annotate mode" entry was gated on
  `mainView === 'preview'`; it now also shows when the preview is in the panel (`:4366`).
  Otherwise it would disappear on a move.

**`src/renderer/components/session/CanvasPanel.tsx`**: uses the shared `PanelTab`, adds the
`Preview` label (`:14`), a `preview?: ReactNode` prop (`:30`) and the preview branch (`:96`). The
tab row and the 34px actions footer are unchanged; the footer is empty on this tab.

**`src/renderer/components/session/AppPreviewPanel.tsx`**: new props `panelW` and `inspectHidden`
(`:57`, `:60`). The inspector move effect (`:308-320`) now depends on
`[box, preset, inspecting, panelW, inspectHidden]`. While `inspectHidden` is true it calls
`previewInspectSetVisible(false)`. When it goes false it moves the view to the stage's current
rect, then shows it.

**New seam method `previewInspectSetVisible(visible)`**, Electron only:

- `src/renderer/env.d.ts` declares it optional.
- `electron/src/shared/operator-api.ts` adds it as `send`.
- `electron/src/main/ipc.ts:401` wires it.
- `electron/src/main/preview-inspect.ts:100` implements it with `WebContentsView.setVisible`, which
  hides the view without closing it.
- The Tauri bridge has no implementation; the renderer calls it with `?.`.

## Tests

- Renderer (`npx vitest run`, repo root): **78 files, 1192 passed, 0 failed**. 24 of those tests
  are new in `session-layout.test.ts`. One test runs every state (including invalid ones) × every
  action in the §1 table and checks the invariant. There are also tests for each table row, the
  round trip main → panel → main, coercion of legacy, junk and both-slots layouts, the drag bounds,
  and the half split.
- Electron (`electron/`, `npx vitest run`): **30 files, 552 passed, 0 failed**. No electron tests
  were added; `setVisible` is a one-line pass-through.
- `tsc --noEmit` (root): clean. `electron npm run typecheck` (main + renderer configs): clean.
  `vite build`: builds.
- The worktree had no `node_modules`. I symlinked the main checkout's (root and `electron/`), as
  the other lane worktrees do; `.gitignore` already covers the symlink.

## Deliberately not done (later stages, or outside the brief)

- Grid, redlines, `--grid`/`--measure` tokens, `setZoomFactor`, toolbar width tiers, folding
  Inspect into the mode control, removing the duplicate `⟳`, the F7 label ink.
- R1 hide/show of the native view for the server picker, port editor, ⌘K palette and QuitGuard
  (stage 2). Only the panel drag hides it in this change.
- The scale readout and "→ 1:1" button (§2), `moveBefore()` to avoid the reload, the
  `main-main-<id>` annotation key prefix, and toasts over a panel-hosted native view (§10.2).
- No render-time width clamp. If the window narrows after a wide Preview drag, the panel keeps its
  width and the content card is squeezed. A 1000px panel already behaves this way today. The
  stored value is never rewritten.

## Unverified in a real window

None of this has been run in the app. The user or a harness needs to check:

- Console and Preview visible side by side, with the Console taking keys while the preview is in
  the panel.
- Moves both ways. Expected: the page reloads at the same address, and the pin, path and
  annotations survive. The panel lands on the last reading tab and stays open.
- **The preview's toolbar at panel widths (300–460px).** The toolbar is still the single-row
  main-view bar, so at a narrow panel it will clip or overflow until stage 2's tiers land. This is
  the most likely visible defect in this stage.
- Inspect on in the panel, then drag the handle: the native view should disappear during the drag
  (the iframe stays visible) and come back aligned to the new stage rect on release.
- Double-click the handle: half the row, with no stray drag. This depends on `e.detail` reaching
  the handle's second mousedown.
- Tab switches Plan ⇄ Diff ⇄ Preview: no width change and no terminal refit.
- The panel's tab-row rule still lines up with the main toolbar's, and the preview's subhead bands
  sit correctly under the 44px tab row.
