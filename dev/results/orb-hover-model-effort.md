# Result — hovering an agent's orb shows its model and effort

**Branch** `design/orb-hover-model-effort`, from `operator/101200` (`ffb9253`), one commit `70da6a8`.
**Status** built, unit-tested, and driven through all six palettes in both rail states. Not GUI-verified by a human.

---

## What ships

Hovering a lane — the orb when the rail is collapsed, the row when it is expanded — opens the
lane's hover card, and the card now carries a small three-column block under the existing task
line:

```
MODEL     Sonnet          RUNNING
          Opus            AT LAUNCH
EFFORT    High            AT LAUNCH
```

Reading order is model, then effort, which is the order the ask names them in. The third column is
the point of the whole thing (below).

---

## Native `title` vs. a custom card: custom, and it is not a new widget

The brief framed this as a real fork, with the sticking risk on the custom side. On this branch that
risk is already retired, and the fork mostly dissolves:

- **Both rail states already open a custom hover card on this exact gesture.** `RailOrb` opens one
  with the lane's name (`ProjectRail.tsx`), `SessionItem` opens one with the lane's current task.
  I added a block to each. Choosing `title` would have meant putting the model under an OS tooltip
  that renders *on top of* the app's own card for the same hover — two panels, two delays, two
  aesthetics, for one gesture.
- **The hardening the brief worried about is in the code, not in a hope.** `lib/use-hover-card.ts`
  was rewritten around a single `openFor` field in one external store, so "at most one card" is the
  shape of the data rather than a lock. Every dismiss path is installed once at module scope:
  window `blur`/`resize`, document `visibilitychange`, `mouseout` with a null `relatedTarget` (the
  reliable *pointer left the document* signal), `documentElement` `mouseleave`, and capture-phase
  `scroll` and `keydown`. A row that unmounts while holding the card closes it on the way out.
  `project_hover_card_stuck`'s "the sidebar rail has none of it" is stale as of that rewrite.
- **The one thing that was genuinely untested was the wiring**, not the reducer —
  `hover-card-machine.test.ts` proves a `close` event closes a card, and nothing proved that a
  pointer leaving the window ever *produces* one. That is exactly the shape of the original defect:
  a path that reached no listener. So the installer is now an exported
  `installHoverCloseListeners({ win, doc }, close)` called once at module scope, and
  `use-hover-card.test.ts` asserts each path — including that `mouseout` closes **only** when
  `relatedTarget` is null, which is the guard the whole "leaves the window" case rests on.

`title` costs ~1s of delay and OS chrome; here it would also have cost a second panel. Custom, with
the dismiss paths now under test.

## The trigger: the row, not the 24px disc

The user said "the blob", and the blob is inside the row — hovering it opens this card, so the ask
is met at both widths. I did **not** narrow the expanded trigger to the disc alone:

