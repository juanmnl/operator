# Preview: a device-width preset must sit CENTRED in the panel, not pinned left

File: `src/renderer/components/session/AppPreviewPanel.tsx`

## The ask

User, 2026-08-04: *"the preview resize buttons, should resize the page, but centered, not left
aligned."* Pick a device width (the presets at :362) and the page renders hard against the left edge
with all the slack in one gutter on the right. It should sit in the middle, gutter split evenly.

## Where it comes from

At :422-438 a chosen preset renders:

```tsx
const scale = Math.min(1, box.w / preset)
<iframe style={{ width: preset, height: box.h / scale,
                 transform: `scale(${scale})`, transformOrigin: 'top left' }} />
```

`transformOrigin: 'top left'` inside a full-width wrapper (:419, `frameWrapRef`) is the left pin.
Note which case actually shows it: when `preset <= box.w`, `scale` clamps to 1 and the iframe is
simply `preset` px wide in a wider box — that is the visible gutter. When `preset > box.w`,
`scale = box.w / preset`, so the scaled width equals `box.w` exactly and there is no slack to
centre. **Fix the narrow case and keep the wide case pixel-identical.**

## ⚠ The part that will bite: three things derive "where the frame is", and they all read the WRAPPER

1. **The iframe** — :432-435.
2. **Annotation pins and the capture overlay** — :442-459 position with `left: ${a.xPct}%` and the
   overlay is `position:absolute; inset:0` (:468), i.e. percentages of the **wrapper**.
3. **The native inspect webview** — :215-218 and :225-228 pass `frameWrapRef.getBoundingClientRect()`
   to `previewInspectOpen` / `previewInspectMove`.

So "x% across the wrapper" is only "x% across the page" while the frame fills the wrapper. **This is
already wrong today** at any preset narrower than the panel: pins are stored against a box that
includes the empty right gutter, and the inspector webview is laid over that same too-wide box.
Centring does not create the bug, but it makes it symmetrical and much easier to see — so fix it in
the same pass rather than leaving a known drift behind.

**Do it with one stage element.** Introduce a single element that IS the frame's visible box —
width `preset * scale` (or 100% for `fit`), height to match — centred in the wrapper. Then:
- the iframe scales inside the stage (`transformOrigin: 'top left'` is fine *inside* the stage, or
  use `top center` — whichever keeps the wide case identical);
- the annotation pins and the overlay become children of the **stage**, so their percentages are
  page-relative and existing annotations keep meaning what they meant;
- the inspect rect comes from the **stage's** `getBoundingClientRect()`, not the wrapper's, so the
  embedded inspector lands exactly over the page.

Keep the `:231` re-align effect working — it depends on `box`, and the stage's rect must be
recomputed on the same trigger.

## Constraints

- `fit` mode (:423-424) must be untouched: full width, full height, no letterboxing.
- Vertical behaviour stays as it is — top-aligned. Only the horizontal axis is being centred.
- The gutters are the panel's own background (`#fff` today at :419). If you give the gutter a
  distinct tone so the page edge reads, use a CSS var, never a hardcoded colour, and do not use a
  colour-changing border on a border-radius element (WKWebView freeze rule).
- House style: no browser focus rings, no solid accent fills for state, never recede with group
  `opacity`.

## Verify

- A narrow preset (e.g. 390) in a wide panel: equal gutters left and right, page top-aligned.
- A preset wider than the panel: renders exactly as before (fills the width, no new letterbox).
- `fit`: unchanged.
- Annotating at a narrow preset: a pin dropped on a page feature stays on that feature after
  switching preset and after resizing the panel.
- Inspect at a narrow preset: the hover outline tracks the real element — proving the native webview
  is over the page, not the gutter.
- `npm test` green (603 as of the rail-fold merge) and `npm run build` clean.

## Output

Write `dev/briefs/2026-08-04-preview-centre-RESULT.md` — what changed, whether the annotation/inspect
coordinate drift was fixed with it, and how each bullet above was verified. Also copy that RESULT to
`/Users/juanmnl/.operator/worktrees/operator-3b4cb8/dev/briefs/` so Operator can read it.
