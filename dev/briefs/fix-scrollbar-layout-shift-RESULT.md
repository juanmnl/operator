# RESULT — scrollbar layout shift

Fixed, in two files. But the diagnosis needed correcting first: **the named offender wasn't
one, and the prescribed technique only addresses half the symptom.** Everything below is
measured, not reasoned — the numbers are from the harness described at the end.

---

## What I found before changing anything

### 1. `ProjectGallery` does not shift

Its scroller carries `className="scroll-hidden"`, and `styles.css:228` gives that class
`::-webkit-scrollbar { width: 0; display: none }`. Measured with 18 projects at 1200px wide:

```
no scroll : header 220 / card 220      scrollbar cost 0
scrolling : header 220 / card 220      scrollbar cost 0
```

The comment at `:139-140` that the brief calls out as a false claim is in fact **true** — not
because the header and grid share a containing block, but because that scroller never pays for
a scrollbar at all. **I did not restructure it.** Moving a `DragRegion` inside a scroller and
making it sticky is real risk (window dragging, z-order, an opaque band over the grid) for zero
measured benefit.

### 2. `scrollbar-gutter: stable` is a no-op in this WebKit

The brief rejects it for the wrong reason. It isn't that the gutter is reserved in the wrong
place — it's that **WebKit parses the property and ignores it**:

```
CSS.supports('scrollbar-gutter','stable') → true
probe div, scrollbar-gutter: stable       → reserved 0px
probe div, scrollbar-gutter: auto         → reserved 0px
```

I applied it first, measured no change, then probed it in isolation. Noted in both files so
nobody re-tries it.

### 3. Same-containing-block is only half the fix — the reference implementation still shifted

`PageShell` is the brief's canonical fix, and it works *for what it was for*: the title and the
sections stay aligned **with each other**. But both still moved relative to the window:

```
prefs, no scroll : title 400 / section 400
prefs, scrolling : title 397 / section 397     ← the whole page slides 3px
```

That is the symptom the user reported ("layout shift on pages with and without scrollbar"), and
no containing-block arrangement can fix it: a centred box re-centres whenever its content box
changes width, header or no header.

### 4. Dropping the scrollbar `width` works, and the brief is right to reject it

Tested all four rule combinations in isolation:

| `::-webkit-scrollbar` rules | layout cost |
|---|---|
| none (engine default) | 0 |
| `width: 6px` only | **6** |
| thumb styling only, no width | 0 |
| thumb + track, no width | 0 |
| width + track + thumb (today) | **6** |

So the thin styling survives without the width — the layout cost comes from the `width`
declaration alone. But the screenshot (`/tmp/operator-shots/scrollbar-compare.png`) shows why
it's still the wrong trade: the overlay thumb is **completely invisible at rest**, appearing
only while scrolling. The brief's stated objection is exactly right.

---

## The fix

**`overflow-y: scroll` instead of `auto`** on the scrollers that contain a centred measure box.
It is the pre-`scrollbar-gutter` way of reserving the gutter, and unlike `scrollbar-gutter` it
actually works here:

```
overflow auto,   short content → reserved 0   ← the shift
overflow auto,   tall content  → reserved 6
overflow scroll, short content → reserved 6   ← constant
overflow scroll, tall content  → reserved 6
```

It costs nothing visually: the track is `background: transparent` and a non-overflowing
scroller draws no thumb, so a short page looks exactly as it did — proven side-by-side in
`/tmp/operator-shots/scrollbar-reserve.png`.

### Files changed (2)

| File | Change | Why this and not the other technique |
|---|---|---|
| `components/settings/PageShell.tsx:152` | `overflow: 'auto'` → `overflowY: 'scroll', overflowX: 'auto'` | Keeps its existing sticky-header structure (that half was already right); this fixes the residual 400 → 397 page slide. Fixes prefs, folder-prefs and the Agents hub in one place. |
| `components/session/ProjectView.tsx:100` | roster scroller `'auto'` → `'scroll'` | Its toolbar header is full-width and **not** centred, so it never moved — there is nothing to align it *to*. The bug here is purely the centred 760px roster column re-centring: 374 → 371. Moving the header inside would be restructuring for no reason. |

