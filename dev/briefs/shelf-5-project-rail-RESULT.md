# RESULT — Option B: the persistent project rail

Built against the **twice-amended** brief. I had the first draft (all-active membership, orbs)
working before the amendments landed; both were re-done, and the earlier version is gone —
nothing from it survives except `lib/project-accent.ts`, which both drafts needed.

---

## What landed

### `lib/project-accent.ts` (new)

- **`projectAccent(id)`** — FNV-1a over the project id into a fixed palette. Deterministic,
  derived (no field, no migration), and hashed from the **id**, so a reshuffle can't repaint
  the rail.
- **`projectInitials(name)`** — splits on separators **and camelCase**, then first-letters of
  the first two parts (or the first two letters of a lone part). Gives the brief's table
  exactly: `OP EE MA ML UA VL WE FA FL FT`.
- **Palette: the picker's swatches minus slate** (`#94a3b8`), 11 chromatic colours. In the
  lane picker slate is the deliberate "no colour" choice; as an *identity* it reads as "this
  project hasn't got one". One-line filter, commented. Everything else is the sanctioned
  `ACCENT_SWATCHES`, so a project tile and a lane orb read as one system.

### `components/sidebar/ProjectRail.tsx` (new)

44px, full height, outboard of the sidebar, `borderRight` hairline, and it hosts the traffic
lights now (40px `DragRegion` at its head — it's the leftmost strip).

**Tiles, per the amendment.** 28×28, `border-radius: 7`, acronym 10/600/0.02em.
`background: color-mix(<accent> 16%)`, `border: 1px solid color-mix(<accent> 38%)` — **static**,
never repainted — and ink from `laneTextColor(<accent>)`. Hover deepens the tint to 26%
(background only). Current project ringed with `box-shadow: 0 0 0 2px var(--accent)`, never a
border.

**Corner pip** bottom-right at `-3/-3`, `StatusWave size={9} seed accent`, and **absent when
idle** — so the app's one motion rule comes free and a quiet tile carries no grey dot.

**Membership: `live > 0`, plus the current project always.** Not the active shelf. An archived
project still appears if something is live in it — driver-pinned, because "a running agent is
never hidden" is the one rule that outranks the shelf.

**Bottom:** seam, then a 2×2-grid "all projects" control → `onShowGallery`.

### Wiring — `DashboardView.tsx`

The rail and the collapsible sidebar are now grouped in one flex child, so the root's 8px gap
falls between that pair and the content card and the two strips stay flush. The sidebar's
width animation (220 / 64 / 0) is untouched; the rail sits outside it and therefore survives
the gallery's collapse-to-zero, which is the entire point.

### Removed

The cross-project orb cluster I had just added inside the 64px `SidebarRail` (old plan step 5)
is deleted — `git diff --stat` on that file is back to +4 lines, all comment explaining why it
carries no project orbs. `drive-sidebar-ambient.mjs` step 7 now asserts its **absence**.

---

## How the identity palette reads at 19 projects

Short answer: **it doesn't have to, any more** — and that's the amendment's real win.

Under the first draft the rail showed all 19 active projects, and 11 swatches over 19 ids gives
10 distinct colours with a largest bucket of 4 (measured, and pinned as the spread test). Nine
of nineteen would have shared a colour with someone. That's a weak identity channel.

Under the amended membership the rail is **what you have open** — 1–3 tiles in practice, 2 in
the fixture. At that size the colours are effectively unique, *and* the acronym is a second
independent channel, so `fastrack` / `Fastrack-landing` / `FastTrack` separate as `FA` / `FL` /
`FT` even if two of them draw the same swatch. The pigeonhole limit is still there; it just
stopped mattering.

The acronym also fixed the contrast question. In the first draft the identity colour was
painted as an orb fill and I had to measure it as a graphic; now it's real text, so it takes
the body floor like everything else — **5.12–10.14 across all six palettes** via
`laneTextColor`, which is exactly the helper the brief pointed at.

## Does the rail + ALSO ACTIVE duplication look wrong?

**No — the amendment resolved it, and I'd have raised it otherwise.** Under the first draft the
two lists were the same set 40px apart and it looked like a bug in the screenshot. Now:

- rail = 2 tiles (open), ALSO ACTIVE = 2 rows (all active minus current) in the fixture, and
  they overlap on exactly one project — the one that's both open and active but isn't where I
  am. That overlap is correct: it's the thing I'd most want in both places.
- On the real store the gap widens the right way — rail stays 1–3, ALSO ACTIVE lists ~18 today
  and ~5 after a tidy pass.

Screenshot: `/tmp/operator-shots/project-rail.png`. Two tiles reading `OP` (ringed) and `EE`,
each with a pip, against the sidebar's circular lane orbs — the square-vs-circle grammar does
the work the brief said it would; a tile never looks like an agent.

## What I'd flag

1. **The layout shifted right by 52px.** Card left edge went 198 → 220, and the theme pass's
   title/card alignment note tracks it (still Δ0). Nothing broke, but every screenshot in
   `/tmp/operator-shots` from before today is now 52px stale.
2. **The pip is small at 9px.** It reads clearly when animating (running/compacting) and is
   easy to miss at rest for `waiting` — which is the state you'd most want to catch. The
   hover card says it in words, and ALSO ACTIVE says "1 needs you" outright, so nothing is
   lost; but if `waiting` ever needs to shout from the rail, the pip is the lever, not the
   tile.
3. **Two projects can still share a colour** at 11 swatches. Tolerable now (acronym + small
   set), but if the rail ever grows past ~6 the palette should grow with it.

## Verification

- `npm test` — **271 passed / 34 files**, incl. 10 new `project-accent` cases: determinism, a
  pinned hash so a future "improvement" can't silently repaint everyone's rail, id-alone
  dependence, whole-palette usage over 400 ids, spread over the real 19, and the full acronym
  table incl. the camelCase split and the `FA`/`FL`/`FT` trio.
- `npm run build` — clean.
- `node dev/drive-navigation.mjs`, `dev/drive-sidebar.mjs` — pass, unchanged. Sidebar still has
  nothing overflowing its 220px box.
- `dev/drive-gallery-cards.mjs`, `-shelf.mjs`, `-tidy.mjs`, `dev/drive-sidebar-ambient.mjs` —
  all pass; card geometry (equal heights, aligned footers, 14px gutter) survives the shift.
- **`node dev/drive-project-rail.mjs` (new)** — 6 scenarios: 44px full-height strip at the left
  edge · **open-only membership** (the idle project is absent — it's in ALSO ACTIVE instead) ·
  current ringed via box-shadow · rounded-square tiles with tint/hairline/ink all derived from
  one accent · pips only where something is happening · identity survives a reload **and** a
  driven phase change · present and identical at gallery / expanded / collapsed, with the
  gallery header still clearing it · hover card · **a shelved-but-live project stays on the
  rail** · virgin app = zero tiles but the rail and its way-out remain.
- `node dev/drive-theme-pass.mjs` — 6 palettes, **0 below floor**, with `rail tile acronym #1/#2`
  at 5.12–10.14 and a per-palette note listing each tile's accent → acronym → tint. Rail crops
  at `theme-pass/<key>-1r-project-rail.png`.

## One harness bug fixed on the way

The theme pass had started dying at the 4th palette: it closed the tidy review sheet with
`Escape`, and a single missed keypress leaves the scrim up so every later step times out on an
invisible overlay — which reads as a product bug. It now clicks `Cancel`.