- Collapsed, the orb **is** the row (`RailOrb`'s button is the whole 36px cell). Nothing to decide.
- Expanded, the row has been the hover target since the task card shipped. Narrowing to 24px would
  have bought nothing (the disc is inside the row either way) and cost the task line its trigger —
  and a 24px target on a 36px row is a worse target, not a more precise one.

## Configured vs. running, on screen

`session.model` looked like ground truth and is not. `DashboardView` merges it as
`t.model ?? hookSession.model`, so **the launch config wins**: a lane launched on `opus` reads
`opus` whatever it is actually answering with, and the transcript's own reading is erased by the
very value it is worth comparing against. (`transcript.rs:155` — *"Model from the latest assistant
message (the actual running model)"*.)

So `AgentSession.runningModel` is now carried **beside** `model` rather than folded into it — one
optional field, populated from `hookSession.model` in that same merge, `<synthetic>` skipped. The
merge's own precedence is untouched.

`lib/lane-meta.ts` turns the pair into rows, each stating its source:

| what we know | rendered |
|---|---|
| transcript reading (any) | `MODEL · <family> · RUNNING` |
| launch config only, no assistant turn yet | `MODEL · <family> · AT LAUNCH` |
| both, **different families** | two rows: running first, `AT LAUNCH` stacked under the same key |
| both, same family (`opus` vs `claude-opus-5`) | one row — same answer, not a divergence |
| neither | no block at all; if there is also no task, no card |
| effort | always `AT LAUNCH`, never `RUNNING` — there is no observation of it at any layer |

An alias and the full id it resolves to are compared by **family label**, not by string: printing
both would turn every ordinary lane into a two-line divergence report and make the real one
unreadable. Effort goes through `migrateEffort`, so stored legacy `normal` reads `Medium` and an
unrecognisable value drops its row rather than printing something we cannot vouch for. Labels come
from `EFFORT_OPTIONS`; the ladder is not re-spelled.

## Both rail states

- **Collapsed** — `RailOrb` now takes `effortLevel` from the same terminal-keyed map the expanded
  row reads, so the two widths cannot disagree about a value neither observes. Card = lane name,
  seam, meta block.
- **Expanded** — `SessionItem`'s card = task (still 3-line clamped), seam, meta block. The card's
  render condition widened from `card && currentTask` to `card && (currentTask || meta.length)`, so
  a lane with no task still answers the hover. The seam draws only when there is something on both
  sides of it.

One `LaneMeta` component for both — a second copy of this grid is how the two widths would start
disagreeing about what a lane is running.

## House style

Semantic vars only; no hardcoded colours, no accent fills, no focus rings. The label and source
columns take `--fg-muted` **flat** — no opacity stacked on it. The value column is
`minmax(0, 1fr)` with `text-overflow: ellipsis`: `modelFamilyLabel` returns the raw id for anything
it does not recognise, and three `auto` columns pushed a custom id straight past the card's 260px
edge. Verified with a deliberately unrecognisable id, then reverted.

## Fixture correction (worth knowing about)

`MOCK_SESSIONS[].model` fed **both** the transcript observer and the saved launch config, spelled
as the same alias in both places — so the one case this readout exists for could not be staged at
all, and the mock asserted a reality that does not exist (observer models are full ids, never
aliases). They are split now: full ids on the observed side, a `LAUNCH_MODEL` alias map on the
launch side. `t1` is the divergence its **own transcript already stages** — it carries
`/model sonnet` → "Set model to Sonnet 5" on a lane launched as `opus`. Nothing invented.
`AgentsHubView` is the only UI consumer of a session's model and it goes through
`modelFamilyLabel`, which takes full ids.

## Verification

`dev/drive-orb-meta.mjs` (new), all six palettes, expanded **and** collapsed:

```
[mission-control-dark]  expanded  [["model | Sonnet | running", " | Opus | at launch", "effort | High | at launch"]]
                        collapsed [["model | Sonnet | running", " | Opus | at launch", "effort | High | at launch"]]
   … identical for mission-control-light, mr-pink-dark, mr-pink-light, 1984-dark, 1984-light
```

Dismissal, both states, every palette: `after moving away: []`, `after leaving the window: []` —
the second dispatched as a real `mouseout` with a null `relatedTarget`, which is what a cursor
crossing the window frame produces (moving the mouse to an edge never leaves the document).

`drive-rail-invariant` was run **before and after** on the same fixture: byte-identical output,
same 5 pre-existing failures with the same numbers (accent-collision fixture, foot glyph spread,
rhythm — none of them mine). No layout moved; the card is `position: fixed` and takes no flow.

| gate | result |
|---|---|
| `npx vitest run` | **1042 pass / 33 fail** vs. the `operator/101200` baseline of 1026/33 — +16 new tests, the same 5 pre-existing jsdom/localStorage files failing |
| `npx tsc --noEmit` | clean |
| `npm run build` | clean |

New tests: `lane-meta.test.ts` (11 — the provenance rules, including "an alias and its own full id
are not a divergence" and "effort is never sourced `running`") and `use-hover-card.test.ts` (5 —
every dismiss path, and the null-`relatedTarget` guard in both directions).

Nothing cost- or pricing-related was touched.

## Not done

- Not GUI-verified in a real window — the harness drives WebKit against the mock bridge, which is
  where my env constraints end.
- The collapsed card's first line is `sessionLabel({ session })` with no role, so a named lane
  shows its summary rather than "Code". Pre-existing, untouched, and arguably worth a separate look.
- `RailOrb` still carries a native `title={label}` alongside its custom card. Pre-existing; removing
  it is a behaviour change on an element several drivers select, and it was not in scope.
