# Preview side panel — stage 4 (redlines, grid in the inspect view) — RESULT

Code lane, 2026-09-14, branch `operator/4f0a00`, on top of stage 3 (`79f9bad`). Implements §4, §5,
§6 (native-view host), §7 (`--measure`, `--measure-ink`), §8 (redline rows) and §11 step 4 of
`dev/results/preview-panel-and-design-tools-design.md` (worktree `operator-b11dc0`). Measurement in
Inspect notes (§11 step 5) is not in this stage.

## Contrast: `--measure-ink` on `--bg-surface`, measured

The ink is resolved the way the browser resolves `color-mix(in srgb, …)` (channel by channel) and
checked with the WCAG ratio in `src/renderer/themes/index.test.ts:131`. That test runs for all six
palettes.

| Palette | `--measure` | `--measure` on surface | Ink mix | Ink on surface |
|---|---|---|---|---|
| Mission Control | `var(--magenta)` #c98bff | 7.11 | 70% | **9.00** |
| Mission Control light | `var(--magenta)` #8e44ad | 4.66 | 70% | **6.28** |
| 1984 | `var(--magenta)` #F806FA | 5.34 | 70% | **6.10** |
| 1984 light | `var(--magenta)` #F806FA | 2.18 | **55%** | **4.99** |
| Mr Pink | `var(--cyan)` #8FC8FF | 7.90 | 70% | **9.23** |
| Mr Pink light | `var(--blue)` #2563eb | 4.02 | 70% | **5.53** |

- **1984 light fails at the spec's 70%**: 3.73:1. 65% gives 4.11 and 60% gives 4.53, so it uses 55%
  (4.99). Every other palette passes at 70%.
- `--measure` on its own is used for lines, edges and fills drawn over the page, never as text on
  the surface.
- The test also checks that `--measure` differs from `--accent` and from `--grid` in every palette.
- The token values live in each palette file (`mission-control.ts:54-55`,
  `mission-control-light.ts:57-58`, `1984.ts:50-51`, `1984-light.ts:59-60`, `mr-pink.ts:48-49`,
  `mr-pink-light.ts:55-56`). The spec says `styles.css`, but a mix that differs per palette belongs
  with the palette.

## What changed

### Host and zoom — `src/renderer/components/session/AppPreviewPanel.tsx`

- `nativeHost = display && (inspecting || (redlinesOn && !annotating))` (`:328`). The native view
  now opens and closes on `nativeHost` (`:338`, deps `:347`), and the move/hide effect follows it
  (`:370`). In Annotate, redlines pause and the iframe stays the host (`redlinesPaused`, `:327`).
- **F3:** a configure effect (`:461-469`) sends
  `{ scale, inspect, redlines, grid, tokens }` whenever the native view is up and any of these
  change. `scale` becomes `webContents.setZoomFactor(scale)` in the main process, so the page's CSS
  viewport is the device preset.
- The renderer grid layer only draws when `!nativeHost` (`:853`). Otherwise the page draws it.
- **Tokens:** `useOverlayTokens` (`src/renderer/lib/overlay-tokens.ts:22`) reads `--measure`,
  `--measure-ink`, `--grid`, `--bg-surface`, `--fg` and `--border` with `getComputedStyle`, which
  substitutes `var()`. A MutationObserver on the root element's style attribute re-reads them, so a
  theme change re-sends the configuration. `--fg` and `--border` are beyond the brief's four; the
  inspector's compose card needs them to stay readable on the light palettes.
- **Redlines control** in the tools row's overlays group, after Grid (`:748`):
  - accent ink when on;
  - a `paused` suffix in `--fg-muted` mono 9px while annotating (`:758`), with the spec's title:
    "Redlines pause while annotating. Switch to Interact or Inspect to measure."

### Main process — `electron/src/main/preview-inspect.ts`

- **Injection:** `INSPECTOR_JS + BRIDGE_JS + OVERLAY_FNS_JS + OVERLAY_JS` on every `did-finish-load`
  (`:113`), followed by `apply()`. Both scripts are read through `readShared` (`:28`).
  `build-main.mjs:38` copies `preview-overlay.js` beside the bundles, as it already did for the
  inspector.
