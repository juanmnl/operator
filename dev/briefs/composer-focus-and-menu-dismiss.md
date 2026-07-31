# Brief — the send-to menu won't dismiss, and the composer's focus ring is shouting

Two defects on the composer, both reported from the running build.

## 1 · `PopMenu` does not close on an outside click

User: **"send to should close when clicking outside."**

Open the target menu, click anywhere else, and it stays. That's table stakes for a popover, and
it's the shared component — so `ChatComposer`'s menu has it too.

Cover the whole dismissal contract, not just the reported click:

- **Outside pointer-down** anywhere in the document closes it.
- **Escape** closes it and returns focus to the control that opened it.
- **Tab out** closes it — a menu that survives focus leaving is the same bug with a different input.
- **Scroll** of the pane underneath: decide whether it closes or repositions, and say which. A
  menu anchored to a control in a scrolling pane that does neither will detach from its anchor.
- Selecting an item already closes it; keep that.

Use pointer-down rather than click for the outside case — a click that starts inside and ends
outside should not dismiss, and vice versa.

**Check `useHoverCard`'s hardening first** (`lib/use-hover-card.ts`). It already solved the
adjacent problem — cards frozen on screen when the cursor left the window — and the reason it
exists is that naive enter/leave handling left them stuck. If there's a shared dismissal helper
to reuse or extract, reuse it rather than writing a third dismissal implementation.

## 2 · The focus ring is too loud, and the field reads as disabled

Screenshot, light theme: the focused composer is ringed in **full-strength accent green**, and its
interior is grey against a white page — so at rest it reads as a disabled field, and focused it
reads as an alert.

```ts
boxShadow: focusWithin ? 'inset 0 0 0 1px var(--accent)' : 'none',   // :925
background: live ? 'var(--overlay-subtle)' : 'transparent',          // :924
```

Two things, both consistent with rules this file already follows elsewhere:

- **Raw `var(--accent)`.** This same file defines `ACCENT_INK` as `color-mix(--accent 55%, --fg)`
  precisely because raw accent is wrong at small sizes on the light palettes. A 1px ring is not
  text and isn't held to a text floor — but "not held to a floor" is not "use it raw". Tune it so
  focus reads as *attention*, not as an error state.
- **The resting fill.** `--overlay-subtle` over a light page gives a grey box, which is the visual
  language of *disabled* — and this composer genuinely does have a disabled state, so the two now
  look alike. Make focused / resting / disabled three distinguishable things. Check the actual
  disabled rendering side by side rather than reasoning about it.

Keep the ring an inset `box-shadow` — a colour-changing border on a radiused element is the
WKWebView re-rasterization trap, and this element radiuses and changes on focus.

## Verify

- Menu: outside click, Escape, Tab-out, scroll — in the channel **and** in `ChatComposer`.
- Composer: resting, focused and disabled side by side on **all six palettes**; the light ones are
  where both defects show.
- Focus returns somewhere sensible after Escape.
- `npm test`, `npm run build` clean.

## Where to work

`main` is at `573deaa`. Commit in your own worktree; I'll merge forward. Do not touch
`/tmp/claude-501/merge-main`.

## Output

`dev/briefs/composer-focus-and-menu-dismiss-RESULT.md`: the dismissal contract as implemented
(including the scroll decision), whether you reused an existing helper, the three composer states
with their values, and the six-palette check. Then one OPERATOR-REPLY line.
