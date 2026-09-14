# Preview in the side panel + design tools (layout grid, redlines) — design

Design lane, 2026-09-14. Spec only, no code changed. Companion mock (interactive, same tokens as
Mission Control light/dark): `dev/results/preview-panel-and-design-tools-mock.html`.

Inputs read: `AppPreviewPanel.tsx`, `DashboardView.tsx` (SessionLayout, panel resize, main-view
overlay, palette actions, key handler), `CanvasPanel.tsx`, `SessionToolbar.tsx`, `lib/chrome.ts`,
`lib/pane-visibility.ts`, `lib/key-routing.ts`, `electron/src/main/preview-inspect.ts`,
`src/shared/preview-inspector.js`, all six palettes, `dev/results/preview-address-bar-design.md`,
and Research's `dev/results/preview-panel-and-overlays-research.md` (worktree `operator-907ac0`).
This spec agrees with Research's recommendation (one preview per session, grid renderer-side,
redlines only through an injected script) and adds the findings in §0 that Research did not cover.

---

## 0. Findings the design rests on

Research's findings are not repeated here. These are additional, from reading the same code:

| # | Finding | Where | Consequence for the design |
|---|---------|-------|---------------------------|
| F1 | The server picker, the port editor and the annotation draft card are absolutely positioned **over the stage**. While Inspect is on, the native `WebContentsView` paints above all renderer DOM, so these three are hidden under it today. | `AppPreviewPanel.tsx:502`, `:557`, `:742` | Rule R1 below: no Operator chrome may overlap the stage while the native view is up. |
| F2 | The panel drag relies on a full-window capture div to keep `mousemove` flowing over iframes. That div is renderer DOM, so it sits **under** the native view. A drag that crosses a panel-hosted Inspect view stops receiving events. | `DashboardView.tsx:5203` | Hide the native view for the length of a panel drag (§2). |
| F3 | The Inspect view is given the stage's **scaled** rect and no zoom. At a preset wider than the stage (1280 in a 640px panel) the page inside the view lays out at 640, not 1280. The iframe path is correct (it scales a 1280 layout); the inspector is not. | `AppPreviewPanel.tsx:291-294`, `preview-inspect.ts:83-85` | Redlines measured in that state would report the wrong widths. Set `webContents.setZoomFactor(scale)` so the CSS viewport equals the preset (§5). |
| F4 | Keyboard events go to the focused frame. When the user has clicked into the iframe or the native view, the window `keydown` handler never fires, so ⌘E, ⌘K and any new shortcut are dead while the page has focus. `electron/src/main` defines no menu `accelerator` at all. | `DashboardView.tsx:3930-3955` | New shortcuts are registered as View-menu accelerators (they fire whichever webContents has focus) and routed to the renderer (§8). |
| F5 | Reload is offered twice in one bar (`⟳` in the nav cluster and `⟳` at the far right). | `AppPreviewPanel.tsx:441`, `:630` | Remove the right-hand one. The bar has to lose width to fit a panel anyway. |
| F6 | Annotate and Inspect can be on at the same time: two click-capturing layers, and the native one covers the pins. | `AppPreviewPanel.tsx:597-627` | Fold Inspect into the mode control so the combination cannot be selected (§4). |
| F7 | Unselected preset and mode labels use `--fg-muted` at 9.5–10px. That is below the 4.5:1 control-label floor on the light palettes (ruled 2026-07-28). | `AppPreviewPanel.tsx:589`, `:608` | New and touched controls use `color-mix(in srgb, var(--fg) 72%, transparent)` for the off state. |
| F8 | The earlier address-bar design proposed a `⋯` overflow menu for tight widths. A menu drops over the stage, so under F1 it would be hidden while Inspect or redlines are on, and it hides the very toggles you flip while looking at the page. | `preview-address-bar-design.md §3` | Superseded: rows wrap, nothing collapses into a menu (§3). |

---

## 1. Panel and main view: one surface that moves

**Decision: the preview is one surface per session. It is either in the main view or in the side
panel, never both.** Choosing it in one place moves it out of the other.

Reasons, in order of weight:

1. The native view is a module-level singleton (`preview-inspect.ts:48`). Two previews would fight
   over one inspector (Research §4).
2. Two iframes of the same dev server are two running copies of the app: two HMR sockets, two
   sets of client state, and two pages that no longer show the same thing after one click.
