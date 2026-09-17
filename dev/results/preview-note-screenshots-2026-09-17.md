# Preview notes carry a screenshot crop — 2026-09-17

Lane: Design. Branch `operator/preview-note-screenshots` off `main` @ `2900494`, in worktree
`~/.operator/worktrees/operator-666300`. Commit: `847616d`.
Background: `native-preview-research-2026-09-17.md` §3 and "Polish items".

## Changes to `electron/src/main/preview-inspect.ts` (for Code)

Minimal, as asked:
- `installPreviewInspect`: two functions added to the `previewApi` object:
  - `size()`: the view's bounds, or null;
  - `capture(rect)`: calls `__operatorInspector.hide()` in the page, then
    `view.webContents.capturePage(rect)`.
- `previewApi`: its type and no-op default gain `size` and `capture`.
- The electron import adds `type NativeImage`.

Nothing else in that file changed: open/move/close, scaling, injection and the pick/anchor wiring
are untouched.

`src/shared/preview-inspector.js` changes, shared with the Tauri build and harmless there:
- `__operatorInspector` exposes `hide`;
- the pick payload gains `box` and `scale`, plus `anchorBox` on a measurement note.

## Design

### Where the pixels come from

The renderer cannot read either surface: Annotate shows a cross-origin iframe, and Inspect is a
native `WebContentsView`. Main captures both.

| Mode | Source | Coordinates |
|---|---|---|
| Annotate | main window `webContents.capturePage(rect)` (includes the out-of-process iframe) | window CSS px (= DIP); the crop is clamped to the preview stage's rect |
| Inspect | inspect view `webContents.capturePage(rect)` via `previewApi.capture` | the pick's page CSS px × the emulated scale = view DIP; clamped to the view bounds |

The captured image is in device pixels (2× on Retina). The outline is mapped with
`pixelScale = image width / crop width`.

### When

- **Annotate:** on mouse-up after a pin or box is placed, before the note card opens. For that capture
  the panel sets `capturing`, which stops drawing the pins, the overlay's accent tint and the card.
  It waits two animation frames, then asks main to capture. The card opens afterwards with the
  thumbnail. A capture that fails or is unavailable still opens the card; the note has no picture.
- **Inspect:** when the pick arrives, which is after the in-page compose card was removed. Main hides
  the hover outline, waits 50ms for a paint, and captures. The note is then formatted with its
  screenshot and sent.
- **Known limit respected:** nothing new is drawn over the native inspect view. The thumbnail and the
  full-size view are renderer DOM, reachable only from the Annotate card, and Annotate always keeps
  the iframe (the native view is not up).

### The crop

Pure functions in `electron/src/main/preview-shots.ts`:
- The crop is `unionRect(targets)` plus a margin: 24 by default; a point pin outlines an 18px mark
  with a 72px margin. It is clamped to the stage or view (`cropRect` / `cropRectIn`) and snapped
  outward to whole units, and is null when the target is off the surface.
- A measurement note's targets are the element AND the redline anchor, so both are in one crop.
- **Outline:** `drawOutline` writes a rectangle into the BGRA bitmap, one pixel outside the target,
  clipped to the image. Thickness is `max(2, 1.5 × pixelScale)`. Colour: `--accent` for Annotate and
  `--measure` for Inspect, resolved in the renderer and passed as RGB.
- **Size:** the long side is capped at 1600px (`fitWidth`, `resize quality: best`).
- **Encoding:** PNG when it is 500 KB or less, else JPEG at 85, then 70, then 55 (`chooseEncoding`).

### Storage and cleanup

- **Path:** `~/.operator/preview-shots/<project>/<note-id>.png` (or `.jpg` when JPEG was needed). The
  project is the lane's project id, or `no-project`. Every segment is sanitised with `safeSegment`,
  so nothing can climb out.
- **Annotate notes:**
  - Delete in the card removes the file.
  - Cancel or Esc on a new note that was never kept removes its file.
  - A re-capture replaces the file whatever its old format.
- **Inspect notes** are sent at once and never stored, so there is no note to delete with. Their ids
  are `pick-<uuid>`, and `prunePickShots` removes `pick-*` files older than 14 days after each
  Inspect capture. Annotate shots are never pruned by age.
- **Reading back:** `previewShotImage(project, id)` returns a data URL, because a `file://` src is
  refused by the app's navigation guard (the moodboard's reason too).

### What the lane receives

- **Text:** `composeMessage` adds `   Screenshot: <path>` under each annotation that has one. An Inspect
  note gets `\n\nScreenshot: <path>` after `formatPick`'s text (`withScreenshot`).
- **Console:** the image is also attached. `DashboardView` calls the new `SubmitQueue.attachImages(id,
  paths)`, which writes a bracketed paste of the path(s) with no Return, in the same per-terminal
  chain, then `submit` pastes the text and submits.
  - This is the attach route `TerminalPane` already uses for dropped and pasted images: Claude Code
    makes a pasted image path an `[Image #N]`.
  - Delivery confirmation still works, because a turn that ends with our text counts as delivered
    (`matchSubmission`'s `endsWith` rule).
- **Tasks:** the text only, with the path line, since a task is dispatched later as text. The agent
  can read the file.

### UI

- **Annotate card:** an 84px thumbnail (object-fit contain, `--overlay-subtle` ground, `--border`
  edge) above the text field. Clicking opens the image full size in a fixed overlay; click or Esc
  closes it. Opening an existing pin loads its image.
- **The "punch list":** in this panel it is the set of pins. There is no separate list component, so
  there is no list to put a thumbnail in. Each pin's tooltip says "has a screenshot", and opening the
  pin shows it. If a list view is wanted, it is a separate piece.
- **Inspect:** there is no Operator-side card to put a thumbnail in; the note is composed inside the
  page and sent immediately.

## Tests

- `electron/src/main/preview-shots.test.ts` (18):
  - crop margin, clamping at an edge, outward snapping, off-surface null, a clip not at the origin,
    union of two elements, page → view scale, device-pixel outline mapping, long-side cap, pin box;
  - outline pixels (BGRA, one pixel outside, clipped, no throw off the edges);
  - PNG → JPEG fallback order;
  - storage path, re-capture replacing the other format, delete (twice), traversal-safe ids, the
    `no-project` folder;
  - pruning takes only old `pick-*` files.
- `src/renderer/lib/preview-shot.test.ts` (10): Annotate targets for a box and a pin, Inspect targets
  with the anchor, the request (and null without a box), the Screenshot line, `composeMessage` and
  `shotPaths`, the project folder fallback, `parseRgb`.
- `src/renderer/lib/submit-queue.test.ts` (+2): `attachImages` writes the paths as a paste with no
  Return, after an earlier submission and before the note's text; an empty list writes nothing.

## Verification

- Renderer suite: 96 files, 1420 tests passed, 0 failed.
- Electron suite: 37 files, 666 tests passed, 0 failed.
- `tsc --noEmit` passes for the renderer project and `electron` `npm run typecheck`.
- Not verified in the GUI. `capturePage` on a real window and view can't be exercised in the test
  environments. Still to check in the app:
  - an Annotate box and pin at Fit and at a scaled preset (crop lines up, no pins or tint in the
    image, outline on the region);
  - an Inspect pick, and one with a redline anchor (both elements in the crop);
  - Retina sharpness;
  - a large page region falling back to JPEG;
  - the Console receiving `[Image #1]` with the note text as one prompt;
  - Delete or Cancel removing the file.
