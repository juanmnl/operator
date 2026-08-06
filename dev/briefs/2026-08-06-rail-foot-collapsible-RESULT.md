# RESULT — The rail foot folds

**Brief:** `dev/briefs/2026-08-06-rail-foot-collapsible.md` · **Lane:** Design · **2026-08-06**
**Commit:** `3d8329f` on `operator/63f860` — separate from the toast work (`11d2387`), as required.
**Status:** built and verified. `npm test` 701 passed (57 files) · `npx tsc --noEmit` clean ·
`npm run build` clean · fold harness **PASS** on all six palettes · the existing rail-invariant
harness still **CLEAN**.

---

## 1. The tiering — which four stay, and why

| | | why |
|---|---|---|
| **RESTING** | **Agents** · **All projects** · **Open folder** | The strip's constant verbs. `Open folder` is how a project enters Operator at all. |
| | **Plan usage** | **The one override on frequency.** |
| **FOLDED** | **`.claude`** · **`~/.claude`** | Occasional — you open them when editing agent config. |
| | **Preferences** | Occasional — you open it when something is wrong. |
| | **theme toggle** | Rare. |

**The line is drawn on frequency, with one override for ambience.** Three of the four resting
items are simply the things you reach for constantly. `Plan usage` is there for a different
reason, and it is the decision I most want on the record: it is the only control in the foot
whose value is **being seen rather than being clicked**. A meter you have to unfold to read is a
meter you check when you already suspect the answer — which is exactly too late. Folding it would
have returned 24px and cost the thing it exists for. It is also the only one of the eight with no
keyboard route, because "how much is left" is not a command.

**The theme toggle folds despite being the delightful one.** The brief called it
rare-but-delightful, and that is precisely the profile that survives folding: delight has to be
*findable*, not *resident*. A control you use a handful of times ever does not earn a permanent
24px of a column whose scarce resource is height.

**Nothing folded becomes unreachable.** All four already have a ⌘K route — `Edit settings for
<project>`, `Global Claude files`, `Operator preferences`, `Switch to light/dark mode`. Folding
costs one click and never reachability. (This supports the tiering; it did not decide it —
Agents and All projects are palette-reachable too. Frequency decided it.)

---

## 2. The pairs survive intact — the cut lands on a seam that was already there

This is the answer to the brief's question 4, and it is why the split is 4/4 rather than, say,
5/3. The foot's four hairline-fenced groups carry real meaning, so the fold does not flatten
them — it cuts **between** them:

```
  Agents        | Plan usage      ← views ACROSS projects      ┐ stays
  ────────────────────────────────                             │
  All projects  | Open folder     ← navigation BETWEEN them    ┘
  ──────── ⌄ ─────────────────────  THE FOLD
  .claude       | ~/.claude       ← Claude files               ┐ folds
  ────────────────────────────────                             │
  Preferences   | theme           ← app                        ┘
```

Nothing is regrouped, nothing is flattened, and every group the foot already taught still means
what it meant. A unit test asserts both tiers hold an even count, so a future edit cannot split a
pair across the fold without failing.

---

## 3. The affordance — the seam IS the control

**A ninth cell would have cost a 24px row to save two**, which is most of the point back. Instead
the disclosure *replaces* the hairline that already separated "navigation between projects" from
"Claude files". Its layout box is `height: 1, margin: 9px 0` — the same 19px a plain hairline
takes — and the 18×14 button overhangs into that air without claiming any of it.

The consequence is worth stating plainly: **unfolded, the foot is exactly as tall as it was
before this change.** The fold adds nothing; it only takes away.

**Two verbs never share a glyph.** I checked rather than assumed: `SidebarToggle.tsx` draws a
**panel with a divider** (`<rect>` + `<line>`), not a chevron. Nothing else in the strip uses one
— the only other mark nearby is the update affordance's ringed up-*arrow* in the identity row, a
different silhouette in a ring in the accent. The two verbs are "hide the strip" and "unfold the
foot"; they carry two different marks on two different surfaces. The fold harness asserts the
disclosure does not draw a `rect`, so the glyphs cannot converge later.

The label is worded and **names the count** — `Show 4 more controls` / `Hide 4 more controls` —
so you know whether unfolding is worth the click. A test asserts it never says "collapse",
"expand" or "sidebar": those verbs belong to the other control.

**Rest state.** The disclosure is drawn *always*, at `--fg-muted`, never hover-only — so the house
rule about reserving space at rest is satisfied by not applying: the foot is genuinely shorter,
not merely emptier. The harness asserts `display`/`visibility`/`opacity` at rest rather than
trusting that.