3. Annotations, the pinned origin, the path and Operator's history are one set per session. Two
   surfaces would each hold their own `useState` copy and drift (Research §4).
4. Nobody needs the same page twice. The job is "Console and Preview visible together", which one
   movable surface does.

### State

No new "where is the preview" field. Location is derived from what already exists, plus one
field to remember which reading tab to return to:

```ts
type PanelTab = 'plan' | 'diff' | 'preview'
type SessionLayout = {
  mainView: 'terminal' | 'preview'
  panelOpen: boolean
  panelTab: PanelTab
  /** The last non-preview tab, so moving the preview out of the panel has somewhere to land. */
  readingTab: 'plan' | 'diff'
  /** Overlay visibility for this session (§5, §6). */
  tools: { grid: boolean; redlines: boolean }
}
```

Invariant: `!(mainView === 'preview' && panelOpen && panelTab === 'preview')`. It is enforced in
one pure function, `applyLayout(prev, patch)` in `lib/`, which `patchLayout` calls. Tested on its
own, the way `loadLayouts` coercion is.

| User action | mainView | panelOpen | panelTab |
|---|---|---|---|
| Toolbar segment **Preview** | `preview` | unchanged | if it was `preview` → `readingTab` |
| Toolbar segment **Console** | `terminal` | unchanged | unchanged |
| Panel tab **PREVIEW** | if it was `preview` → `terminal` | `true` | `preview` |
| Panel tab **PLAN** / **DIFF** | unchanged | unchanged | that tab; `readingTab` updated |
| Panel toggle (toolbar icon) | unchanged | toggled | unchanged |
| ⌘K "Side panel: Preview" | same as panel tab PREVIEW | | |

When the preview leaves the panel, the panel stays open on the reading tab rather than closing.
Open/closed belongs to the panel toggle, and a move should not flip a control the user did not
touch.

`loadLayouts` coercion: a stored layout that violates the invariant keeps the panel placement and
sets `mainView` to `terminal`, because that is the state with both surfaces visible. It also
accepts `'preview'` in the tab allowlist and defaults `readingTab` to `plan` and `tools` to both off.

### Mounting

- DashboardView renders `AppPreviewPanel` in exactly one slot: the main overlay when
  `mainView === 'preview'`, or the panel body when `panelOpen && panelTab === 'preview'`.
  CanvasPanel gets a `preview` branch that renders a child passed in by DashboardView, so the
  dispatch and task callbacks stay where they are wired today.
- `storageKey` stays `main-${session.id}` in **both** slots. It must not become `panel-…`: the pin,
  the path and the annotations would silently reset on every move, and Research found the
  annotation key already reads `main-main-<id>`. Fixing that prefix is a separate migration and is
  not part of this change.
- Moving slots remounts the component, so the iframe reloads. Operator's persisted path and pin
  make it reload at the same address; what is lost is state inside the app (scroll position,
  unsaved form input, routes changed by clicking inside the page). This is acceptable for v1.
  Electron 43's Chromium supports `Element.moveBefore()`, which moves an iframe without reloading
  it; using it needs a host node owned outside React. Worth doing only if the reload bothers the user.
- `paneVisibility` needs no change. With the preview in the panel, `mainView` is `terminal`, the
  terminal is visible, and nothing overlays it. The iframe is in a separate column, which is not
  the overlap case that caused the 2026-08-22 bleed.
- The Console is `active` (receives keys) whenever `mainView === 'terminal'`, including while the
  preview is in the panel. Clicking into the preview moves focus to the page, as it does today.

### Panel header

CanvasPanel's tab row becomes `PLAN 3/5 · DIFF · PREVIEW` in the existing 44px band
(`TOOLBAR_BAND_H`), mono 10px uppercase, accent ink on the active tab, no fill. The preview's own
bars follow underneath in `PANEL_SUBHEAD_H` bands, exactly as they sit under SessionToolbar in the
main view. The 34px actions footer stays under the preview in the panel (empty for this tab) so the
bottom rule lines up with the main column's footer.

---

## 2. Panel width

Plan and Diff read well at 380–460px. A preview needs 375 plus gutter at the least, and 700–900
to see a tablet or desktop layout. One shared width cannot serve both, so the panel remembers two.

| | Reading tabs (Plan, Diff) | Preview tab |
|---|---|---|
| Storage | `operator.canvasWidth` (existing) | `operator.canvasWidth.preview` (new) |
| Min | 300 | 360 |
| Max | 1000 (existing) | `rowW − MIN_CONSOLE_W` |
| First-open default | 460 (existing) | half of `rowW`, clamped |

