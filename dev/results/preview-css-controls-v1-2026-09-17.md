# Preview Inspect: CSS controls v1 — 2026-09-17

Lane: Design. Branch `operator/preview-css-controls`, commit `ddab105`, on `main` @ `ccf5207`.
Spec source: `preview-css-controls-research-2026-09-17.md`, "Recommended scope" v1.

## Base

Built on Code's iframe-injection model, not the inspect `WebContentsView`. I branched from
`operator/redlines-layout-shift` at `ccf5207`, which was already rebased onto main at `847616d`,
because that model existed only there. That commit is now main, so the branch sits directly on main
and no rebase was needed.

## What it does

1. **Pick:** in Inspect, click an element. The in-page compose card opens as before, and the element
   also becomes the one the controls edit.
2. **Panel:** a controls panel opens UNDER the stage (inside `AppPreviewPanel`, after the stage;
   `max-height: 45%`, scrolls). Nothing is drawn over the page. It has:
   - **Header:** component or tag, source (or selector), change count, how many elements are edited
     on the page, then Undo · Reset · Reset all · → Console · → Tasks · Close.
   - **Margin** T R B L and **Padding** T R B L: CSS value fields. Type a value, or ↑/↓ steps by 1
     (⇧ by 10). Enter or blur commits, Esc reverts. Padding does not go below 0.
   - **Size:** W, H (any CSS length, `auto`, `%`).
   - **Shape:** Radius (field), Opacity (0–1 slider with value).
   - **Colour:** Background, Text, Border. Each has a native colour picker and a token select listing
     the page's `--*` colour tokens. When the current value matches a token, the select shows the
     token's name. Choosing a token writes `var(--name)`.
   - A changed field's label turns `--accent`.
   - A note appears when there is no source location.
3. **Drag handles** in the page on the selected element: one bar per side for padding (at the
   padding's inner edge, green) and one for margin (at the margin's outer edge, amber), plus a dashed
   outline.
   - Dragging a padding handle into the box, or a margin handle away from it, increases the value.
   - A whole drag is one undo step.
   - The click that ends a drag is swallowed, so the inspector does not pick the handle.
