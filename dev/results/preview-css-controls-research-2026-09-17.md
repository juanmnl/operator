# Live CSS controls in Preview — "CSS controls like DialKit" (2026-09-17)

Research only, no code changed. Feeds a Design brief on adding live style controls to Inspect
mode: select an element, tweak it with sliders/steppers/color pickers, see it change in the page,
then send the change to an agent that propagates it into source.

Every claim is tagged **VERIFIED** (a primary source was found) or **INFERRED** (reasoning from
verified facts, or a secondary/anecdotal source). This report ran as three parallel research
passes (comparable tools; DOM→source mapping; CDP CSS domain); one important fact came from
reading Operator's own code directly, not research — flagged below because it changes the shape
of §4 significantly.

**Read first, changes everything downstream:** `src/shared/preview-inspector.js:74-90` already
walks the React fiber (`__reactFiber$*` / `__reactInternalInstance$*`) up through `_debugOwner`/
`return` to find `_debugSource` (`{fileName, lineNumber}`) and the owning component's display
name. This is **already** a working DOM→React-source mapping, used today only to label the
Inspect compose card (`⧉ Button @ Hero.tsx:42`) and to populate `data.component`/`data.source` in
the beacon payload sent to Console/Tasks. Every tool in §1 below (Onlook especially) builds
something equivalent from scratch with a build-time instrumentation step; Operator gets it for
free at runtime, in dev mode, with zero build config, because React attaches `_debugSource` to
fiber nodes itself in development. This means §4's hardest problem is already solved for React
apps — the work is control UI and the write-back path, not source-location discovery.

---

## 1. What "CSS controls like DialKit" and comparable tools actually do

- **DialKit** — VERIFIED real but not what the name suggests. [joshpuckett/dialkit](https://github.com/joshpuckett/dialkit)
  is a small dev-only in-app sidebar (`<DialRoot />`) of sliders/toggles bound to a "tweakers
  store" the *developer* wires up in advance — it tunes values you've already exposed (a debug
  panel, Tweakpane-style), live, no reload. It is **not** a DOM element picker and does **not**
  write to source. The user's framing ("CSS controls like DialKit") most likely means the control
  *feel* (dials/sliders/live), not DialKit's actual point-at-anything-and-edit model — worth
  clarifying with the user, since the nearest real prior art for what they described is Onlook,
  not DialKit.