- `rowW` is the width the content card and the panel share (window minus sidebar and gaps).
  `MIN_CONSOLE_W = 480` is a named constant in DashboardView, to be checked against Claude Code's
  composer in a real window and adjusted there.
- If the window shrinks below what the stored preview width allows, the panel renders at the max
  and **keeps the stored value**, so widening the window again restores it.
- Switching PLAN ⇄ PREVIEW snaps between the two widths with no animation. The terminal refits
  once, through the same `suspendFit` path a panel open already uses.
- **Double-click the resize handle**: set the current tab's width to half of `rowW`.
- **During a drag**, if the native view is up, hide it (`WebContentsView.setVisible(false)`); the
  iframe underneath stays visible, so the user still sees the page. On mouse-up, `move()` to the
  new stage rect and show it (F2). Add `panelW` to the dependencies of the effect that calls
  `previewInspectMove` (Research §3).
- **Scale readout.** When a device preset is wider than the stage, the tools row shows the scale:
  `768 · 62%`. In the panel slot the percentage is a button, `62% → 1:1`, that sets the preview
  width to the preset width (clamped to the max; if clamped, the readout stays). In the main slot
  it is plain text, since the main view's width is not the preview's to change.

---

## 3. Toolbar at every width

The bar has two groups. Their order never changes; what changes is whether they share a row.

- **Address group:** `◀ ▶ ⟳` · `● localhost:5173 ▾` (origin chip, opens the server picker) ·
  path field · `↩` (only when the path is not `/`) · `↗` open in browser.
- **Tools group:** device presets `Fit 375 768 1280` + scale readout · pointer mode
  `Interact · Annotate · Inspect` · hairline divider · `Grid ▾` · `Redlines`.

The tier is chosen from the **measured width of the preview root** (a ResizeObserver on the
component), not from which slot it is in. A narrow main view (sidebar open, wide panel for Plan)
gets the same treatment as a panel.

```
W ≥ 880 — one row (30)
│◀ ▶ ⟳│● localhost:5173 ▾│/pricing                    │↗│ Fit 375 768 1280 │Interact Annotate Inspect│ Grid ▾  Redlines │

520 ≤ W < 880 — two rows (30 + 30)
│◀ ▶ ⟳│● localhost:5173 ▾│/pricing                              │↗│
│Fit 375 768 1280  768·62%          │Interact Annotate Inspect│ Grid ▾  Redlines │

W < 520 — two rows, the tools row wraps to a third line when it has to
│◀ ▶ ⟳│● :5173 ▾│/pricing                │↗│
│Fit 375 768 1280  62% → 1:1   │Interact Annotate Inspect│
│Grid ▾  Redlines                                         │
```

- Thresholds come from the content: the one-row bar measures about 840px with a 160px path
  field; the tools row alone about 460px.
- Below 520 the origin chip drops `localhost` and keeps the port, as the address-bar design already
  specified.
- Mode and overlay controls appear only when `reach === 'up'` (the existing rule for mode). The
  presets are always shown.
- **No overflow menu** (F8). Rows wrap; every control stays one click away and stays visible
  while you look at the page.

### R1 — nothing Operator draws may overlap the stage while the native view is up

Two kinds of chrome, two rules:

- **Tool settings push the stage down.** The grid settings row (§6) is inserted as a band under
  the tools row. You edit a gutter while watching the columns move, so it has to sit beside the
  page, not over it.
- **Transient pickers may overlay, but hide the native view while open.** The server picker and
  the port editor keep their dropdown form. When one opens with the native view up, call
  `setVisible(false)` and show it again on close. The iframe underneath keeps the page on screen.
  The annotation draft card cannot coexist with the native view at all; §4 prevents that state.
- Same hide/show for the ⌘K palette and QuitGuard, which today would open underneath an
  Inspect view that overlaps them.

### Control styling

All from existing tokens; nothing new except the overlay hues in §7.

