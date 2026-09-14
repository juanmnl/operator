# Preview in the right panel + design overlays — research

Scope: map today's Preview implementation to answer whether it can (a) render in the
session right panel beside Console, and (b) grow redline/grid design overlays. Read-only —
no code changed.

## 1. Iframe vs native view — is there a native inspector view the renderer can't draw over?

- **Normal preview = a plain `<iframe>`.** `AppPreviewPanel.tsx:690` (fit) and `:692-702`
  (scaled preset) both render a cross-origin `<iframe src={display}>` inside `data-preview-stage`
  (`:680-687`). It's regular DOM — renderer overlays composite normally over it *except* for the
  Chromium out-of-process-compositing caveat in finding 2.
- **Inspect mode = a separate native `WebContentsView`.** `electron/src/main/preview-inspect.ts:58-68`
  creates a `new WebContentsView(...)` and `win.contentView.addChildView(view)` (`:78`) — a real
  child view of the OS window, positioned by `setBounds` (`:84`), completely outside the DOM/React
  tree. `AppPreviewPanel.tsx:294` calls `window.operator.previewInspectOpen?.(display, r.left, r.top, r.width, r.height)`
  keyed off `stageRef`'s `getBoundingClientRect()`.
- **Consequence:** while Inspect is on, the renderer CANNOT draw anything on top of that native
  view — no CSS, no React portal, nothing in the web layer paints above an Electron
  `WebContentsView` (it's compositor-level above the browser's own web contents, same reason the
  comment at `preview-inspect.ts:1-13` gives for why it replaced Tauri's beacon hack: it isn't
  part of the DOM at all). Any redline/grid overlay drawn by the renderer would be UNDER the
  inspector view, invisible. Overlays must either (i) run only in normal (non-Inspect) iframe
  mode, or (ii) be drawn by an injected script inside the WebContentsView itself (see §2), the
  same way `preview-inspector.js` already draws its hover box.

## 2. Can the renderer overlay the iframe, and can it read the previewed page's DOM?

- **Overlay: yes, today, in iframe mode.** The annotation pin layer, the rubber-band capture div,
  and the draft-note popover already do exactly this — `AppPreviewPanel.tsx:707-724` (pins),
  `:727-739` (capture overlay), `:742-790` (popover) — all absolutely positioned children of
  `stageRef` (`data-preview-stage`, `:680-687`), the same "one coordinate system" the comment at
  `:353-364` documents. This is the pattern a redline/grid overlay would reuse.
- **⚠ One documented failure mode to inherit, not re-trigger:** `pane-visibility.ts:1-16` records
  a real 2026-08-22 bug where a cross-origin iframe, composited out-of-process by Chromium, ended
  up compositing ABOVE the (still-mounted, `visibility:hidden`) terminal underneath it — not a
  simple z-index case. The current fix is discipline (only one of Console/Preview is ever
  `visible` at a time via `paneVisibility`, `DashboardView.tsx:4980`), not a z-index guarantee.
  A grid/redline overlay sitting *above* the iframe within the SAME pane is a normal DOM
  sibling-order case (unaffected — it's the terminal-underneath case that broke), but this is the
  precedent to keep in mind if Preview and Console ever need to coexist visually (§4).
- **Reading element boxes cross-origin: NO, not from the renderer.** `annotations.ts:1-8` states
  the constraint directly: *"the preview is a cross-origin iframe (the dev server), so we CAN'T
  read its DOM for a CSS selector or screenshot its content"* — hence Annotate mode only stores
  resolution-independent percentages (`xPct`/`yPct` of the page box) plus session-side context
  (URL, device preset, pixel viewport), never a live element handle. `preview-history.ts`'s own
  comment (`AppPreviewPanel.tsx:91`) repeats it: *"the preview is cross-origin, so
  `contentWindow.history` throws."*
- **Real element measurement = injected script, exactly like `preview-inspector.js`.** That file
  (`src/shared/preview-inspector.js`) is the existing proof of the pattern: injected via
  `executeJavaScript` into the (same-machine-owned) `WebContentsView` after `did-finish-load`
  (`preview-inspect.ts:73-77`), it reads `getBoundingClientRect()` on real elements
  (`preview-inspector.js:127`) and beacons results out over a preload-bridged IPC channel
  (`preview-inspect.ts:38-46`, `preview-inspector.js:51-61`). A redline feature that needs true
  DOM distances (not just percentage-of-viewport pin math) has no other path than this same
  inject-and-measure route through a `WebContentsView` (or reusing Inspect mode's element data).
  A grid overlay, by contrast, needs no page DOM access at all — it only needs the stage's own
  pixel box (`pageBox`, `AppPreviewPanel.tsx:387`), so it can be pure renderer-side CSS/SVG like
  the pins.

## 3. What breaks if Preview moves into the right panel

- **Bounds tracking for the native Inspect view:** `AppPreviewPanel.tsx:300-309` re-measures
  `stageRef.getBoundingClientRect()` and calls `previewInspectMove` on every `[box, preset,
  inspecting]` change, via `requestAnimationFrame`. This already fires on ANY layout change of
  the stage, panel-driven or not — so a panel-hosted Preview keeps working as long as `stageRef`
  still lives somewhere DOM `getBoundingClientRect()` can see (it doesn't care whether the parent
  is the main content area or the right panel). The panel-resize drag (`DashboardView.tsx:357-373`,
  `panelW`) would need to be added to that effect's dependency list (or the ResizeObserver on
  `frameWrapRef`, `AppPreviewPanel.tsx:222-233`, needs to also observe the panel container) so a
  panel-width drag repositions the inspector view live — today nothing drives that effect off
  `panelW`.
- **Terminal resize / SIGWINCH / orb wake-up:** Preview moving to the panel does not touch the
  terminal directly — Console stays in the main content area (`mainView` would presumably become
  panel-independent, or Preview simply always shows in the panel while Console owns the main
  area, see §4). What DOES change is the main area's WIDTH whenever the panel opens, closes, or
  resizes — and that mechanism already exists and is exercised today for Plan/Diff:
  `suspendFit={resizingPanel || windowResizing || sidebarAnimating}` (`DashboardView.tsx:5010`)
  passed into `TerminalSurface`, which threads to `TerminalPane.tsx:71-72,115,639-643` — resize
  events are swallowed while `resizingPanel` is true and one `handleResize()` fires when the drag
  ends (`TerminalPane.tsx:642`). This is the same mechanism the "orb wake-up" memory note
  describes (any pty byte / resize forces `phase=running` briefly) — a panel-hosted Preview adds
  no new case here, it reuses the existing panel-open/close/resize → terminal-refit path
  unchanged.
- **`pane-visibility.ts` (`paneVisibility`) is main-area-only** — it only decides whether a
  terminal PANE is visible relative to `mainView` (`'terminal' | 'preview'`) in the main content
  stack (`DashboardView.tsx:4980`). It has no concept of the right panel at all. If Preview moves
  to the panel while Console stays in `mainView='terminal'` permanently, `paneVisibility` and the
  whole overlay-not-unmount mechanism becomes dead code for Preview's purposes (Console is now
  ALWAYS the visible main-area occupant) — though the function might still gate other overlays
  (activity/diff) so it likely shouldn't be deleted outright, just no longer driven by a
  Preview-vs-terminal toggle.
