# Brief — adopt the Operator landing's look and feel. Start with the fonts, because they're missing.

User: *"check operator landing, there's a bunch of components there, that's the look and feel i want
in this app, make it happen, have fun."*

Source: `~/Developer/Operator-landing` — `styles.css` (650 lines) and **`design-system.html`**, which
documents the kit in sections: Tokens & type · Panel shell · Tree rows · Diff lines · Buttons ·
Liveness · Assembled. **Open the design system in a browser and look at it** before reading the CSS.

## Start here — the fonts are declared and never loaded

`src/renderer/styles.css` already says:

```css
--font-body: 'Archivo', system-ui, -apple-system, sans-serif;
--font-mono: 'JetBrains Mono', ui-monospace, 'SF Mono', monospace;
```

…and the only `@font-face` rules in the app are the four terminal symbol fonts
(`operator-dingbats`, `operator-symbols`, `operator-legacy`, `operator-emoji`). **Archivo and
JetBrains Mono are never loaded, and nothing is bundled**, so every surface has been falling back
to `system-ui` / SF Mono. The landing gets them from Google Fonts; a desktop app cannot.

**Vendor both as woff2 into `src/renderer/fonts/` and add `@font-face`.** This is the single
largest look-and-feel delta and it is nearly free. Notes:

- Subset if the full families are heavy — but check the terminal first: `--font-mono` is used by
  the composer, chips and labels, and the terminal has its own hard-won font stack and width
  behaviour. **Do not change what the terminal renders with.** If JetBrains Mono reaching the
  terminal would alter cell metrics, scope the change so it doesn't.
- Weights actually used by the landing: Archivo 400/500/600/700, JetBrains Mono 400/500/700.
- `font-display` and a fallback that doesn't reflow the terminal.

Do this first and report the before/after — it may change how much of the rest is even needed.

## Then the kit

Compare the landing's tokens to ours and say where they genuinely differ (not just in name):

```
--op-bg #0b0d10   --op-rail #07090b   --op-surface #161b21
--op-fg #eef1f3   --op-muted #8a94a0  --op-border #21272f
--op-accent #2fe39a   (mint)          + a full light set
```

Then the components. `.panel` is the centrepiece — radius 10, surface fill, 1px border,
`box-shadow: 0 12px 34px rgba(0,0,0,0.24)`, a `.panel-bar` (mono 10.5px name, right-aligned accent
flag in uppercase at 0.16em tracking) and a `.panel-foot` (mono 10px, muted). Section headers are
mono 12px uppercase at 0.18em.

**Our panels are flat and borderless by comparison.** The landing's depth — shadow plus a defined
surface — is a lot of what makes it feel considered. Take it where it fits.

## ⚠️ Two things you cannot copy literally

1. **`.panel:hover { border-color: color-mix(accent 30%, border) }`** — a colour-CHANGING border on
   a `border-radius: 10px` element. That is exactly the WKWebView re-rasterization trap; the landing
   is a website in Safari, we are not. **Use a `box-shadow` ring for the hover state.** The same
   applies anywhere the kit animates a border colour.
2. **`.btn-primary` is a solid accent fill.** Our rule is *no solid accent fills for state* — but
   that rule is about **state** (selected, live, active), not about a primary **action**. A Launch
   or Send button is a legitimate solid fill. **Draw that line explicitly in your result**, because
   getting it wrong in either direction is a real regression: solid fills creeping onto state
   badges, or a primary action that looks like a link.

## Scope — you have latitude, use it deliberately

The user said "have fun". Take that as licence on **how far** to go, not as licence to skip the
rules above. My suggestion for sequencing, argue it:

1. Fonts. Measure the difference.
2. Tokens — reconcile ours against the landing's, keeping our semantic names.
3. The panel treatment on the surfaces that most read as flat today.
4. Anything else the design system offers that we lack.

Do **not** regress the six-palette contrast work or the layout work from today. This is a skin over
a structure that is now roughly right, not a reason to move things again.

## Verify

- Screenshots before/after of at least: the channel, a session, the Agents hub, the gallery.
- `node dev/drive-theme-pass.mjs` — all six palettes, **`BELOW FLOOR: 0`** must hold. New fonts
  change metrics and can change contrast at small sizes; this is the check that catches it.
- The terminal renders identically — same glyph widths, same alignment. `npm run verify:width` if
  you touch anything the terminal reads.
- `npm test`, `npm run build` clean.

## Where to work

`main` is at `32616ea`. Commit in your own worktree; I'll merge forward. Do not touch
`/tmp/claude-501/merge-main`.

## Output

`dev/briefs/landing-look-and-feel-RESULT.md`: what the fonts changed, the token reconciliation,
which components you adopted and which you left, where you drew the solid-fill line, how you
handled the hover-border trap, and the six-palette table. Then one OPERATOR-REPLY line.