| Control | Rest | On / selected |
|---|---|---|
| Presets, mode segments, Grid, Redlines | `color-mix(in srgb, var(--fg) 72%, transparent)`, transparent ground | `var(--accent)` ink, transparent ground (segments keep the existing `--overlay-subtle` on the active segment) |
| Mode track | `1px solid var(--border)`, radius 6 (static border, so no dynamic-border-on-radius freeze) | — |
| Divider | `1px × 14px var(--border)` | — |
| Scale readout | mono 9.5px `var(--fg-muted)` (context text, 3:1 floor) | as a button in the panel slot: same ink, `var(--fg)` on hover via token |
| `▾` of `Grid ▾` | same ink as `Grid` | `▴` while the settings row is open |

Glyph audit (two verbs never share a glyph): `◀ ▶` walk Operator's address history, `⟳` reloads
(once, F5), `↩` returns the path to `/`, `↗` opens in the browser, `▾` opens a chooser or settings
for the control it follows (origin chip, grid). Grid and Redlines are text labels, not icons. The
panel's PREVIEW tab and the toolbar's Preview segment both mean "show the preview here", which is
one verb in two places, not two verbs on one glyph. No dock/undock glyph is added: the tab and
the segment already are the move.

---

## 4. Pointer mode and overlays

Two independent axes. Mixing them is what makes F6 possible today.

- **Pointer mode — exactly one:** `Interact` (clicks reach the app) · `Annotate` (pin/box notes) ·
  `Inspect` (click an element to compose a note about it). Inspect moves from a separate button into
  this segmented control; it appears only when there is a URL. ⌘E keeps toggling Interact ⇄ Annotate.
- **Overlays — any combination, in any mode:** `Grid` · `Redlines`. Neither ever intercepts a plain
  click.

Which host draws the page follows from those two:

| | Iframe host (default) | Native view host |
|---|---|---|
| Needed by | Annotate | Inspect, Redlines |
| Grid drawn by | renderer layer inside the stage | injected script, inside the page |
| Redlines | not possible (no DOM access) | injected script |

So the host is the native view whenever `mode === 'inspect' || tools.redlines`, except in Annotate.

**Annotate and Redlines.** Annotate's pins and capture layer are renderer DOM and would be hidden
under the native view. For v1, Annotate wins: the host stays the iframe, redlines stop drawing, and
the Redlines control keeps its on ink with a `paused` suffix in `--fg-muted` mono 9px (title:
"Redlines pause while annotating. Switch to Interact or Inspect to measure."). Leaving Annotate
brings them back. The alternative, moving the pins into the page as well so the native view becomes
the only host, removes the paused state but puts every toast and popover under a native layer; it
is listed in §10 rather than decided here.

---

## 5. Redlines

Figma-style measurement against the live page: the hovered element's size, its distance to its
container, and the distance between two elements.

### Gestures

The same in every mode where redlines draw (Interact and Inspect):

| Situation | Shows |
|---|---|
| Hover element X, no anchor | X's outline + size chip (`240 × 48`) + distances from X to its container's edges |
| **⌥-click** X | X becomes the **anchor** (solid outline, faint fill). The click is captured and does not reach the app. |
| Anchor A set, hover B | A and B outlined, both sizes, distances between A and B |
| Anchor A set, hover A or nothing | A's size + distances from A to its container |
| ⌥-click A again, ⌥-click empty space, or `Esc` | clears the anchor |

⌥-click is the one gesture because a plain click belongs to the app in Interact and to the compose
card in Inspect. Hover measuring needs no modifier: the user switched Redlines on to measure.

**Container** = the nearest ancestor whose border box differs from the element's (wrappers with an
identical box are skipped), measured to that ancestor's **padding-box** edge. Nothing qualifies →
the viewport.

**Inspect + anchor.** When an anchor is set and the user clicks an element in Inspect, the compose
card's context line carries the measurement, and so does the message sent to Console or Tasks:
`↳ PlanCard @ src/Pricing.tsx:42 — 16px below Header`. That lets "make this gap 24" arrive with
the current value attached.

### Distance rules (A = anchor or element, B = hovered or container; rects in CSS px)

1. **One contains the other** → four insets from inner to outer: left, right, top, bottom, each
   drawn through the inner box's centre line. Zero-length insets are not drawn.
2. **Separated horizontally** (`B.left ≥ A.right`, or the mirror) → one horizontal line between the
   facing edges, at the middle of the vertical overlap. With no vertical overlap it runs at A's
   vertical centre, and a dashed extension runs along B's edge to meet it.
3. **Separated vertically** → the same on the other axis. Diagonal neighbours get both lines.
4. **Overlapping, neither contains** → the left-edge offset and the top-edge offset.
5. Values are CSS px: an integer when within 0.01 of one, otherwise one decimal (`12.5`).

