# Brief — the lane config chips aren't visible enough

Component: `src/renderer/components/session/RosterPanel.tsx` (the expanded `RoleCard`).
User verdict: **"config chips are not that visible."**

## What's on screen (user screenshot, Mission Control dark)

An expanded **Research** card:

```
⠿  ● Research                                          ˄   ✕
   Fable   Opus   Sonnet   Haiku                   ⌐ worktree
   High  [ Normal ]  Low                            [ Launch → ]
 ›  CHARTER
```

- **Model row**: `Fable Opus Haiku` dim, `Sonnet` bright/bold — **no chip, no tint, no box.**
- **Effort row**: `High Low` dim, `Normal` in a **tinted rounded pill** with accent-ish ink.
- `worktree` (dim, dashed box glyph) right-aligned on row 1; `Launch →` (accent-bordered
  button) right-aligned on row 2.

## The problems

1. **Two selector rows, two different "selected" languages.** The model row says *selected* with
   weight+brightness; the effort row says it with a tinted pill. Same control type, stacked
   directly on top of each other, disagreeing. Whatever the reason (I believe it's the
   `pinned` vs inherited origin distinction — `Segmented`'s `pinned` prop, `RosterPanel.tsx:768`),
   the user cannot read it, and the first thing they notice is that the rows don't match.
2. **The unselected options are too quiet to read as options.** `CONTROL_OFF` is
   `color-mix(in srgb, var(--fg) 72%, transparent)` (`RosterPanel.tsx:48`) — a *previous* pass
   already raised this off `--fg-muted` for exactly this reason, with a long comment explaining
   why (an unselected radio option is still an option; it's held to the 4.5:1 body bar, not the
   3:1 meta bar). It's still not landing. Re-measure and go further, or change the channel.
3. **Nothing says these rows are interactive.** No box, no separator, no segmented-control
   affordance at rest — four words in a row, one brighter. Compare `worktree` and `Launch →`
   on the same rows, which BOTH carry a visible container. The two most important spend dials
   in the app are the only controls on the card with no container at all.
4. **The pinned-vs-inherited distinction is invisible as a distinction.** If a pill means
   "pinned to this lane" and plain-bright means "inherited from the global default", that is
   genuinely useful information — but it currently reads as a rendering inconsistency, not a
   signal. It needs to be legible AS a signal or it should stop varying the selected treatment.

## AMENDED — the worktree control is in scope too

User, follow-up: **"the checkbox is funky."** That's the `worktree` chip on the same row as the
model options (`RosterPanel.tsx:730-759`), so it's part of this pass, not a separate one.

It encodes **three** states in a 9×9 box using border-STYLE as the channel:

| state | drawn as |
|---|---|
| pinned on | filled with the raw `accent`, `1px solid transparent` border |
| pinned off | transparent, `1px solid var(--fg-muted)` |
| inherited | `1px DASHED var(--fg-muted)`, filled `var(--fg-muted)` if the inherited value is on |

Why it reads as funky:

1. **A dashed vs solid 1px border on a 9px box is not a perceptible difference** at normal
   viewing distance — and it's carrying the entire pinned/inherited distinction.
2. **Inherited-on and pinned-on look like different things but mean the same thing** ("this lane
   will use a worktree"): one is accent-filled, the other grey-filled. The user has to decode
   two channels to answer one question.
3. **It reads as a checkbox but behaves as a tri-state cycle.** A checkbox has two states. Click
   semantics here are not discoverable from the drawing.
4. It repeats exactly the pinned/inherited problem the model and effort rows have (above), in a
   third dialect. **Three dialects for one concept on one card is the actual bug.**

So solve pinned-vs-inherited **once**, as one mechanism, across model + effort + worktree. That
is the through-line of this whole brief. If the answer is that inheritance shouldn't be a visual
state at all at this size — that it belongs in the tooltip or a per-card "inheriting defaults"
line — argue for that; it's a legitimate outcome.

Note: **the worktree default VALUES are changing under you.** Code is flipping the global default
to ON for operator + research (joining code + design; review + qa stay off) — see
`dev/briefs/worktree-default-on.md`. So the common case becomes *inherited-ON* for four of six
lanes. Design for that, not for today's mostly-inherited-off screenshot. Do not edit the values
yourself; Code owns `model-config.ts` and the migration.

## What I want back

Make the model + effort + worktree selectors read, at rest and at a glance, as **one control family** where
you can (a) see they're interactive, (b) read every option, and (c) see which one is chosen.
The pinned/inherited distinction must survive — but carried on a channel that doesn't fight the
selected/unselected channel.

Your call on form. Weigh at least: a true segmented control with a resting container; keeping
the flat row but giving the selected item one consistent tinted chip in both rows and moving
pinned/inherited to a separate marker (a dot, a hairline underline, the existing `ORIGIN_LABEL`
tooltip made visible); or a label + value pattern.

Check the same controls in their other homes so this doesn't become a third dialect:
`AgentDefaultsView.tsx`, `AgentLibraryView.tsx`, `ChatComposer.tsx` (which has its own
model list at `ChatComposer.tsx:34`) all render model/effort choices too.

## Constraints (house rules)

- Transparent badges. **No solid accent fills for state.** No browser focus rings.
- **Never a coloured left-border marker stripe.**
- **Never stack opacity on `--fg-muted`** — the token IS the recede. `CONTROL_OFF` exists
  precisely because of this; if you replace it, replace it with another token-level step, not
  an opacity.
- No colour-changing border on a radiused element (WKWebView freeze). If a selected chip gains
  a border, that border must be a constant colour, or use `box-shadow` instead — see how
  `ProjectTile` (`ProjectRail.tsx:235`) draws its "you are here" ring for the pattern.
- `laneTextColor(accent)`, never a raw accent, for accent-coloured text — raw accents measure
  1.07–1.22:1 at these sizes on the light palettes.
- All colours via CSS vars; no hardcoded colours in `src/renderer/`.

## Verify

- `npm run build` clean; `npm test` (there are `roster.test.ts` / `model-config.test.ts`).
- Eyeball on the dev server at **port 1433** (already live — do NOT start another). Check a
  card with a PINNED model and one INHERITING it, so both origin states are on screen.
- `node dev/drive-theme-pass.mjs` — all 6 palettes. **Quote the measured contrast for the
  unselected option ink before and after**; the previous pass documented 4.45:1 on Mr Pink light
  at 68% as the failing case, so that's your regression line.

## Output

Write `dev/briefs/roster-config-chips-visibility-RESULT.md`: the form you chose and the ones you
rejected, how pinned-vs-inherited is now carried, contrast before/after, and which other views
you brought into line (or deliberately didn't). Then one OPERATOR-REPLY line.