- **Annotations, storageKey scoping:** `AppPreviewPanel` is keyed by `storageKey` passed in as
  `main-${activeSession.id}` (`DashboardView.tsx:5057`) and used to build `annKey` (`:120`,
  `` `main-${storageKey}` `` — so today's actual localStorage key is `main-main-${session.id}`,
  worth fixing regardless). Moving the component into the panel just needs a different
  `storageKey` literal (e.g. `panel-${activeSession.id}`) — the annotation/override/path
  persistence code (`annotations.ts:41`, the override/path `localStorage` keys at
  `AppPreviewPanel.tsx:56,77`) has no assumption baked in about WHICH visual slot the panel
  occupies, only that the key is stable per session. No structural change needed, just a
  different prop value — and note existing per-session pins would need a one-time key migration
  or they'd silently reset for users who used Preview before the move.
- **History/address bar (`preview-history.ts`):** Pure state (`emptyHistory`/`pushEntry`/`goBack`/
  `goForward`), no DOM/layout coupling at all (`preview-history.ts` is 68 lines of plain
  functions) — moving the component changes nothing here.
- **Per-session layout persistence (`SessionLayout`, `DashboardView.tsx:131,156`):** currently
  `{ mainView, panelOpen, panelTab }`, and `panelTab` is typed `'plan' | 'diff'`
  (`DashboardView.tsx:130`, enforced again at `:169` `loadLayouts`'s tab whitelist and `:297`
  `panelTabs`). Adding Preview as a panel tab means widening `PanelTab` to include `'preview'`
  and updating the `loadLayouts` migration allowlist (`:169`) the same way `mainView`'s own
  migration comment at `:159-163` describes doing when `'chat'`/`'files'` were dropped from
  `MainView` — this codebase already has a precedent/pattern for that kind of persisted-enum
  migration.
- **CanvasPanel (`src/renderer/components/session/CanvasPanel.tsx`)** is currently the only thing
  mounted in the right-panel slot (`DashboardView.tsx:5193-5198`, given `tabs={panelTabs}` and
  `mode={effPanelTab}`) — it would need a third render branch for `'preview'` that mounts
  `AppPreviewPanel`, or `AppPreviewPanel` gets mounted as a panel-level sibling the way it already
  is in the main area today (`DashboardView.tsx:5046-5064`), gated on `panelTab === 'preview'`
  instead of `mainView === 'preview'`.

## 4. Preview in the panel while `mainView` stays `'terminal'` — and cost of two simultaneous previews