### Rendering (in the page, drawn by the injected script)

- Lines 1px `--measure`, 4px end ticks. Extensions 1px dashed
  `color-mix(in srgb, var(--measure) 55%, transparent)`. Anchor fill
  `color-mix(in srgb, var(--measure) 8%, transparent)`.
- Value and size chips: `--bg-surface` ground, 1px `--measure` edge, `--measure-ink` text,
  JetBrains Mono 10px/600 `tabular-nums`, radius 3, padding 1px 4px. An opaque chip is the only way
  a number reads over an arbitrary page; a transparent chip would take the app's colours. It is a
  surface chip, not an accent fill.
- Chips sit centred on their line, flipped inside the viewport at the edges; on a line shorter
  than its chip, the chip moves outside the line's end.
- The script cannot read Operator's CSS variables (different document). The renderer resolves the
  tokens with `getComputedStyle` and passes the values on injection and on every theme change. The
  existing inspector's hardcoded `#7ee787` / `#0b0d10` move to the same passed values in the same
  pass.
- **Zoom.** With `setZoomFactor(scale)` (F3), `getBoundingClientRect` reports CSS px of the preset
  layout, which is what the numbers must be. Lines and chips are drawn inside the zoomed page, so
  they are counter-scaled by `1 / scale` to stay 1px and 10px on screen.
- Recomputed on `scroll` (capture), `resize`, and once per animation frame while an anchor is set;
  paused while the document is hidden.
- After HMR replaces the anchored node, re-find it with the inspector's existing `selector(el)`;
  if nothing matches, clear the anchor.
- v1 is px only. rem display and a box-model (padding/margin) tint are not in v1.

---

## 6. Layout grid

### Model

```ts
type GridSpec = {
  preset: 'auto' | '4' | '8' | '12' | 'custom'
  columns: number        // 1–24
  gutter: number         // px, 0–200
  margin: number         // px, each side, 0–400
  maxWidth: number | null // px ≥ 240, null = none
}
```

### Geometry

One pure function in `src/shared/` (so the renderer and the injected script run the same code),
with tests:

```
containerW = maxWidth ? min(pageW, maxWidth) : pageW
x0         = (pageW − containerW) / 2 + margin
contentW   = containerW − 2 × margin
colW       = (contentW − (columns − 1) × gutter) / columns
column i   = { left: x0 + i × (colW + gutter), width: colW }
```

This is the same box as CSS `max-width; margin-inline: auto; padding-inline: <margin>`, which is
how most app containers are written, so the columns land on real content edges.

Worked example (test fixture): page 1280, max 1200, margin 32, gutter 24, 12 columns →
container 1200, x0 = 40 + 32 = 72, content 1136, column 72.67px. Three cards spanning four
columns each are 362.67px, which is exactly `(1136 − 2 × 24) / 3`. If `colW ≤ 0` nothing is drawn
and the settings row says "Columns don't fit at this width".

### Presets

| Preset | Columns | Gutter | Margin |
|---|---|---|---|
| 4 | 4 | 16 | 16 |
| 8 | 8 | 24 | 32 |
| 12 | 12 | 24 | 32 |
| **Auto** (default) | 4 below 600px page width, 8 from 600, 12 from 840 | per tier | per tier |

Auto uses Material 3's window-size breakpoints, which means the device presets move it: 375 → 4,
768 → 8, 1280 → 12, and Fit follows the panel width. `maxWidth` applies across all tiers. Editing
any field switches to Custom; picking a preset overwrites the fields.

### Persistence

- **Spec: per project**, in `projects.json` as `Project.previewGrid?: GridSpec`, written through
  the existing `updateProject(id, patch)`. The grid describes the project's layout system, so every
  lane in the project should see the same one, and it should survive a localStorage reset.
- **Visibility: per session**, in `SessionLayout.tools.grid`. A new lane starts with the grid off.
- A session with no project (the `projId && projects.some(...)` gate in DashboardView fails) uses
  Auto in memory; the settings row says `Not saved — this session has no project`.

### Rendering

- Column fill `color-mix(in srgb, var(--grid) 10%, transparent)`, no column edges, margins
  unfilled. When `maxWidth` clamps, the container edges get a 1px dashed
  `color-mix(in srgb, var(--grid) 45%, transparent)` line.
