# Brief — hovering an agent's orb shows its model and effort

User's words: *"i want the hover on the agent blob to show the model and effort."*
The "blob" is the `StatusWave` orb — `src/renderer/components/sidebar/SessionItem.tsx:175`,
inside its own 24px box at `:169`.

## BASE BRANCH — read this first

Branch from **`operator/101200`**, NOT `main`. That branch is verified green but unmerged, and it
already rewrote the effort ladder and `SessionItem`'s effort badge. Building on `main` means a
guaranteed conflict and a second copy of a set that was just de-duplicated.

```
git worktree add <your-worktree> -b design/<name> operator/101200
```
From that base you get `src/renderer/lib/effort.ts` — use `effortCode()` (L/M/H/XH/MAX) and
`EFFORT_OPTIONS` labels from it. Do not re-spell the ladder; that duplication was the last bug.

## Why this is worth doing

The orb has **no hover affordance whatsoever** right now. Two states, both bad:

- **Collapsed rail** — the orb (carrying the lane initial) is essentially all you see. Model and
  effort are unreachable without expanding.
- **Expanded row** — effort appears only as a tiny badge that renders *only when effort is not
  `high`* (`SessionItem.tsx:293`, deliberate: an "H" on every row was noise). Model is not shown
  **anywhere on the row, in either state**. So "what is this lane actually running?" currently has
  no answer short of opening the roster.

## What to build

Hover the orb → surface the lane's **model** and **effort**.

Content, in order of what the user is actually asking:
- **Model** — family label via `modelFamilyLabel()` (`src/renderer/lib/roster.ts:15`); it takes an
  alias *or* a full transcript id and returns "Opus"/"Sonnet"/"Fable"/"Haiku".
- **Effort** — the level's label from `EFFORT_OPTIONS`.

### The one nuance that must not be fudged

`session.model` is the **actually running** model, backfilled from the transcript, and it can
differ from the configured alias — a lane launched on the account default, or a `/model` typed in
the terminal, both show up there and nowhere else. That divergence is the single most useful thing
this hover can tell someone, so:

- Prefer `session.model` when present. That is ground truth.
- Fall back to the configured alias when it is absent (no assistant turn yet) — and do not present
  a guess as an observation. A resolved-vs-configured distinction the user can see beats a
  confident wrong label. `RosterPanel.tsx:662` already states this principle for the roster: *"a
  lane reading 'Fable' while it launches Opus is worse than no readout"* — same rule here.
- **Effort has no transcript ground truth at all.** We only know what we launched with. Do not
  render it in a way that implies it was observed.

## Hazards

1. **Hover cards in this app stick.** See `project_hover_card_stuck`: the existing hardening
   covers the cursor *moving*, not the cursor *leaving the window*, and the sidebar rail has none
   of it. If you build a custom card rather than a native `title`, it must clear on `mouseleave`,
   on the pointer leaving the window, and on the row unmounting (lanes close). A stuck card over
   the rail is worse than no hover.
2. **A native `title` is a legitimate answer.** It never sticks, costs nothing, and every other
   tooltip on this row already uses it (`:246`, `:264`, `:296`, `:316`, `:324`). Its costs are a
   ~1s delay, no styling, and OS-rendered chrome that sits outside the app's aesthetic. **Your
   call** — you own UI quality here. If you go custom, justify it in the result file against the
   sticking risk; if you go native, say why the delay is acceptable on this target.
3. **Don't fight the existing effort badge.** It already flags non-default efforts on the expanded
   row. The hover should complete the picture, not duplicate it into noise.
4. **24px is a small hover target.** Whether the trigger is the orb alone or the orb's row is a
   real decision — the user said "the blob", so the orb is the default reading, but if you widen
   it, say so and why.

## House style (non-negotiable, from standing feedback)

- Transparent badge tints, semantic CSS vars only, no hardcoded colors, no solid accent fills,
  no focus rings.
- **Never stack opacity on `--fg-muted`** — the token *is* the recede; stacking gives 1.8–2.9:1
  contrast. This has bitten before.
- No single word orphaned at the end of a text block.

## Definition of done

- Works in **both** rail states — collapsed and expanded.
- `npx vitest run` shows no new failures against the `operator/101200` baseline
  (**1026 pass / 33 fail**, 5 pre-existing jsdom/localStorage files — I measured this myself, it is
  not a guess). `npx tsc --noEmit` clean. `npm run build` clean.
- If you build a custom card: a test for the dismiss paths, including pointer-leaves-window.
- Nothing cost/pricing related touched.

## Output

Write your result to the ABSOLUTE path
`/Users/juanmnl/Developer/operator/dev/results/orb-hover-model-effort.md`
(absolute on purpose — a relative `dev/` path is invisible from your worktree). Cover: the
native-vs-custom decision and its reasoning, how configured-vs-running model is distinguished
on screen, both rail states, and test/typecheck/build numbers. Then call `mcp__operator__report`.