**On the axis.** `AXIS − FOOT_PAD − W/2`, so its painted centre is 30 element-local at **60 and at
264** — like the identity row below it, not the midpoint of whatever row it sits in. Measured
Δaxis = **0.00** at both widths in all six palettes.

---

## 4. Persistence and keyboard

`operator.railFootExpanded`, its **own key** — the rail's *width* (`operator.sidebarCollapsed`) is
a different axis and the two must not be entangled; a test asserts the fold never writes the
width key. Reads that throw fall back to folded rather than surfacing an error from a strip
ornament.

**Default is folded.** Defaulting to expanded would mean nobody gets the space back unless they
went looking for a control they did not know existed — the same as not shipping it. Nothing is
lost, because the seam that reveals them is drawn at rest.

**⌘⇧O and ⌘N are untouched** — they were never wired through the foot's buttons. The harness
presses ⌘⇧O with the foot folded and confirms the gallery is reached, in every palette.

**The version line and update affordance sit outside the folded region** and always render, so an
available update stays discoverable when the foot is folded. Asserted.

---

## 5. Verification

**`dev/drive-rail-foot-fold.mjs`** (new) — five assertions, all six palettes:

| | folded | unfolded |
|---|---|---|
| foot rows | **2** | **4** |
| hairlines | 2 | **3** (the fold *replaces* one, never adds) |
| resting controls present | **4/4** | 4/4 |
| folded controls present | **0/4** — absent from the DOM, not merely invisible | **4/4** |
| foot height | **130.25px** | 197.25px |
| agent list gets | **753.75px** | 686.75px |
| disclosure Δaxis | 0.00 | 0.00 |

**Real estate returned: 67px — 34% of the foot**, identical in every palette. Persistence proven
in both directions through the real `localStorage` the app writes (click → reload → still folded;
click again → reload → still unfolded), plus the whole sweep repeated at rail width 264.

**One defect the harness found — in the harness.** The first run reported "the folded state did
not survive a reload" in both palettes. It was not a product bug: Playwright init scripts run on
*every* navigation, so my seed re-stamped `railFootExpanded` over the value the click had just
written, and the reload "lost" a state the harness itself had overwritten. Seeding is now
once-per-context behind a sentinel. Recording it because that class of failure reads as a real
regression and is the expensive kind to chase.

**`dev/drive-rail-invariant.mjs` — updated in the same commit, and still CLEAN.** Its assertions
B and S are about all *eight* glyphs, so it now boots the foot unfolded; a harness that measured
only the four resting ones would have quietly stopped asserting the thing it exists for. The
precise ink work the brief said not to undo is intact:

```
  extent spread 0.50px across 8 controls  ok
  foot controls present: 8/8  ok
  hairline 1: 9.0 above · 9.0 below  ok
  hairline 2: 9.0 above · 9.0 below  ok      ← the fold's own seam
  hairline 3: 9.0 above · 9.0 below  ok
  Y · FOOT ROWS identical y at both widths — worst Δy 0.00  ok
```

Holding the disclosure's layout box to the hairline's exact 19px is what keeps hairline 2's
rhythm reading 9/9 rather than becoming a special case.

**House rules held:** semantic vars only, no hardcoded colour, no accent fill (the button paints
`--bg-sidebar` so the hairline reads as passing *behind* it), no browser focus ring (inset
box-shadow, which also dodges the colour-changing-border-on-a-radius trap), no coloured
left-border stripe, no group opacity, no opacity stacked on `--fg-muted`. The chevron paints 9px
against the foot glyphs' 12 — the `+`'s rule, that a junior mark sits at or under the family it
is subordinate to.

**Scope:** `Toast.tsx` and the toast state in `DashboardView` were not touched; `git show --stat
3d8329f` lists neither.

---

## Files

| File | |
|---|---|
| `src/renderer/lib/rail-foot.ts` | **new** — the tier lists, the persistence key, the disclosure label. The reasoning lives here because it is the part worth reading. |
| `src/renderer/lib/rail-foot.test.ts` | **new** — 15 tests: tier partition, the even-count rule that protects the pairs, persistence both ways, storage that throws, label wording |
| `src/renderer/components/sidebar/ProjectRail.tsx` | `FootDisclosure`, the folded fragment, the state hook |
| `dev/drive-rail-foot-fold.mjs` | **new** — the fold's own harness |
| `dev/drive-rail-invariant.mjs` | boots the foot unfolded, with the reason recorded inline |
