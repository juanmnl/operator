# Measurement in Inspect notes — RESULT

Coordinator, 2026-09-14. Branch `operator/preview-inspect-measurement`, on top of `main` = `be7f657`.
Design spec §11 step 5 (`dev/results/preview-panel-and-design-tools-design.md`). Built by the
coordinator because Operator's delivery brake refused the dispatch to Code. **Not verified in a
real window.**

## What it does

With redlines on, ⌥-click an element to anchor it, then click another element in Inspect. The
compose card shows a second line under the element chip with where the clicked element sits
relative to the anchor, and the note sent to Console or Tasks carries it:

```
Make this gap 24

↳ PlanCard @ src/Pricing.tsx:42 — 16px below Header — “Pro”
```

Phrases, all in CSS px of the preset layout (the same numbers the redlines draw):

| Relation | Phrase |
|---|---|
| separated | `16px below Header` · `24px above Header` · `12px right of Header` · `8px left of Header` |
| diagonal | `16px below and 8px right of Header` |
| touching | `0px below Header` |
| inside the anchor | `inside Header (16px left, 24px top, 16px right)` (zero insets left out) |
| containing it | `contains Header (8px left, 10px bottom)` |
| overlapping | `overlaps Header (8px right, 20px down)` |
| identical box | `same box as Header` |

The anchor is named the way the inspector names elements: the React component when the fiber
reports one, else `tag#id.class`. No anchor, or clicking the anchor itself: the note is unchanged.

## Where

| What | File |
|---|---|
| Phrase (pure, self-contained for `String(fn)`) | `src/shared/redlines.ts` — `describeRelation` |
| Sent to the page with the other functions | `electron/src/main/overlay-fns.ts` |
| Anchor node, box and name | `src/shared/preview-overlay.js` — `__operatorOverlay.anchorInfo()` |
| Element naming exposed | `src/shared/preview-inspector.js` — `__operatorInspector.label` |
| Card line + payload `measurement` | `src/shared/preview-inspector.js` — `showCompose` (`[data-op-measurement]`; card clamp height 148 when present) |
| Note text (pure) | `src/renderer/lib/preview-pick.ts` — `formatPick`, used by `AppPreviewPanel.tsx` |

`formatPick` reproduces the previous inline formatting exactly when there is no measurement.
The Tauri shell loads only the inspector; without `__operatorOverlay` it adds nothing.

## Checks

- Renderer: 83 files, 1297 passed, 0 failed (was 1282; +15). Root `tsc --noEmit`: exit 0.
  - `redlines.test.ts`: `describeRelation` for every row above, rule-5 numbers, and a rebuild from
    its source string.
  - `preview-pick.test.ts`: note text with and without measurement, empty message.
  - `preview-overlay.test.ts` (jsdom, with mocked boxes): `anchorInfo` null/off/named/tag fallback;
    an anchored Inspect click puts `16px below div#head` on the card and in the beacon payload; no
    measurement without an anchor or when the picked element is the anchor.
- Electron: 32 files, 558 passed, 0 failed; `overlay-fns.test.ts` checks the page copy of
  `describeRelation`. `npm run typecheck`: exit 0. `build-main.mjs`: ok, `__name` occurrences in
  `out/main/index.cjs`: 0.

## Unverified — needs a real window

1. The card's second line fits and truncates correctly at the card's 288px width, at scaled presets.
2. The React component name for the anchor comes through on a real dev build of an app.
3. The note arrives in Console and Tasks with the measurement line.