- **VisBug** — VERIFIED, [GoogleChromeLabs/ProjectVisBug](https://github.com/GoogleChromeLabs/ProjectVisBug)
  (Adam Argyle/Chrome team). Browser extension/bookmarklet, works on *any* live page (no dev
  access needed). Select an element, drag handles for margin/padding, flex/alignment controls,
  inline-editable text, color picker — live DOM/CSSOM edits. **Does not write to source**; changes
  vanish on reload. This is the closest match for "controls that feel like direct manipulation,"
  but has no write-back story at all — Operator needs to go further.
- **Chrome DevTools Styles/Computed + Changes panel** — VERIFIED,
  [Workspaces docs](https://developer.chrome.com/docs/devtools/workspaces),
  [Overrides docs](https://developer.chrome.com/docs/devtools/overrides). Two distinct mechanisms:
  **Local Overrides** shadow-copies served files to disk and serves the edited copy on reload
  (persists, but isn't "real" source); **Workspaces** maps served files to actual on-disk source,
  so Styles-panel edits write directly to the real file. The **Changes panel** (⌘/Ctrl+Shift+P →
  "Show Changes") is a diff view of everything edited since load — exactly the shape of "before/after"
  Operator would want to hand an agent.
- **Onlook — the closest real prior art for the whole feature.** VERIFIED,
  [onlook-dev/onlook](https://github.com/onlook-dev/onlook) (Apache-2.0), "Cursor for Designers,"
  targets React/Next.js + Tailwind specifically. Runs the project in a sandboxed container, and —
  per its own docs — "instruments code to map elements to their place in code" (build-time
  attribute injection, source-map-like), then a visual edit resolves the clicked element back to
  its JSX and **patches Tailwind classes/JSX via AST edit, not a runtime wrapper**, triggering HMR;
  larger edits go through an AI diff layer (Morph Fast-Apply). This is the validated shape of
  "select in a live preview → edit → write to source" — Operator's version differs mainly in that
  it doesn't need Onlook's build-time instrumentation step for React apps (see the fiber-walk note
  above), and can dispatch the edit to an agent turn instead of doing the AST patch itself.
- **tweakcn** — VERIFIED, [jnsahaj/tweakcn](https://github.com/jnsahaj/tweakcn),
  [tweakcn.com](https://tweakcn.com/). Sliders/color pickers for a shadcn/ui theme (palette,
  radius, typography), live preview on real components, **writes to CSS custom properties**,
  exported on demand — a token/config-export model, not live source-file patching. Relevant mainly
  for §2's control taxonomy and the "snap to a token" idea.
- **Figma Dev Mode** — VERIFIED, [Figma docs](https://help.figma.com/hc/en-us/articles/15023124644247-Guide-to-Dev-Mode).
  Inspection only, not live-editing. Reference control taxonomy: box model (margin/border/padding),
  flex properties from auto-layout, typography, color/radius, with **variable/token names shown
  and clickable** — the strongest precedent for §2's "snap to token" behavior.
- **Webflow/Framer style panels** — INFERRED (not re-fetched this pass, general product
  knowledge, consistent with Figma's set): box model, size (fixed/fill/hug), flex/grid
  (direction/align/justify/gap/tracks), typography, fill/color with token binding, radius
  (per-corner), shadow (multi-layer), opacity/blend. This is the de facto standard control set
  across every visual tool surveyed — used directly as §2's baseline.
- **Builder.io Visual Editor** — VERIFIED but a different shape: drag-drop over Builder's own JSON
  content schema via registered component `.mapper` files, not live-patching arbitrary existing
  source. Not close prior art for this feature.

---

## 2. Control set: layout vs component

Using Figma Dev Mode's + Webflow/Framer's taxonomy (§1) as the baseline, mapped onto redlines'
existing measurement math (`preview-overlay.js:82-126`, `containerOf()`/`measureBetween()`) and
what's realistic to compute from `getComputedStyle`/`getBoundingClientRect` inside the existing
injected script:

| Control | Applies to | Input | Reuses existing code |
|---|---|---|---|
| **Box (margin/padding/gap)** | any element | drag handles on the redline outline (like today's measure lines, but draggable) + numeric steppers per side | `preview-overlay.js` already draws these exact lines for *measurement*; making them draggable is the same geometry, new: pointer capture + writing the value back |
| **Size (w/h)** | any element | drag handles at box corners/edges + numeric fields, with a "fixed / fill / hug (auto)" mode toggle | `boxOf()`/`outline()` already compute the box each frame |
| **Flex/grid** | a flex/grid **container** (detected via `getComputedStyle(el).display`) | direction, align-items, justify-content, gap as button groups; grid: column/row track editor (start simpler — column count + gap) | new — no existing analog |
| **Typography** | text-bearing elements | font-size/line-height as steppers, weight as a segmented control, family as a searchable list (seeded from the page's already-loaded `document.fonts`) | new |
| **Color / tokens** | any color-bearing property (bg, text, border) | color picker, **snap-to-token**: read all `--*` custom properties visible on `:root` and the element's own computed style, compare the picked/current value, and if it matches show the token name instead of the raw value (Figma Dev Mode's exact pattern) | new, but cheap — `getComputedStyle(document.documentElement)` already gives every custom property as a live map |
| **Radius** | any element | per-corner steppers + a "link corners" toggle | new |
| **Shadow** | any element | offset x/y, blur, spread, color as a compact multi-field row (defer multi-layer authoring to v2, see below) | new |
| **Opacity** | any element | single slider | new, trivial |

**Layout vs component distinction**, concretely: a "layout" pick is a flex/grid container or a
box-model edit (margin/padding/gap/size) — these tend to be edited on the *specific instance*
because layout is usually one-off. A "component" pick is typography/color/radius/shadow on a
recognized React component (the fiber walk already tells you this — `source(el).component`) —
these are more often edited "for every instance of this component," which is the scope question in
§3.

---

## 3. Applying edits live, inside Operator's own architecture

Read against `electron/src/main/preview-inspect.ts` and `src/shared/preview-overlay.js`, which
already solve two of the four sub-problems here (persistence-across-HMR and a redraw/measurement
loop), just for a different purpose (read-only redlines, not editable style).

- **Inline style vs injected stylesheet rule — use an injected rule, not inline style.**
  Setting `el.style.setProperty(...)` directly is simplest but (a) loses to any `!important` or
  higher-specificity rule the app's own CSS already has, (b) gets silently wiped whenever
  React/Vue re-renders that element with a fresh `style` prop (common — many components compute
  their own inline styles), and (c) can't be scoped to "all matching instances" without touching
  every DOM node individually. Instead: at pick time, tag the element with a generated attribute
  (`data-op-edit="<uid>"`), then maintain **one `<style id="__op_edits">` element** the injected
  script owns, writing/replacing a rule per edited element: `[data-op-edit="<uid>"] { ... }`. This
  is the same idea as CDP's `CSS.addRule` into a dedicated "via-inspector" stylesheet (§5) — a
  generic-web version of the identical pattern, and it survives re-renders that only touch the
  element's own inline `style` prop (the attribute and the external rule are untouched).
- **Surviving HMR specifically (harder than a plain re-render):** Vite/React Fast Refresh can
  **remount** the element entirely, which drops the `data-op-edit` attribute since it's not in the
  component's JSX. Redlines already hit exactly this problem for its anchor (`preview-overlay.js:160-164`:
  "HMR replaces nodes. An anchor that left the document is found again by its selector, or
  cleared") and solves it by storing a CSS *selector* (`ins.selector(n)`, from `preview-inspector.js:62-73`)
  as a fallback re-anchor key. The edit system needs the same pattern: store both the generated
  `data-op-edit` id and the structural selector; on `did-finish-load`/a `MutationObserver` firing
  after HMR, re-find the element by selector and re-tag it if the attribute is gone, then re-apply
  the rule. This is not a new architecture — it's the existing anchor-recovery logic
  (`preview-overlay.js:190-200`, `setAnchor`) generalized to editable elements.
- **Undo/reset:** keep an in-memory edit stack in the injected script (parallel to how
  `annotations.ts` keeps a per-session list, but this one is page-local and doesn't need to survive
  a reload — a reload reverts to source-truth anyway, which *is* the reset). Reset = delete that
  element's rule from `__op_edits` and drop the tag. Undo = pop the last property change off the
  stack for the active element and reapply the remaining ones. No new persistence layer needed:
  the moment an edit is "sent" (§4), the source of truth moves to the agent's actual source-code
  change, and the next HMR reload naturally replaces the live patch with the real one.
- **Scope — this element vs all matching:** "this element" is the `data-op-edit` id path above.
  "All matching the component" needs a *different* selector strategy than the DOM-structural one
  `selector()` computes (`div:nth-of-type(3) > span:nth-of-type(1)`, which is instance-specific by
  construction) — it needs the **component identity** from the fiber walk
  (`source(el).component`) plus, realistically, a shared class name if the component applies one
  (common with Tailwind/CSS-modules). Practical v1 approach: offer "this element" only; "all
  instances of `<Component>`" is a v2 item because it requires either (a) walking the fiber tree to
  find every mounted instance of the same component type — expensive and fragile mid-edit — or (b)
  sending "apply to component" as an *instruction* in the payload and letting the agent's source
  edit naturally apply to the component definition (which is the actually-correct outcome anyway:
  editing a `.tsx` file changes every instance for free once the code changes).

---

## 4. Sending back — the payload for an agent to change source

Given §"read first" above, most of the hard part already exists. The payload for an edit should be
`data.component`/`data.source` (**already computed today**, `preview-inspector.js:78-87`) plus new
fields:

```
{
  selector,            // existing: DOM structural path, preview-inspector.js:62-73
  component, source,   // existing: React fiber walk → _debugSource {fileName, lineNumber}
  route,                // existing
  changes: [            // NEW — one entry per edited property
    { property: 'padding-left', before: '12px', after: '24px', token: null },
    { property: 'color', before: '#3b82f6', after: 'var(--brand-primary)', token: '--brand-primary' },
  ],
  scope: 'element' | 'component',   // NEW — from §3
  screenshot: '<base64 crop>',      // NEW — see below
}
```

- **`before`/`after` per property**, not a full computed-style dump: `getComputedStyle(el)` read
  once at pick time (before) and once at send time (after), diffed to only the properties the
  control UI actually touched — matches exactly what Chrome's own Changes panel shows (§1), and
  keeps the payload small and legible for an agent turn instead of a "send everything" style dump.
- **Token names**: when a color/dimension's `after` value matches a `--*` custom property's
  resolved value, include the token name instead of (or alongside) the raw value — this is
  Figma Dev Mode's exact pattern (§1/§2) and turns "set this to #3b82f6" into "use
  `var(--brand-primary)`" for the agent, which is the more correct edit to generate.
- **Screenshot crop**: the Design lane's prior report already establishes this as the intended next
  step for annotation payloads generally (no screenshot is attached to any note today —
  `annotations.ts` is text-only context). A before/after crop of just the edited element's box
  (easy: `WebContentsView.capturePage({x,y,width,height})` on the stage, called once before the
  first edit and once at send time) gives the agent a visual anchor alongside the structured diff,
  and is genuinely useful for edits a selector/property list can't fully capture (e.g. "this now
  looks off-center").
- **DOM→source for non-React apps**: the fiber-walk trick is React-specific. For Vue, the
  equivalent would be `vite-plugin-vue-inspector`'s source-map-based approach (VERIFIED,
  [npm](https://www.npmjs.com/package/vite-plugin-vue-inspector)) — a Vite plugin the *project*
  needs installed, unlike React where Operator gets it for free. For a plain HTML/CSS project with
  no framework, there is no DOM→source mapping available at all short of a CSS source map tracing a
  rule back to a `.scss` line (VERIFIED as a general browser feature, INFERRED as unresearched
  specifically for this use case) — the honest fallback there is exactly what Annotate mode does
  today for a cross-origin iframe: selector + screenshot + human-legible description, no file:line.
  Worth stating explicitly in the Design brief so "select and edit" doesn't silently promise a
  source jump it can't deliver for every stack.

---

## 5. The same feature via CDP, for Electron apps (once Code adds CDP)

Structurally the same feature, different verbs — CDP's CSS domain gives a native, more robust
version of the exact pattern in §3, without needing to inject a script into the page's own JS
realm at all:

- **Read the current rule/value**: `CSS.getMatchedStylesForNode` (VERIFIED,
  [CDP CSS domain](https://chromedevtools.github.io/devtools-protocol/tot/CSS/)) returns
  `inlineStyle`, `matchedCSSRules` (with selector text and specificity context), and inherited
  rules — this is what decides *which* rule a control's edit should target.
  `DOM.getBoxModel` gives all four box-model quads (content/padding/border/margin) in one call —
  a native version of what `preview-overlay.js`'s `boxOf()`/`containerOf()` compute by hand today.
- **Apply the edit**: `CSS.setStyleTexts` (VERIFIED) edits an existing rule's text by
  `styleSheetId`+`range` — this includes the node's **inline style**, which CDP represents as its
  own pseudo-stylesheet, so the same call handles both "edit the existing inline style" and "edit
  a matched external rule." For a synthetic/generated selector (the `data-op-edit`-style approach
  from §3), `CSS.createStyleSheet(frameId)` creates a dedicated "**via-inspector**" stylesheet
  (VERIFIED, the exact name CDP's own docs use — strong signal this is literally what DevTools'
  own "New Style Rule" button does), then `CSS.addRule` inserts into it. This maps 1:1 onto §3's
  `<style id="__op_edits">` pattern — CDP just gives a native call instead of DOM-scripting it.
- **No native persistence** — VERIFIED: `setStyleTexts`/`addRule` are pure in-memory runtime edits,
  gone on reload; Chrome's own Overrides/Workspaces features are separate DevTools-frontend
  mechanisms layered on `Network`/`Page`, not something a CDP client gets automatically. Operator
  needs the same "send to an agent before reload eats it" flow either way — this is not a gap
  specific to the CDP path, it's the same constraint as the injected-script path in §3.
- **Token matching via CDP**: `CSS.resolveValues` (VERIFIED, exists, purpose-built for resolving
  `var(--x)`/`calc()`/relative units in a node's context) is the right call for "does this value
  match a token" — better than trying to enumerate all custom properties from
  `CSS.getComputedStyleForNode`, which doesn't clearly document custom-property inclusion
  (INFERRED gap, unconfirmed).
- **No existing library wraps this for a visual editor** — VERIFIED absence: searches for a
  CDP-based style-editor library turned up nothing; every tool (DevTools itself included) builds
  directly against the raw `CSS`/`DOM` domain calls. Code's CDP work should expect to build this
  layer itself, not find a shortcut.
- **Net effect**: once Code's CDP work lands, the Electron path is *more* robust than the
  injected-script web path (no `executeJavaScript` dependency, works even without a preload, reads
  real rule/specificity data instead of `getComputedStyle` approximation) — worth designing the
  edit-application interface (in §3) so the web-inject implementation and a future CDP
  implementation share the same shape (`{property, before, after}` in, a rule applied out), so
  swapping the Electron path onto CDP later doesn't touch the control UI at all.

---

## Recommended scope

**v1 — small, high value, ships against what exists today (web preview only):**
- Controls: **box (margin/padding, drag handles reusing the redline geometry + steppers), size,
  color (with token-snap), radius, opacity.** Skip flex/grid and shadow for v1 — flex/grid needs
  new UI patterns with no existing analog in the codebase (highest design cost), shadow's
  multi-layer authoring is fiddly for comparatively low value.
- Apply live via the injected-stylesheet-rule pattern (§3), reusing the anchor-recovery logic
  redlines already has for HMR survival.
- Scope: **this element only.** "All matching component" deferred to v2 (§3's reasoning).
- Payload: extend the existing compose-card beacon (`preview-inspector.js:109-185`, already
  carries `selector`/`component`/`source`/`route`) with the `changes[]` diff and a screenshot crop.
  This is additive to code that already exists and already works — no new discovery mechanism
  needed for React apps specifically.
- Explicitly scope to React apps with fiber-based source detection; Vue/no-framework degrade to
  selector+screenshot with no file:line, same honest floor Annotate mode already has.

**v2:**
- Flex/grid controls (direction/align/justify/gap; grid tracks as a stretch goal).
- Shadow (multi-layer) and "all instances of this component" scope.
- Electron support via CDP (`CSS.setStyleTexts`/`addRule`/`resolveValues`), once Code's CDP work
  lands — designed against the same `{property, before, after}` interface as v1's web path so the
  control UI doesn't need to know which backend it's talking to.
- Vue source-location support via `vite-plugin-vue-inspector`, if Vue projects turn out to be
  common enough on this machine to justify the extra project-side plugin dependency.

---

## Sources

- [DialKit](https://github.com/joshpuckett/dialkit) · [DialKit site](https://joshpuckett.me/dialkit)
- [VisBug](https://github.com/GoogleChromeLabs/ProjectVisBug) · [VisBug 101](https://medium.com/google-design/visbug-101-d2636120f8d7)
- [Chrome DevTools Workspaces](https://developer.chrome.com/docs/devtools/workspaces)
- [Chrome DevTools Overrides](https://developer.chrome.com/docs/devtools/overrides)
- [Onlook](https://github.com/onlook-dev/onlook)
- [Figma Dev Mode guide](https://help.figma.com/hc/en-us/articles/15023124644247-Guide-to-Dev-Mode)
- [Figma variables in Dev Mode](https://help.figma.com/hc/en-us/articles/27882809912471-Variables-in-Dev-Mode)
- [tweakcn](https://github.com/jnsahaj/tweakcn) · [tweakcn.com](https://tweakcn.com/)
- [Builder.io Visual Editor](https://www.builder.io/visual-editor)
- [Babel jsx-source plugin docs](https://babeljs.io/docs/babel-plugin-transform-react-jsx-source)
- [vite-plugin-react-click-to-component](https://github.com/ArnaudBarre/vite-plugin-react-click-to-component)
- [react-dev-inspector Vite integration](https://react-dev-inspector.zthxxx.me/docs/integration/vite)
- [@metagptx/vite-plugin-source-locator](https://www.npmjs.com/package/@metagptx/vite-plugin-source-locator)
- [vite-plugin-vue-inspector](https://www.npmjs.com/package/vite-plugin-vue-inspector)
- [Vue DevTools open-in-editor](https://devtools.vuejs.org/getting-started/open-in-editor)
- [vitejs/launch-editor](https://github.com/vitejs/launch-editor)
- [CDP CSS domain](https://chromedevtools.github.io/devtools-protocol/tot/CSS/)
- [CDP DOM domain](https://chromedevtools.github.io/devtools-protocol/tot/DOM/)