- **Applying the configuration:** `apply()` (`:80`) sets the zoom factor (`:82`), then calls
  `window.__operatorOverlay.configure(config)` in the page. `configure` (`:145`) stores the latest
  config; it is re-applied after every load and dropped on close.
- **Anchor reporting:**
  - The page reports anchor state over `operator-preview:anchor` (`:77`), through a boolean-only
    bridge in the preload (`electron/src/preload/inspector.ts:20`).
  - Main broadcasts `onPreviewAnchor` (`index.ts:289`).
  - The state is reset to false on close and on any main-frame navigation that loads a new document
    (`:109`).
  - `clearAnchor` (`:150`) calls the page.
- **New seam methods:**
  - `previewInspectConfigure` / `previewInspectClearAnchor` (send): `operator-api.ts:151-152`,
    `ipc.ts:402-403`, `env.d.ts:220-222`;
  - `onPreviewAnchor` (event): `operator-api.ts:155`, `env.d.ts:230`;
  - `PreviewOverlayConfig` / `PreviewOverlayTokens` types: `src/shared/types.ts:403`, `:413`.
- **`OVERLAY_FNS_JS`** (`electron/src/main/overlay-fns.ts:9`) defines `window.__operatorOverlayFns`
  from `String(layoutGrid)`, `String(measureBetween)`, `String(formatPx)` and `String(placeChip)`.
  - Checked in a real `npm run build:main`: the bundle has no esbuild `__name` helper anywhere, so
    the function sources survive bundling unchanged.
  - `overlay-fns.test.ts` runs the string in an empty `window` and compares the results with the
    imported functions.

### Redline math — `src/shared/redlines.ts` (new, pure, self-contained like `layoutGrid`)

- `measureBetween(a, b)` (`:27`) implements §5's distance rules:
  1. containment → four insets through the inner box's centre lines, zero-length insets skipped;
  2. horizontal separation → one line at the middle of the vertical overlap, or at A's centre with
     a dashed extension along B's edge;
  3. vertical separation → the same on the other axis; diagonal neighbours get both lines;
  4. overlap → left-edge and top-edge offsets through the overlap.
- `formatPx` (`:90`) is rule 5: an integer within 0.01 of one, otherwise one decimal.
- `placeChip` (`:98`) centres a chip on its line, moves it past the line's end when the line is
  shorter than the chip (or before the start at the viewport edge), and clamps it inside the
  viewport.

### In-page drawing — `src/shared/preview-overlay.js` (new, Electron only)

- **Host element:** a fixed, pointer-events-none element with its own shadow root, so page CSS
  cannot restyle it. It is attached to `<html>`, below the inspector's own box and label.
- **Grid** (`drawGrid`, `:57`): `layoutGrid(spec, documentElement.clientWidth)`, which excludes the
  scrollbar. 10% `--grid` columns; 45% dashed container edges when max width clamps.
- **Redlines** (`drawRedlines`, `:155`):
  - hover (no anchor): an outline, a size chip (`240 × 48`) and insets to the container;
  - anchor A plus hover B: both outlined, both sizes, and the distances between them;
  - anchor with nothing else hovered: A's size and its insets to its container.
- **Container** (`containerOf`, `:88`): the nearest ancestor whose border box differs from the
  element's, measured to its padding-box edge (border box minus border widths). If none qualifies,
  the viewport.
- **What can be measured** (`usable`, `:76`): the root, body, the overlay itself and the
  inspector's compose card count as nothing.
- **Chips** (`:105`): `--bg-surface` ground, 1px `--measure` edge, `--measure-ink` text, JetBrains
  Mono 10px/600 tabular numbers, radius 3, padding 1px 4px.
- **Lines** (`:128`): 1px `--measure` with 4px end ticks. Extensions are 1px dashed at 55%, and the
  anchor fill is 8%.
- **Counter-scaling:** every size is divided by `scale`, so it stays that size on screen in the
  zoomed page.