- **Yes, structurally straightforward** — `mainView` (main content area) and the right panel are
  already two independent pieces of `SessionLayout` state (`DashboardView.tsx:131`) rendered in
  two separate DOM subtrees (main content stack `:4958-5068` vs. side panel `:5183-5200`). Nothing
  currently couples them; `mainView==='terminal'` today just means the panel — if open — shows
  Plan/Diff. Extending `panelTab` to include `'preview'` lets Preview live in the panel with
  `mainView` pinned to `'terminal'`, no interaction between the two enums to resolve.
- **Cost of a second simultaneous instance of `AppPreviewPanel`** for the SAME session (one in
  panel, one still in main area, both mounted at once) rather than an either/or:
  - **Double everything AppPreviewPanel already polls/holds per mount:** the 4s `sessionPorts`
    poll (`AppPreviewPanel.tsx:151-169`), the reach-check ping loop re-firing every 2-3s while
    down/up (`:191-215`), its own `ResizeObserver` (`:222-233`) — none of this is shared across
    instances, it's all local component state keyed by closures, not a singleton store. Two
    mounts = 2x the polling traffic to `window.operator.sessionPorts`/backend for identical data.
  - **Two independent Inspect-mode native views is the sharper cost.** `preview-inspect.ts`'s
    `view` is a **module-level singleton** (`let view: WebContentsView | null = null`,
    `:48`) — `open()` reuses the existing view if one exists (`:56`, `if (view) { move(...); return }`).
    Two `AppPreviewPanel` instances both calling `previewInspectOpen` would fight over the SAME
    native view/bounds — whichever mount's `useEffect` (`:286-296`) last fired wins the position,
    and toggling Inspect in one instance's UI would silently move/resize the OTHER instance's
    inspector, or one instance's "Inspect ⧉" button would appear off while the shared view is
    actually being driven by the other panel. This needs either a per-instance-id-scoped
    WebContentsView (multi-view support, more Electron-side bookkeeping and z-order/bounds
    management) or a hard rule that Inspect can only be active in ONE Preview instance at a time,
    surfaced in the UI (disable/grey the other's Inspect button while one is open).
  - **Annotations would double-render/diverge** unless both instances are given the identical
    `storageKey`/`annKey` — which they safely can be (annotations are pure localStorage state,
    not view-local), but then a pin placed in the panel-preview and the main-preview must be
    understood as literally the same list, not two independent punch-lists — worth being explicit
    about in the panel-preview's UI copy so it doesn't read as "two different preview surfaces
    with their own notes."
  - **history/override/path state is NOT shared** — each mount has its own `useState` for
    `override`/`pathInput`/`history` even though they read/write the same `localStorage` keys on
    mount/session-switch; the two instances would only agree at mount time, then drift
    independently as each is driven (typing a path in one wouldn't live-update the other's
    `pathInput` state, only the eventually-committed localStorage value the OTHER instance won't
    re-read until its own session-switch effect re-fires). This is the same class of staleness
    the file already fights for cross-session switches (`:65-71` comment), just now
    cross-instance-same-session too.
  - **Recommendation:** unless there's a strong product reason for two live previews of one
    session at once, treat "Preview in panel" as a THIRD state of a single mainView-like
    selector rather than an additional simultaneous surface — i.e. Preview lives in the panel
    OR the main area, never both for the same session at the same time. That keeps
    `AppPreviewPanel` a true singleton per session (matching the existing `preview-inspect.ts`
    singleton assumption) and avoids inventing multi-instance-safety for polling, Inspect, and
    the still-per-mount override/path/history state.

## Summary for the redline/grid overlay design

- **Grid overlay** (toggleable column grid): pure CSS/SVG sibling of the iframe inside
  `data-preview-stage` (`AppPreviewPanel.tsx:680-687`), positioned against `pageBox`
  (`:387`) — same pattern as the existing pin layer. No cross-origin DOM access needed. Must be
  suppressed while Inspect mode is on (native view paints over it, §1) — or simply hidden
  whenever `inspecting` is true, same as annotations already conditionally render only
  `annotating && ...` (`:707,727`).
- **Redlines** (hover/select distance measurements between elements): needs real element
  boxes, which the iframe cannot give the renderer directly (§2). Two options: (a) piggyback on
  Inspect mode's existing `WebContentsView` + injected script (extend `preview-inspector.js`'s
  `mousemove` handler, which already computes `getBoundingClientRect()` per hovered element at
  `preview-inspector.js:123-132`, to also beacon a second element's box for distance math, and
  draw the measurement lines in the injected script itself since nothing outside that view can
  paint over it) — this is more work but reuses working infra; or (b) a lighter but
  looser measurement mode inside the plain iframe path using only the pin/percentage system
  already in `annotations.ts` (distance between two dropped pins, computed from their `xPct/yPct`
  against `pageBox` — no real element boxes, just pin-to-pin geometry) — cheaper, but is not true
  "hover to see the distance to the nearest edge" redlining, it is pin-to-pin measurement.