- Full viewport height, fixed to the viewport (columns do not scroll with the page),
  `pointer-events: none`, below redlines, above the page.
- **Iframe host:** a layer inside the stage, laid out at page px in a wrapper with the same
  `transform: scale()` as the iframe. It cannot see the page's scrollbar, so with classic scrollbars
  the columns run up to 15px wider than the page's real viewport. macOS overlay scrollbars (the
  default) make this 0. Noted, not fixed.
- **Native view host:** drawn by the injected script from `document.documentElement.clientWidth`,
  which excludes the scrollbar.

### Settings row

`Grid ▾` inserts a 30px band under the tools row (R1: it pushes the stage, never covers it). It
wraps to two lines below 520px.

```
│ Auto 4 8 12 Custom │ Columns [12] Gutter [24] Margin [32] Max width [1200] │ 72.67px columns · Saved to operator │ Done │
```

- Preset segment styled like the mode control. With Auto selected, the fields show the values Auto
  resolved for the current page width, and a hint `Auto → 8` names the tier.
- Number fields: the path field's style (mono 11px, `--overlay-subtle` ground, transparent 1px
  edge that changes on focus, no focus ring), 44px wide, `tabular-nums`. ↑/↓ ±1, ⇧↑/⇧↓ ±8. Max width
  empty = none (placeholder `none`). Invalid input reverts on blur; `Esc` reverts.
- The column-width readout is the number people need while tuning, so it sits in this row.
- Opening the row turns the grid on. `Done` or `Grid ▴` closes it.

---

## 7. New tokens

Two overlay hues per palette, each chosen from the palette's own ANSI set to stay clear of that
palette's accent, plus one derived ink.

| Palette | `--accent` | `--measure` | `--grid` |
|---|---|---|---|
| Mission Control | `#2fe39a` | `var(--magenta)` `#c98bff` | `var(--red)` `#ff5f56` |
| Mission Control light | `#0ca678` | `var(--magenta)` `#8e44ad` | `var(--red)` `#c0392b` |
| 1984 | `#46BDFF` | `var(--magenta)` `#F806FA` | `var(--yellow)` `#FFEA16` |
| 1984 light | `#0098fd` | `var(--magenta)` `#F806FA` | `var(--yellow)` `#FF8D01` |
| Mr Pink | `#D58FDB` | `var(--cyan)` `#8FC8FF` | `var(--yellow)` `#FAD481` |
| Mr Pink light | `#a21caf` | `var(--blue)` `#2563eb` | `var(--yellow)` `#b8860b` |

- `--measure-ink: color-mix(in srgb, var(--measure) 70%, var(--fg))` in `styles.css`, the same
  construction as `WARN_INK`. It must clear 4.5:1 on `--bg-surface` in all six palettes; 1984
  light's `#F806FA` is the likeliest to need a different mix. Measure with
  `dev/drive-theme-pass.mjs` and adjust per palette, not globally.
- Red for the grid is Figma's convention and appears only as a 10% column fill over a page, where
  it does not read as an error state.
- Grid and redlines on together must stay distinguishable: the table gives them different hues in
  every palette.

---

## 8. Shortcuts and ⌘K

### Shortcuts

| Chord | Action | Note |
|---|---|---|
| ⌘E | Interact ⇄ Annotate | existing |
| ⌘' | Show / hide layout grid | Illustrator and Photoshop use ⌘' for "show grid" |
| ⌘⇧' | Show / hide redlines | paired with the grid chord |
| Esc (page focused) | Clear the redline anchor | handled inside the page |

- Registered as **View menu items with accelerators** in Electron, sent to the renderer over IPC,
  so they work while the page has focus (F4). Moving ⌘E and ⌘K there too fixes the same dead-key
  problem for them.
- Add `'` to `isAppChord` so the terminal declines ⌘' / ⌘⇧' when the Console has focus.

### ⌘K entries

Labels follow the existing palette style (`Side panel: Plan`, `' ✓'` on the current state, `hint`
for the chord).

**View** (whenever there is an active session):

| id | Label | Run |
|---|---|---|
| `view-preview` | Show Preview ✓ | existing; now moves it to the main view |
| `panel-preview` | Side panel: Preview | open panel on PREVIEW (moves it) |

**Preview** (new group, only while a preview is mounted in either slot):