- **Redraws** happen on mousemove, capture-phase scroll (the hover target is re-picked under the
  still pointer), resize, and every animation frame while an anchor is set (`tick`, `:181`). The
  frame loop does not run while the document is hidden.
- **⌥-click** (`onAltPress`, `:228`) is captured on `window`, before the page's own listeners and
  before the inspector's `document` listener. It covers `pointerdown/mousedown/pointerup/mouseup/
  click/auxclick/dblclick` with preventDefault + stopImmediatePropagation, so no part of the press
  reaches the app. On `click` it sets the anchor, or clears it when the target is the anchor or
  empty space.
- **Esc** (`:240`) clears the anchor, except while focus is inside the compose card, which owns Esc.
- **HMR:** an anchor that left the document is found again with the inspector's `selector()`,
  stored when it was set. If nothing matches, the anchor is cleared and the app is told.

### Inspector — `src/shared/preview-inspector.js` (shared with the Tauri shell)

- It now exposes `window.__operatorInspector = { selector, configure }` (`:6`). `configure` (`:20`)
  takes:
  - `enabled`: off in Interact-with-redlines, which means no hover outline, no compose card, and
    clicks reach the app;
  - `colors`: the tokens;
  - `scale`.
- **Colours:** the hardcoded `#7ee787` / `#0b0d10` became a colour set `C` (`:16`). Its defaults are
  the original values, so a shell that never configures it (Tauri) looks as before. With
  Operator's tokens: outline and edges use `--measure`, text uses `--measure-ink`, the card ground is
  `--bg-surface`, and the card's text, field and borders use `--fg` / `--border`.
- **Deliberate restyle, in both shells:** the compose card's primary button is no longer
  accent-filled. Its label would be the ground colour on the accent, which is 2.18:1 for
  surface-on-magenta in 1984 light. Both buttons are now transparent, and the primary one has the
  full-strength edge.
- **Counter-scaling:** the compose card and the element label are scaled by `1/scale` (`:41`,
  `:122`), so they keep their size on screen when the page is zoomed out. The card's edge clamps
  use its scaled footprint.
- **No double outline:** the inspector's hover outline hides while redlines draw (`:52`), because
  the redline outline already marks that element.

### Controls and shortcuts

- `SessionLayout.tools.redlines` is used through the existing tools merge. `redlinesOn` and
  `toggleRedlines` are at `DashboardView.tsx:4291-4292`, passed at `:4660`.
- **⌘⇧':**
  - "Show or Hide Redlines" with accelerator `CmdOrCtrl+Shift+'` (`app-menu.ts:25`) sends
    `toggle-redlines`, routed at `DashboardView.tsx:4306`;
  - `isAppChord` also claims `"`, which is how ⌘⇧' arrives (`key-routing.ts:22`).
- **⌘K:**
  - `Preview: Show redlines` / `Hide redlines` with hint ⌘⇧' (`:4433`);
  - `Preview: Clear measurement anchor`, only while the page reports an anchor (`:4435`; state from
    `onPreviewAnchor` at `:4297`).
- **Grid spec memoised** in DashboardView (`:4274`). A new object on every render would have
  re-sent the configuration to the page on every render.
- The dev bridges (`dev/mock-bridge.ts`, `qa-real-bridge.ts`, `qa-tuning-bridge.ts`) got
  `onPreviewAnchor: () => noop`, for the same reason as `onMenuCommand` in stage 3.

## Tests

