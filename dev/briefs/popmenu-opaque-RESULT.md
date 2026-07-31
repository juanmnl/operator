# PopMenu — an opaque surface

Answers `dev/briefs/popmenu-opaque.md`.

---

## The surface

`--overlay-medium` → **`--bg-surface`**, matching the rail's hover card (`ProjectRail.tsx:438`)
rather than inventing a value.

Your diagnosis was exact, and the token values make it stark: `--overlay-medium` is
`rgba(255,255,255,0.12)` on the dark palettes and `rgba(0,0,0,0.10)` on the light ones. **A 10–12%
wash** — the panel was ~90% transparent. It is a tint token for something that already has a
background (a hover state, a selected row); a floating panel has nothing behind it but the content
it covers.

Measured after, all six palettes:

```
mission-control-dark    rgb(22, 27, 33)     alpha 1
mission-control-light   rgb(226, 230, 228)  alpha 1
mr-pink-dark            rgb(43, 43, 55)     alpha 1
mr-pink-light           rgb(231, 225, 231)  alpha 1
1984-dark               rgb(18, 20, 63)     alpha 1
1984-light              rgb(208, 209, 232)  alpha 1
```

**The blur is gone, not kept as taste.** It was doing the job the background should have been
doing and it cannot do that job — a blur displaces detail, it does not reduce contrast, which is
why dense text stayed legible straight through 8px of it. With an opaque surface it would composite
against nothing and cost a filter pass for no pixels.

## Callers checked

`PopMenu` is shared, so one change fixes every caller. All four menus:

- **`ProjectChannel`** — the send-target menu (the reported case).
- **`ChatComposer`** — model, reasoning-effort, and slash-commands. Same defect, same fix; it was
  the original home of the component before the composer pass extracted it.

No other callers (`grep` across `src/renderer`). The `CustomModelRow` footer renders *inside* the
panel and inherits the surface.

## The opacity assertion — cheap, and added

Worth it, and it belongs where you said: this is a **different check from contrast**, and the
contrast table structurally cannot make it. `__contrast` measures ink against the *intended*
surface token; a panel whose background is a 10% tint over a wall of text has fine nominal contrast
and is unreadable in fact. That is exactly how this shipped.

`drive-theme-pass.mjs` now opens the send-target menu and asserts the panel's computed
`background-color` alpha is 1, reporting per palette. It costs one click and one `getComputedStyle`.

**It caught two of my own probe bugs before it caught anything real**, which is worth recording:

1. I first measured `[data-popmenu-item]` — the item button, whose background is `transparent` by
   design — and got `alpha 0` on all six, i.e. a false failure for a perfectly opaque menu. It
   measures `item.closest('div')`, the panel, now.
2. Opening the menu dropped the row hover that the `channel copy action` probe depends on, and that
   probe went back to reading its `1.00:1` opacity artifact. The panel check now runs *first* and
   re-hovers the row afterwards.

## Verified

- `npm run build` clean. `npm test` **562/562**.
- `node dev/drive-theme-pass.mjs`, all six palettes: **`BELOW FLOOR: 0`**, and every palette reports
  `panel · PopMenu … alpha 1`.
- Eyeballed the menu open over a dense feed on Mr Pink light — the worst case in the report — and on
  Mission Control dark: `/tmp/operator-shots/popmenu-{light,dark}.png`. Nothing reads through.

## Not done

- I did not audit every *other* floating surface for the same token confusion. The plan-usage
  popover has a probe slot in the new check but does not render in the theme pass's flow, so it is
  unverified here — it uses `--bg-surface` in source. If you want a real sweep of "every popover is
  opaque", that is a small follow-up: the check is written to take a list, and adding selectors is
  one line each.
