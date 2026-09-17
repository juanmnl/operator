# Preview toolbar icons — 2026-09-17

Lane: Design. Branch `operator/preview-toolbar-icons` off `main` @ `0ab91b0`, in worktree
`~/.operator/worktrees/operator-666300`. Commit: `2900494`.

## Cause

`AppPreviewPanel.tsx` drew its toolbar controls as Unicode text: ◀ ▶ ⟳ (back, forward, reload),
↩ (back to /), ↗ (open in browser), ▾ in the origin chip, ▾/▴ on the grid settings toggle, and ● for
the reach dot. None of these are in the app's UI fonts, so each fell back to whichever system font
has it, with that font's own metrics. At one `font-size` they rendered at different optical sizes;
⟳ was the smallest.

## Change

New `src/renderer/components/ToolbarIcon.tsx`. There was no icon component before. The rail's
`FootItem` draws its glyphs inline inside the component, so its style was matched rather than reused.

- **Grid:** `viewBox="0 0 16 16"`, `stroke-width` 1.5, round caps and joins, `fill="none"`,
  `stroke="currentColor"`, every mark drawn inside 3–13, rendered at 12px. That is a 1.125px stroke,
  close to the rail foot's 1.2-on-16 at 14px (about 1.05px).
- **Icons:**

  | Name | Drawing | Replaces |
  |---|---|---|
  | `back` | left chevron | ◀ |
  | `forward` | right chevron | ▶ |
  | `reload` | open circle with its arrowhead top right | ⟳ |
  | `root` | down-then-left return arrow | ↩ (Back to /) |
  | `external` | box with an arrow leaving its corner | ↗ |
  | `caret-down` / `caret-up` | small carets drawn inside the same grid, so the stroke weight matches | ▾ / ▴ |

- **Distinct glyphs for distinct verbs:** Back (address history) is a chevron and Back to / is a
  return arrow, so the two never share a glyph. Reload is the only circular mark.
- **`StatusDot`:** the reach dot in the origin chip and the alive dot in the server picker are now a
  6px round box with a background colour, not a `●` glyph. There is no border, so nothing is
  re-rasterised when the colour changes.
- **In `AppPreviewPanel.tsx`:** every glyph above is replaced. The icon buttons gain `aria-label`s
  matching their tooltips.
  - Hit areas, tooltips, colours and the disable-by-ink rule are unchanged: `navBtn` 18px, the
    open-in-browser `previewBtn` 22px bordered.
  - The grid caret button is centred at 18px high beside the `Grid` word.
  - Four comments that named glyphs now name the controls.
- **Text labels kept as text:** the device-width presets (Fit, 375, 768, 1280), the pointer modes
  (Interact / Annotate / Inspect), `Grid` and `Redlines`. The design spec
  (`preview-panel-and-design-tools-design.md` §5) makes Grid and Redlines text labels on purpose, and
  words have no fallback-font problem.

## Both tiers, both themes

- **Tiers:** the address group and the tools group are the same JSX in the one-row (≥ 880) and
  two-row / narrow tiers. `tier` only changes whether they share a row, so the icons are identical in
  every tier.
- **Themes:** everything is `currentColor` or an existing token (`--fg-muted`, `--border`, `--accent`,
  `--color-success`, `--color-error`), so ink follows the same rules as before in light and dark.

## Test

`src/renderer/components/session/preview-toolbar-icons.test.ts` (6). It renders the real
`AppPreviewPanel` in jsdom, with `fetch` stubbed so the server reads as up, and grid and redlines
enabled, so the tools row is on screen. It checks:
- the tools row rendered (Grid, Redlines, Reload present);
- every button's text contains no arrow or geometric-shape glyph, and every button with no letter or
  digit in it contains an `svg`;
- back, forward, reload, open in browser and the grid caret render the named icons;
- the whole bar's text has no glyph, including the origin chip;
- every `ToolbarIcon` shares viewBox, stroke, caps, colour and size;
- Back and Back to / are different icons.

Checked against a regression: putting `⟳` back into the reload button fails three of the six tests.

The file is `.test.ts` using `createElement`, because the renderer suite collects `src/**/*.test.ts`
only.

## Verification

- Renderer suite: 95 files, 1410 tests passed, 0 failed.
- `tsc --noEmit` passes.
- Not verified in the GUI. Still to check in the app, at a panel width of 880 or more and below it, in
  a light and a dark theme: the five address-row icons reading as one size, the origin chip's caret
  and dot, and the grid caret next to `Grid`.