4. **Live apply:**
   - One owned `<style id="__op_edits">` with `[data-op-edit="<uid>"] { prop: value !important; }`.
     `!important` so app CSS and inline style do not win, and a rule rather than inline style so a
     re-render does not wipe it.
   - Allow-listed properties only. Values containing `;` `{` `}` `<` `\`, a newline or `!important`
     are dropped, and the uid is reduced to `[A-Za-z0-9_-]`.
5. **HMR:** a `MutationObserver` runs `retagEdits` on the next frame. An edit whose tagged element is
   gone is re-tagged on the element its stored selector now finds, unless that element already
   carries another edit.
6. **Undo, Reset, Reset all:**
   - Undo is per change, per element.
   - Reset clears the element's values.
   - Reset all clears every rule and tag.
   - Leaving Inspect deselects (the handles go away); the changes stay on the page until reset or
     reload. A reload is the page's own reset.
7. **Send:** → Console or → Tasks.
   - The message is built from:
     - the element label;
     - component and `source` file:line when the fiber walk has it;
     - the selector when there is no source;
     - the route;
     - `changes[]` with only touched properties whose computed value moved, each `{property, before,
       after, token}` (colours normalised, token matched by resolved value);
     - scope "this element only";
     - Before/After screenshot paths.
   - **Screenshots:** the BEFORE crop is taken the first time an element is selected with nothing
     changed, and the AFTER crop at send. Both use the note-screenshot path
     (`previewShotCapture`, window source, stage clip, `pageToStage`, `hideInspector`). The page hides
     the handles and the compose card for the frame. Ids are `pick-edit-<uid>-before|after`, so they
     age out with the other Inspect shots.
   - To the Console both images are attached (`attachImages`) with the text; to Tasks the paths are
     in the text.

## React 19

`preview-inspector.js`'s `source()` reads `fiber._debugSource`, which React 19 removed. On React 19
the existing walk still finds the component NAME (from `fiber.type`) but returns no source.

- **Fallback, in the page engine:** walk `_debugOwner`/`return` from the element's fiber, take the
  first `_debugStack.stack`, and use `sourceFromDebugStack`. That returns the first project file in
  the stack (`src/Pricing.tsx`), skipping `node_modules`, `.vite`, `@vite` and `@react-refresh`
  frames.
- **No line number:** the stack's line is of the transformed module, not the source file, so
  quoting it would point to the wrong line.
- **Degradation:** with neither source, the panel says there is no source location and the message
  names the selector.
- **Not verified against a live React 19 app.** The parser is tested against a React 19-shaped
  stack string.

## Files

**New**
- `src/shared/preview-edit.ts`: pure functions.
  - Injected into the page: `editRules`, `normalizeColor`, `matchToken`, `retagEdits`,
    `sourceFromDebugStack`. These are self-contained, stringified into the page.
  - Renderer-side: `diffChanges`, `composeEditMessage`, `stepValue`, `colorInputValue`,
    `editStateMessage`, `EDIT_PROPS`, and the message tags.
- `src/shared/preview-edit-page.js`: the page engine (select, commands, state, handles, re-tag,
  tokens, React 19 fallback). Named `-page` because `./preview-edit` would otherwise resolve to the
  `.js` before the `.ts`.
- `electron/src/main/edit-fns.ts`: `window.__operatorEditFns` from the pure functions.
- `src/renderer/lib/use-preview-edit.ts`: postMessage state and commands with the preview iframe.
  Messages are accepted only from its `contentWindow`, and commands are accepted in the page only
  from `window.parent`.
- `src/renderer/components/session/PreviewEditPanel.tsx`: the panel.

**Touched, minimally**
- `src/shared/preview-inspector.js`: one call, `window.__operatorEdit.select(el, data)`, in
  `showCompose`.
- `electron/src/main/preview-inspect.ts`: `inject` appends `EDIT_FNS_JS + EDIT_JS`, plus the
  `readShared` of the page script and one import.
- `electron/scripts/build-main.mjs`: copies `preview-edit-page.js` to `out/`.
- `src/renderer/components/session/AppPreviewPanel.tsx`: the `usePreviewEdit` hook (reset on
  reload or URL change), deselect when leaving Inspect, the `captureEdit` helper, and the panel
  mounted under the stage while Inspect has an active element.

## Tests

- **`src/shared/preview-edit.test.ts` (23):**
  - **Rules:** order, allow-list, escaping (value injection, uid breakout, `!important`), the
    stringified copy.
  - **Tokens:** colour normalisation (hex, short hex, rgb, rgba, slash alpha); first-declared wins;
    transparent never matches; stringified copies.
  - **Diff:** only touched and moved properties; knock-on changes ignored; the same colour spelled
    differently is no change.
  - **HMR re-tag:** replaced node re-tagged; no stealing; bad selector; stringified copy.
  - **React 19 fallback parser.**
  - **Message:** composition, with source and with the selector fallback.
  - **Helpers:** `stepValue`, `colorInputValue`, state parsing.
  - **The page engine in jsdom:** select/set/undo/reset; commands not from the parent and
    non-allow-listed properties ignored; reset all; an HMR replacement re-tagged with its rule
    applying.
- **`electron/src/main/edit-fns.test.ts` (1):** the injected source defines working functions in an
  empty page.

## Verification

- Full root suite (`vitest run`): 98 files, 1450 tests passed, 0 failed.
- Renderer suite (`vitest run src/renderer`): 91 files, 1334 passed, 0 failed.
- Electron suite: 38 files, 666 passed, 0 failed.
- Root `tsc --noEmit -p .` and `electron` `npm run typecheck` pass. `electron/scripts/build-main.mjs`
  builds and copies the page script.
- **Not verified in the running app, and no Electron probe was run** (it opens a window). Checks
  worth doing by hand:
  - Inspect → pick an element in a React dev app; the panel appears under the stage.
  - Change padding by field and by dragging a handle; Undo; Reset.
  - Pick a colour token and see its name.
  - Save a component file so HMR remounts; the edit stays.
  - → Console: text with before/after `[Image #N]`.
  - Try a scaled preset; the handles are drawn in page px inside the scaled iframe.

## Known limits and next

- **Handles:** padding and margin only, not size or radius, so 8 bars. They are drawn at the side
  midpoints and can overlap on very small elements.
- **Tokens:** colours only, read from `:root`'s computed custom properties and resolved through a
  probe element, capped at 400. Spacing tokens are not matched.
- **Nothing persists** across a page reload, by design. Unsent changes are lost on reload.
- **The compose card** stays up alongside the panel; Close on the card does not deselect.
- **Tauri shell:** it has no injection into the iframe, so no panel there.