### Files checked and deliberately left alone

| File | Measured | Why no change |
|---|---|---|
| `dashboard/ProjectGallery.tsx` | 220/220 both states, cost 0 | `.scroll-hidden` — immune. Same for its empty-state and activity scrollers. |
| `session/CanvasConversation.tsx` + `ChatComposer.tsx` | transcript cost **0**, status row 376 in both states | The transcript scroller is `.scroll-hidden`, so the composer sibling can never fall out of line with it. The transcript column is also computed from the canvas's own width (`contentL = (cssW - contentW) / 2`), which overflow never changes. The brief's "careful here" case turns out to be already safe — **no gutter reserved on the composer**, since reserving one would *create* the 3px disagreement it was meant to prevent. |
| `agents/AgentLibraryView.tsx:153` | title 304 in both states | Its centred header sits outside the two split-pane columns, whose scrolling can't change the header's parent width. The editor form (`:304`) is `maxWidth` **without** `margin: 0 auto` — left-aligned, so it cannot re-centre. |
| `ActivityDashboard`, `SessionActivityView`, `DiffPanel`, `MoodboardPanel`, the sidebar lists, `ProjectRail`, `CommandPalette`, `ProjectSwitcher` | — | All left-aligned. A 6px narrowing reflows their content but moves nothing, which is the whole bug. |

---

## The regression harness

**`dev/drive-layout-shift.mjs` (new).** Each view is measured twice at one width — once at a
1800px viewport where nothing scrolls, once at 360px where everything does — and every probed
`getBoundingClientRect().left` must be identical across the pair.

It also counts how many scrollers were **actually paying** the 6px in the short state, because
a "nothing moved" pass is worthless if nothing scrolled. That counter is what tells you the
gallery row is a proof of *immunity* (0 paying) rather than of repair.

```
✓ gallery                        header 100 / card 100      (0 paying — .scroll-hidden)
✓ projectHome · roster           roleCard 371  ← was 374 → 371
✓ prefs · PageShell              title 397 / section 397  ← was 400 → 397
✓ agents hub                     title 304
✓ chat · transcript vs composer  statusRow 376 / canvas 280
NO LAYOUT SHIFT
```

Width is settable (`W=900 node dev/drive-layout-shift.mjs`) because the shift is most visible
where `maxWidth` isn't the binding constraint. **Swept at 900, 1200 and 1400 — clean at all
three.**

## Verification

- `npm test` — 271 passed / 34 files.
- `npm run build` — clean.
- `node dev/drive-gallery-cards.mjs`, `dev/drive-navigation.mjs` — pass.
- `node dev/drive-settings-template.mjs` — all four PageShell pages still report
  `header / content → Δ0px`, so the sticky-header alignment this change sits on top of is intact.

## Left unreconciled — one, and it's cosmetic

`ProjectView`'s two tabs reserve differently: the roster scroller now always reserves 6px, the
moodboard's container doesn't scroll (its panel does its own). Their measure boxes are different
widths anyway (760 vs 960), so switching tabs was never a stable-position comparison — but if
you want them identical, the moodboard branch would need the same `overflow-y: scroll` and a
`maxWidth` change, which is a layout decision rather than a bug fix. I left it.

## Worth knowing for later

The `overflow-y: scroll` reservation is a **per-scroller opt-in**, so any new view with a
centred measure box will reintroduce the shift unless it opts in too. The harness catches it,
but only for views it visits — add a row when you add a page. The alternative would be a house
rule (`overflow: auto` is banned on anything containing `margin: 0 auto`), which is worth
considering if this recurs.
