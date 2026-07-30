# ProjectRail tiles — density + user-chosen order

Answers `dev/briefs/rail-tiles-density-reorder.md`. Done after the foot-balance pass, same file,
one sequence, as the brief requires.

Driver: **`dev/drive-rail-tiles.mjs`** (new). It seeds seven live projects, because the rail is
only ever as crowded as the number of projects you have RUNNING and a two-tile fixture cannot show
cramming.

---

## Part 1 — the cramming

Sized against the **drawn** extent, not the 28px box, exactly as the brief asks. Two things paint
outside the box and neither was in the old arithmetic: the corner pip hangs ~3px below its tile,
and the current-tile ring (`boxShadow 0 0 0 2px`) sits 2px beyond it on every side.

```
                                   box gap    real INK gap
before  (gap: 7, no wrapper)          7px       4–5px
after   (gap: 8 + 2px wrapper)       12px      10–12px  ordinary pair
                                                 8px    worst pair
```

**The worst pair is the one the box arithmetic hides**: a pipped tile directly above the *ringed*
tile, where both overhangs eat the same gap. I sized for it — at my first attempt (`gap: 6`, 10px
box) that pair still measured **6px** while ordinary pairs had 10, so the number that looked fine
in aggregate was still failing the exact case the user screenshotted.

Tile stays 28×28, rail stays 44, radius stays 7, colour still hashed from the project id, ring
still a `box-shadow`. The extra 4px per gap is `2px` transparent borders on a per-tile wrapper —
they carry the drop line, and being constant they mean revealing it can never shift the stack.

## Part 2 — drag to reorder

**Where the order lives.** A new durable field, `Project.railOrder?: number`, in
`~/.operator/projects.json`.

I first built this on the projects **array order** and was wrong to. I verified every write path
in `DashboardView` is order-preserving (`upsertProject` maps in place or appends, restore appends,
delete filters, hydration maps) — so it does work today. But nothing *declares* that, and one
`.sort()` added anywhere upstream would silently undo a user's arrangement with no error and
nothing to notice. The brief called for a field and the brief was right.

**Migration: none needed.** An existing store has no `railOrder` at all; those read as unplaced
and render in store order, exactly as before the first drag. The first drag stamps everything.

**What happens to the automatic sort:** `byActivityThenRecency` is **gone from the rail**,
outright. Not "user order wins when present" — the comparator is not consulted at all. It cannot
coexist with dragging: recomputed on every activity change, it would undo the drag the moment an
agent started or stopped, which is the worst kind of "it didn't save" — it *does* save and is then
overwritten. "Sometimes it resorts" was never on the table. Liveness stays visible through the
pip, which is what the pip is for.

Worth noting it was nearly a no-op here anyway: rail membership is already `live > 0 || current`,
so the live-first term is a tie for every tile and only recency was ordering anything. The gallery
and switcher still sort explicitly and are untouched.

**The defined slot for new arrivals.** `railOrder` is a total order over the **whole store**, not
just the visible tiles — a drag restamps every project. Unplaced projects (`undefined`) sort after
every placed one, in store order, which is creation order. So:

- a brand-new project → **end of the rail**
- a project that appears because something just went live in it, never placed → **end**
- one that *was* placed and comes back → **its place**

Never the middle of an arrangement the user has learned. Restamping the whole store is what makes
that safe: numbering only the visible subset leaves off-rail projects holding stale indices that
now belong to someone else, and the collision only surfaces later.

`reorderByIds` is reused, not reimplemented — same helper as the roster board and the sidebar's
session rows.

## Verified

```
1 tiles 7 · tile box 28x28 · ink gaps 8–12px (was 4–5)
2 tiles are draggable: true
2 the dragged tile moved to the front: true · nothing lost or duplicated: true
3 projects.json payload carries railOrder: 8/8   ← the order is TOTAL, incl. a project
                                                    that is not on the rail
3 durable order matches what the rail renders: true
3 the drag SURVIVED a restart: true
3 …and is not merely the default order: true
3b no drop line anywhere at rest: true
3b click still opens a project: [operator] -> [el-encanto]
5 expanded  tiles 7 · tightest INK gap  8px · draggable true
5 collapsed tiles 7 · tightest INK gap 10px · draggable true
5 gallery   tiles 7 · tightest INK gap 10px · draggable true
```

**On the acceptance test.** The brief says read the durable state, not the UI. The driver now
captures the payload handed to `saveProjects` — what would be written to `projects.json` — asserts
`railOrder` is on every project, and checks the rail renders that order. It is a harness, so that
payload is intercepted rather than read back off disk; I have not driven a real quit-and-relaunch
against the user's own `~/.operator/projects.json`. That last mile is the one thing here I can't
close myself.

Interaction rules, all checked: the tile IS the handle (no grip); a plain click still opens the
project; the hover card is dismissed on drag start; the drop indicator is a hairline between
tiles, never a left-border stripe; the dragged tile dims (no motion added — idle tiles never move
on their own). The `closest('[draggable]')` trap does **not** apply: that predicate appears
nowhere in `src/`.

`npm run build` clean. `npm test` **429/429** (+9 — `byRailOrder` / `reorderRail` in
`project-shelf.test.ts`, covering the no-migration case, the NaN trap, the end-slot rule,
total-order restamping, JSON round-trip, and referential stability so the persist effect doesn't
churn). `node dev/drive-theme-pass.mjs` all 6 palettes: **BELOW FLOOR: 0**, rail tile acronyms
unchanged (5.12–10.14).

*(One theme-pass run died on `[data-page-tab="library"]` — a 30s Playwright timeout in the Agent
Library step, unrelated to anything here. A clean re-run passed; recording it as flake, not a
pass I explained away.)*

---

## Not done

- **The sidebar's own reorder still doesn't persist.** The brief asked me to say so if I fixed it
  with the same mechanism. I did not. `handleReorderSession` reorders the `terminals` array in
  memory only, and terminals are runtime state rather than a durable store — so it needs a
  different home (a per-project saved order keyed by `savedKey`), not this field. Out of scope
  here; the rail's defect is fixed and the sidebar's is untouched.
- **No auto-scroll at the stack edges while dragging.** Past ~17 live projects the column
  overflows into a hidden-scrollbar scroller; if you can't see the target tile you can't drop on
  it. Widening the gap moved that threshold from ~20 to ~17. Judged worth it — the real store is
  ~10 projects and only live ones appear — but it is a real limit and it now arrives sooner.
- **Reorder at the gallery.** Tiles are draggable there (verified) with `activeProjectId` null; I
  checked the tiles render and drag is enabled, but did not complete a drag in that state.
