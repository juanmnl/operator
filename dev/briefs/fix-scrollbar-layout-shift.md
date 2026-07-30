# Brief — kill the scrollbar layout shift, app-wide

User: *"there's a layout shift on pages with and without scrollbar."* Correct, and it is systemic.

## Root cause (verified — do not re-derive)

`src/renderer/styles.css:112` styles the scrollbar with an explicit width:

```css
::-webkit-scrollbar { width: 6px; }
```

In WebKit, styling a scrollbar with a width converts it from an **overlay** scrollbar (zero layout
cost, the macOS default) into a **classic** one that consumes 6px of the scroller's content box.
Every scrolling container therefore has `clientWidth = offsetWidth − 6` once its content overflows.

That alone is harmless. The shift comes from **centred boxes in different containing blocks**: a
header outside the scroller centres in the full width, the content inside it centres in the shrunk
width, so the two disagree by 3px — and the whole page appears to jump as soon as it gets long
enough to scroll.

**`scrollbar-gutter: stable` does NOT fix this.** The gutter is reserved inside the scroller only,
so an outside header still centres 3px wider. This is already documented at
`src/renderer/components/settings/PageShell.tsx:141-151` — read that comment before doing anything.

## The canonical fix — already proven in this repo

`PageShell` (non-split branch, `:139-163`) is the reference implementation:

1. The **scroller is full width** — never put `maxWidth` + `margin: 0 auto` on the scrolling
   element itself (that also parks the scrollbar mid-window instead of flush to the edge).
2. The **measure box goes on inner children**, not the scroller.
3. The **header lives INSIDE the scroller**, pinned with `position: sticky; top: 0` and an opaque
   background — so header and content share one containing block and one left edge at every
   scrollbar width.

Apply that structure. Do not invent a second technique.

## Known offender — `ProjectGallery.tsx`

Structure today:

```
<div flex column>
  <DragRegion 40px />                                    ← traffic lights, full width, fine
  <DragRegion header  maxWidth: GRID_MAX  margin: 0 auto  flexShrink: 0 />   ← OUTSIDE the scroller
  <div overflow: auto>                                   ← scroller
    <div maxWidth: GRID_MAX margin: 0 auto> grid </div>  ← INSIDE
  </div>
</div>
```

Header at `:141`, grid measure at `:144` and `:210`. The comment at `:139-140` claims they "share
one left edge at every width" — that claim holds only while the page doesn't scroll, which with 19
projects is never.

Move the header inside the scroller and make it sticky, per the PageShell pattern. Notes:
- The header is a `DragRegion` (window dragging). It must keep working sticky-positioned inside a
  scroller; the traffic-light strip above stays outside and full-width.
- The sticky header needs an opaque background (`var(--bg-terminal)`) or content scrolls through it.
- The tidy bar and the ACTIVE / PREVIOUS section headers must end up in the same containing block
  as the grid, or they inherit the same bug.

## Sweep the rest

Find every view with a centred measure box whose header/chrome sits in a different containing
block from its scrolling content. Confirmed candidates to check (there may be more — search for
`margin: '0 auto'` alongside `overflow`):

- `components/agents/AgentLibraryView.tsx:153` — `maxWidth: MEASURE_GRID`, `flexShrink: 0` header
- `components/session/ProjectView.tsx:102, :127` — `maxWidth` 760 / 960
- `components/session/CanvasConversation.tsx:1091` and `ChatComposer.tsx:213` — `MEASURE_FORM`.
  **Careful here**: the composer is a sibling of the transcript scroller by design. If the
  transcript scrolls and the composer doesn't, they will disagree by 3px — check whether they
  currently line up, and if not, reserve the same gutter on the composer rather than restructuring
  the chat layout.
- `ProjectGallery.tsx:1095` — the empty-state block.

For each: either adopt the PageShell structure, or — where the chrome genuinely cannot move inside
the scroller — reserve an equal 6px on the non-scrolling sibling so both measures match. State
which you chose per file and why.

**Guardrail:** `ProjectView` and the Gallery use TOOLBAR headers, deliberately not standardised to
`PageShell`'s page-header type scale (`project_settings_page_template`). You are borrowing
PageShell's *containing-block technique* only — do not convert these views to PageShell or restyle
their headers.

## Alternative considered — reject it explicitly

Reverting to overlay scrollbars (dropping the `width` from `::-webkit-scrollbar`) would make the
shift vanish everywhere at a stroke, but it discards the app's deliberate thin scrollbar styling
and makes thumbs invisible until hover on trackpad-less setups. Mention it in your result, but
implement the containing-block fix.

## Verify

- `npm test` + `npm run build` green.
- **Add a regression harness** — extend an existing `dev/drive-*.mjs`: render a view with few items
  (no scrollbar) and with many (scrollbar), and assert the header's and content's
  `getBoundingClientRect().left` are equal in both states. That assertion is the whole bug; without
  it this will regress.
- `node dev/drive-gallery-cards.mjs` and `dev/drive-navigation.mjs` still pass.
- Check at a narrow window too — the shift is most visible when `maxWidth` is not yet the binding
  constraint.

## Write your result to

`dev/briefs/fix-scrollbar-layout-shift-RESULT.md` — files changed, the choice made per file, and
any view where the two measures still can't be reconciled.
