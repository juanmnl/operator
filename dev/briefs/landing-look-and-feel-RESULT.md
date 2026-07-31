# The landing's look and feel: it was the fonts, and it was depth

Answers `dev/briefs/landing-look-and-feel.md`. Sequenced as you suggested — fonts first, then
tokens, then the panel treatment — and the first step did change how much of the rest was needed.

---

## 1 · Fonts — the whole gap, and it was free

`--font-body: 'Archivo'` and `--font-mono: 'JetBrains Mono'` had been in the tokens since the
tokens were written, with **no `@font-face` behind either**. Every surface in the app has been
falling back to `system-ui` / SF Mono for its entire life. A declared family that never loads fails
**silently** — the fallback looks fine, it just isn't the design — which is why this survived so
long.

**Vendored** into `src/renderer/fonts/`, both OFL 1.1 with licences alongside:

```
archivo-latin.woff2             34.9 KB      jetbrains-mono-latin.woff2       31.3 KB
archivo-latin-ext.woff2         32.7 KB      jetbrains-mono-latin-ext.woff2   11.6 KB
                                                                    total ~110 KB
```

Both families ship as **variable** fonts, so one file covers 400/500/600/700 — hence
`font-weight: 100 900` on each face rather than four static cuts. `latin-ext` earns its 44 KB:
project and folder names are whatever the user's filesystem says, not ASCII. `font-display: swap`
(local files resolve in a frame; `block` would risk an invisible-text flash on a cold start).

**Before / after, measured** (`dev/drive-fonts.mjs`):

```
1 Archivo usable: true    JetBrains Mono usable: true
2 same string, real family vs the fallback it had been using:
    Archivo 600/13         168.53px  vs system-ui    179.15px   Δ -10.62
    JetBrains Mono 500/11  184.80px  vs ui-monospace 190.39px   Δ  -5.59
```

Archivo is ~6% narrower than system-ui at UI sizes, which is visible immediately: a gallery card's
description now fits "…shows every tool call live, and lets…" where it used to break at "live…".

**The terminal does not move, and not by luck.** It names its own stack in
`lib/terminal-options.ts` and never reads `--font-mono`, so JetBrains Mono cannot reach a cell.
Asserted anyway, because "it can't happen" describes every silent regression before it lands:

```
4 rows: Operator Symbols   measure element: Operator Symbols
5 terminal metrics WITH the UI faces:  {"measure":250.453,"row":1135,"rowH":15}
5 terminal metrics with them REMOVED:  {"measure":250.453,"row":1135,"rowH":15}
5 identical: true
```

`.xterm` and `.xterm-screen` *do* inherit Archivo from body — they always inherited whatever body
had — but they render no text. The two elements that decide a cell are `.xterm-rows` and
`.xterm-char-measure-element`, and both take the terminal's own stack. My first version of this
check asserted on `.xterm` and reported a regression that wasn't one.

**One methodology note that cost me a wrong claim:** `getComputedStyle().fontFamily` returns the
**declared** stack and reads `'Archivo'` whether or not the family ever loaded. It is the wrong
instrument here, and it is exactly why nobody noticed. `document.fonts.check()` is the honest
question, and my before/after harness was vacuous until I switched to it.

**This also resolved a separate brief.** `optical-centering.md` reported avatar initials sitting
high in their discs. Measured at 2×, the ink sat **0.75px low in system-ui and 0.25px low in
Archivo** — the letters looked wrong because the app declared a typeface it never loaded. See
`dev/briefs/optical-centering-RESULT.md`.

## 2 · Tokens — there is no delta

I diffed our themes against the landing's `--op-*` tier expecting to reconcile. **Every value is
already identical**, dark and light:

| landing | ours (Mission Control) | |
|---|---|---|
| `--op-bg #0b0d10` | `--bg-terminal #0b0d10` | ✓ |
| `--op-rail #07090b` | `--bg-sidebar #07090b` | ✓ |
| `--op-surface #161b21` | `--bg-surface #161b21` | ✓ |
| `--op-fg #eef1f3` | `--fg #eef1f3` | ✓ |
| `--op-muted #8a94a0` | `--fg-muted #8a94a0` | ✓ |
| `--op-accent #2fe39a` | `--accent #2fe39a` | ✓ |
| `--op-border #21272f` | `--border #21272f` | ✓ |
| `--op-accent-fg #04130d` | `--fg-on-accent #04130d` | ✓ |

