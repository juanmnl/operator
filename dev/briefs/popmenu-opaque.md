# Brief — PopMenu is translucent; the feed reads straight through it

User screenshot, light theme: the target menu is open over the feed and the messages behind it
composite through the panel. The items are unreadable.

## The bug

`src/renderer/components/PopMenu.tsx:22-23`:

```ts
background: 'var(--overlay-medium)',
backdropFilter: 'blur(8px)',
```

**`--overlay-medium` is a translucent overlay token, not a surface.** It is meant to tint something
that already has a background — a hover state, a selected row. A floating panel needs an **opaque
surface**, and this app has one: `--bg-surface`, which is what the channel's own hover card and the
reading panels use.

`backdropFilter: blur(8px)` is doing the work that the background should be doing, and a blur is
not opacity — dense dark text at 151 characters a line stays legible through an 8px blur, which is
exactly what the screenshot shows.

## Fix

- Opaque surface (`--bg-surface`, or whatever the established floating-panel surface is — match
  the channel hover card at `ProjectChannel.tsx` rather than inventing a value).
- Keep the shadow; keep or drop the blur as taste, but it must not be load-bearing for legibility.
- **This is the SHARED component** — extracted from `ChatComposer` in the composer pass, so
  `ChatComposer`'s menu has the same defect. Check it and any other caller.

## The verification gap worth fixing too

`drive-theme-pass.mjs` did not catch this, and could not have: it measures ink against the
**intended** surface token, not against what is actually painted behind a translucent layer. A
menu whose background is 40% transparent over a wall of text has fine *nominal* contrast and is
unreadable in fact.

If there is a cheap way to assert "a floating panel's background is opaque" — computed
`background-color` alpha === 1 on every popover surface — add it. That is a different check from
contrast and it would have caught this. If it isn't cheap, say so and move on; don't build a
screenshot-diffing rig for it.

## Verify

- Open the target menu over a dense part of the feed on **all six palettes** — the light ones are
  where it fails worst.
- Same for `ChatComposer`'s menu.
- `npm test`, `npm run build` clean.

## Where to work

`main` is at `6b732db`. Commit in your own worktree; I'll merge forward. Do not touch
`/tmp/claude-501/merge-main`.

## Output

`dev/briefs/popmenu-opaque-RESULT.md`: the surface you used, every caller you checked, and whether
the opacity assertion was worth adding. Then one OPERATOR-REPLY line.