- **Renderer** (`npx vitest run`, repo root): **82 files, 1266 passed, 0 failed**. 43 are new:
  - 16 in `src/shared/redlines.test.ts`:
    - rule 1: insets, symmetric anchor order, zero insets skipped, identical boxes;
    - rules 2–3: gaps in both directions, a vertical gap, diagonal with extensions, touching edges;
    - rule 4: overlap;
    - rule 5: formatting;
    - chip placement: centred, past the end, before the start at the edge, clamped;
    - every function rebuilt from its source string.
  - 14 in `src/shared/preview-overlay.test.ts`, running the real scripts in jsdom:
    - ⌥-press and ⌥-click never reach the app and set the anchor;
    - ⌥-click on the anchor or empty space clears it;
    - Esc clears it and is kept from the page; Esc without an anchor reaches the page;
    - a plain click reaches the app; with redlines off, ⌥-click reaches the app;
    - turning redlines off clears the anchor; `clearAnchor` works;
    - HMR re-find, and clearing when nothing matches;
    - drawing into a shadow root outside `<body>`;
    - the hand-off of on/off, palette and scale to the inspector;
    - the inspector capturing clicks when unconfigured (Tauri), letting them through when switched
      off, and exposing `selector`.
  - 12 in `themes/index.test.ts`: ink contrast and hue distinctness × 6 palettes.
  - 1 in `key-routing.test.ts`: ⌘⇧' claimed.
- **Electron** (`electron/`, `npx vitest run`): **32 files, 558 passed, 0 failed**. 2 are new:
  `overlay-fns.test.ts`, and ⌘⇧' in `app-menu.test.ts`.
- **Typecheck:** `tsc --noEmit` (root) clean; `electron npm run typecheck` clean.
- **Builds:** `vite build` (root) builds. `npm run build:main` builds, copies `preview-overlay.js`,
  and its bundle contains no `__name` helper.
- **Suite noise:** the renderer run prints a jsdom "HTMLCanvasElement.prototype.getContext" warning
  from `src/renderer/lib/terminal-activation.test.ts`. That test predates this stage, and the new
  files run clean on their own.

## Deliberately not done

- Measurement in Inspect notes and outgoing messages (§11 step 5).
- ⌘E / ⌘K as menu accelerators, and the spec's three pointer-mode ⌘K entries (§8).
- Toasts over a panel-hosted native view (§10.2), which matters more now that redlines open that
  view in Interact.
- rem display and a box-model tint (§5, not v1).

## Unverified in a real window — and the risks behind it

None of this has been run in the app.

- **Zoom propagation (dev build only).** Chromium keeps zoom per host. In the dev build Operator
  itself is served from `localhost:<port>`, so zooming the inspect view on `localhost:5173` could
  also zoom Operator's window if Chromium ignores the port. The production app loads from a file,
  so it is not exposed. Check once in dev with a scaled preset.
- **Zoom limits and timing.**
  - Chromium clamps zoom to 25%–500%. A preset scaled below 25% would lay out wider than its preset
    and report the wrong widths. The narrowest preview panel (360px) with 1280 is 28%, which is
    inside the range.
  - Between a navigation commit and `did-finish-load`, the page may briefly paint at 100%.
- **F3 behaviour:** with 1280 in a ~640px stage and Inspect on, the page lays out at 1280 (media
  queries, widths), redline numbers match that layout, and hover positions match the pointer.
- **Redlines in the page:**
  - hover chips and insets;
  - ⌥-click anchoring on a real app (buttons, links: no navigation or download on ⌥-click);
  - Esc;
  - chips flipping at the page edges and on elements smaller than their chip;
  - lines staying 1px and chips 10px at 50% scale.
- **Performance:** while anchored, the redline layer is rebuilt every animation frame. It is cheap
  (a few dozen nodes), but not measured on a heavy page.
- **HMR:** anchor an element in a Vite app, edit its component, and check the anchor survives or
  clears.
- **Host switching:**
  - Interact + Redlines opens the native view (clicks reach the app, no inspector outline);
  - switching to Annotate closes it and shows `paused`;
  - switching back reopens it;
  - Inspect + Redlines shows the redline outline instead of the inspector's.
- **Grid inside the page:** with Inspect or redlines on, the columns match the renderer-drawn grid
  (same spec, page viewport minus scrollbar).
- **Theme change:** switching palette while the view is up re-colours chips, lines, the grid and the
  compose card, which should also read correctly on the light palettes.
- **⌘⇧':** toggles with focus in the Console, the iframe and the native view; the accelerator string
  maps to the apostrophe key.
- **⌘K:** "Clear measurement anchor" appears only while anchored, disappears after it runs, and
  disappears on reload or close.
- **Tauri:** only the inspector's restyle applies (the overlay is never loaded there).