The light set matches too (`#ecefed / #e2e6e4 / #1f2937 / #6b7280 / #0ca678 / #cdd2cf`). The
landing's own header says why: *"`--op-*` the app's own chrome, Mission Control, ported from
../operator."* **The colours came from us.** So the look-and-feel gap was never colour — it was
type and depth, which is a useful thing to know before anyone repaints anything.

I also found a **partial port of the kit already in `styles.css`** — `.op-label`, `.op-bar`,
`.op-row`, `.op-badge`, `.op-nest`, `.op-display` — used in exactly two views
(`SessionActivityView`, `AgentLibraryView`). Someone did a first pass. What was missing was the
centrepiece.

## 3 · The panel treatment — adopted, in the one place that propagates

Your diagnosis was right: our panels were flat and borderless. The app's main content card is
`background: var(--bg-terminal); border-radius: var(--radius-lg)` against a `--bg-sidebar` field
one step darker, with **nothing else separating them** — the card read as the field.

Adopted at `DashboardView.tsx:3077`, which is *the* content card, so every mode inherits it and no
mode can drift:

```ts
boxShadow: 'var(--shadow-panel), inset 0 0 0 1px var(--panel-edge)',
```

New per-theme tokens, and they are **not** the same on light and dark — the landing runs one
shadow because it is a dark-first page, but `0 12px 34px rgba(0,0,0,0.24)` on a white field reads
as dirt rather than lift:

```
dark    --shadow-panel: 0 12px 34px rgba(0,0,0,0.24)   --panel-edge: border 70%
light   --shadow-panel: 0 6px 18px  rgba(0,0,0,0.10)   --panel-edge: border 85%
```

**I did not take:** the landing's `.panel-bar` traffic lights (we host the real ones), its scroll
reveal (`opacity`/`transform` on entry — motion means *busy* in this app), and `.panel-total` /
`.panel-flag` as such, since `.op-bar` already covers that ground.

## ⚠️ The two things I couldn't copy literally

**1 · `.panel:hover { border-color: … }` — the WKWebView trap.** I sidestepped it structurally:
the content card has **no hover state** (it is not a clickable card), so the trap has nothing to
trigger it. More usefully, **both** the edge and the drop are `box-shadow`, never `border` — so if
someone does add a hover later, the thing that changes is already a shadow and is safe by
construction. That is the rule: *on a radiused element, an edge that might ever change colour is a
`box-shadow`, not a `border`.*

**2 · Where the solid-accent-fill line goes.** Stated explicitly, since getting it wrong in either
direction is a real regression:

> **Solid accent fill is for a primary ACTION and for point markers. Never for STATE.**
>
> - **Allowed** — a button that performs the surface's main verb (Launch, Install, Send, +New);
>   and a point marker ≤6px with no interior (a status dot, an annotation pin).
> - **Not allowed** — state on a badge, chip, row, card or tile. State uses a transparent tint
>   plus a hairline, coloured text, or a dot.
>
> The test: *does it do something, or does it tell you something?* A fill that tells you something
> is shouting a fact.

Audited every solid accent fill in the app against it — **5 sites, all compliant**: the rail's
`+ New session` and Prefs' `Install` (primary actions), TaskQueue's 6px running dot and the preview
pin (point markers), and the sidebar's active-row bar.

**One thing that audit turned up, flagged not fixed:** `SidebarRail.tsx:270` draws a 3px accent bar
down the left edge of the active row, and `.op-row.is-live` in `styles.css` sets
`border-left-color: var(--accent)`. Both are the **coloured left-border marker stripe** the house
rules say never to use. Both predate this brief and neither is a fill question, so I left them —
but they are the same pattern in two places and worth a decision.

## Verified

- `npm run build` clean; `npm test` **562/562**.
- `node dev/drive-theme-pass.mjs` — **`BELOW FLOOR: 0`** on all six palettes, with the new fonts
  in. This was the check that mattered: new metrics change x-height and stroke density, and
  contrast at 9.5–11px is where that would show.
- `node dev/drive-fonts.mjs` — **PASS** (loaded · distinct from fallback · terminal untouched).
- Screenshots before/after, all four surfaces:
  `/tmp/operator-shots/fonts-{before,after}-{channel,session,agents,gallery}.png`. Light-palette
  elevation: `/tmp/operator-shots/panel-{mission-control-light,1984-light}.png`.

## What I'd do next

The design system has more in it than I took, and the honest reason I stopped here is that fonts
plus depth is the bulk of the perceived delta and the rest is per-surface work that wants its own
pass. The best candidates, in order: `.panel-bar`'s treatment for the surfaces that still have
ad-hoc headers, the diff-line kit against `CanvasDiffPanel`, and the tree-row kit — which is really
`.op-row` finishing the job it started in two views.