| id | Label | Hint |
|---|---|---|
| `preview-mode-interact` / `-annotate` / `-inspect` | Preview: Interact mode ✓ / Annotate mode / Inspect mode | ⌘E on the first two |
| `preview-grid` | Preview: Show layout grid / Hide layout grid | ⌘' |
| `preview-grid-auto` / `-4` / `-8` / `-12` | Preview: Grid — Auto (4 · 8 · 12) ✓ / 4 columns / 8 columns / 12 columns | also turns the grid on |
| `preview-grid-edit` | Preview: Edit layout grid… | opens the settings row |
| `preview-redlines` | Preview: Show redlines / Hide redlines | ⌘⇧' |
| `preview-redlines-clear` | Preview: Clear measurement anchor | only while an anchor exists |
| `preview-device-fit` / `-375` / `-768` / `-1280` | Preview: Device — Fit ✓ / 375 / 768 / 1280 | |
| `preview-match-width` | Preview: Match panel to device width | only in the panel, only when scaled |
| `preview-reload` | Preview: Reload | |
| `preview-open-external` | Preview: Open in browser | |

The existing single `preview-annotate` toggle entry is replaced by the three mode entries.

---

## 9. States to verify

Both themes × three identities, and each of these, in the main slot and in a 360px panel:

- **No server / checking / foreign port.** The centred empty states (max 320px text) fit at 360.
  Mode and overlay controls are hidden when nothing is up; their on/off state is kept for when the
  server comes back.
- **Overflow.** Long path: ellipsis inside the field. Origin chip at 190px max, `localhost` dropped
  under 520. Tools row wraps. Settings row wraps. Redline chips flip inside the viewport at the
  page edges and on elements smaller than the chip.
- **Scaled preset.** 1280 in a 640 panel: grid scaled with the page; redline numbers report 1280-
  layout px (F3); readout `1280 · 50%`; `→ 1:1` clamps at `rowW − 480`.
- **Both overlays on.** Grid under redlines, hues distinct per §7.
- **Annotate with Redlines on.** Paused suffix shown; no native view; pins visible.
- **Moves.** Preview main → panel → main: path, pin and annotations survive; the Console becomes
  visible; the panel lands on the last reading tab; widths are remembered per tab.
- **Native view hygiene.** Panel drag, server picker, ⌘K palette and QuitGuard each hide the view and
  restore it at the right rect afterwards.
- **Contrast.** `--measure-ink` on `--bg-surface` and every control label in the new rows, run
  through `dev/drive-theme-pass.mjs`.

GUI verification is the user's (or the Playwright harnesses'); none of this has been exercised in
a real window.

---

## 10. Open questions

1. **Reload on move.** Ship with the remount reload, or build the `moveBefore()` host now?
   Recommendation: ship with reload.
2. **Toasts over a panel-hosted native view.** Toasts sit bottom-right, over the panel. Hiding the
   view for every toast would flicker the page. Recommendation: while the native view is up in the
   panel, toasts anchor to the main column's bottom-right instead.
3. **One host.** Moving Annotate's pins into the page would let the native view host everything
   and remove the paused state, at the cost of R1 applying to every popover all the time. Decide
   after redlines have been used for a while.
4. **Grid from the project's CSS.** Reading `max-width`/gap from a Tailwind config or CSS variables
   to prefill the spec. Not in v1.

---

## 11. Build order (for Code)

1. **Layout.** `PanelTab` gains `preview`; `readingTab` and `tools` fields; `applyLayout` pure
   function + tests; `loadLayouts` coercion; CanvasPanel preview branch; two panel widths with the
   `rowW − 480` clamp and double-click split; ⌘K View entries. *Verify:* Console and Preview visible
   together; moves both ways keep path, pin and annotations.
2. **Toolbar.** Measured tiers; Inspect folded into the mode segment; duplicate `⟳` removed;
   control-label ink (F7); R1 hide/show for picker, port editor, palette, QuitGuard and panel drag;
   `panelW` in the inspector move effect.
3. **Grid.** Shared geometry function + the worked-example test; renderer layer for the iframe
   host; settings row; `Project.previewGrid`; presets and Auto; ⌘' via menu accelerator; ⌘K grid
   entries; `--grid` tokens.
4. **Native-view tools.** `setZoomFactor(scale)`; token hand-off to the page; grid in the page;
   redlines with anchor, rules and counter-scaling; ⌘⇧'; `--measure` tokens and contrast pass.
5. **Measurement in notes.** Inspect compose card and outgoing message carry the anchor distance.
