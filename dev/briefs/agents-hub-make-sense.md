# Brief — the Agents view is the TEAM ROSTER. Character cards.

> **SUPERSEDED / REWRITTEN 2026-07-30.** An earlier version of this file framed the task as
> "make the Fleet tab skimmable" — clamp the noise, collapse idle lanes, fix the `_` subtitle.
> The user has since given a direction, and it replaces that framing entirely. If you read the
> old version, discard it. The diagnosis below still holds; the prescription is new.

User: **"agents view should just show the team roster, imagine character cards."**

Component: `src/renderer/components/agents/AgentsHubView.tsx` (272 lines — read it whole).
Existing pieces: `ActiveCard` (`:217`), `PassiveCard` (`:241`), `RollupChip` (`:182`),
`SubHead` (`:194`), `Grid` (`:202`).

## The direction

Stop rendering an **inventory** and start rendering a **team**. The mental model is a character
select / party roster: each agent is a *character* with an identity, a class, and stats you can
read at a glance — not a row in a list of things that exist.

This is a real reframe, not a restyle. Consequences to think through:

- **A character card is identity-forward.** The lane's name, its accent, and its orb are the
  card — not a label attached to a status. We already have the vocabulary: `StatusWave` orbs
  carry the lane accent, `laneTextColor` keeps names legible on light palettes.
- **Stats belong on the card.** Model, effort, worktree posture, permission mode — the things
  currently buried in the roster board — are exactly "class and stats". They make a card worth
  looking at. Today's `PassiveCard` shows a name and an `_`.
- **A team has a fixed, small membership.** That is now literally true: Operator is the floor
  and lanes are added on demand (`dev/briefs/operator-is-the-floor.md`). A project's team is
  Operator plus whoever you recruited.

## What's wrong today — the diagnosis still stands

From the user's screenshot of the current Fleet tab:

1. **The numbers are inventory, not team.** `2 LIVE AGENTS · 76 IDLE LANES · 13 PROJECTS`. The 76
   is just `13 projects × ~6 seeded roles` — an artifact of seeding, not a fact about anyone's
   work. **It is about to change under you**: Code's prune removes never-launched stock lanes and
   the Operator floor keeps one per project. Design for the post-prune world, where a project has
   Operator plus a few deliberate teammates.
2. **97% of the pixels go to things that aren't happening.** Two live agents, 76 idle, all at
   identical weight in identical full-width cards.
3. **The `_` subtitle reads as missing data**, not as "nothing here yet".
4. **The same six names repeat 13 times** — the repetition carries no information and hides which
   projects actually differ.
5. **Three heading levels** (project → ACTIVE → IDLE LANES) for what is often one row and five
   identical ones; projects with nothing live skip ACTIVE entirely, so the rhythm breaks.

## What I want back

The Agents view as a **roster of characters**, where a card tells you who this agent is, what
it's built for, and whether it's in play. Skimmable because the cards are *distinct*, not because
the noise is clamped.

Yours to decide, but decide deliberately and say why:

- **What a card shows** at rest, and what it earns by being live. A live agent has a phase and a
  current task; an idle one has a loadout. Those are different cards, or one card in two states —
  argue which.
- **Whether the top-level grouping stays per-project.** A team roster per project is the honest
  read of "team", but this is the one cross-project surface in the app
  (`ProjectRail.tsx:53-56` explains why it lives at the rail's foot). Don't lose that.
- **What replaces the rollup chips.** Count comparable things, or count something actionable
  (lanes with queued tasks). `76 idle lanes` should not survive in its current form.
- **The `_`.** Kill it. If a lane has a queued task, that's the subtitle; if it has nothing, draw
  nothing.
- **Queued work.** Check whether a lane's queued-task count can surface here — an idle agent
  holding 3 queued tasks is the most actionable thing this view could show, and it's absent today.

**Do not chase a literal trading-card pastiche.** No fake rarity borders, no XP bars, no
skeuomorphic card frames. "Character card" is about *identity and stats being first-class*, not
about game furniture. This app's aesthetic is restrained; the cards should feel like a
well-designed party screen, not a CCG.

## Constraints (house rules — several are directly in tension with "cards", so read carefully)

- **Transparent badges. NO solid accent fills for state.** A character card tempts you toward a
  bold coloured header block — don't. Tint and hairline, the way `ProjectTile`
  (`ProjectRail.tsx:228-238`) does.
- **Never recede a card with group `opacity`** — it compounds, halves contrast, and can't be
  overridden per child. If idle cards recede, recede them by TOKEN. This rule exists *because* of
  a previous idle-RoleCard fade.
- **Never a coloured left-border marker stripe.**
- **No colour-CHANGING border on a radiused element** (WKWebView re-rasterizes → freeze). Use a
  `box-shadow` ring, as `ProjectTile:235` does for "you are here".
- Never stack opacity on `--fg-muted`. `laneTextColor(accent)`, never a raw accent, for names.
- **Motion rule:** only `running`/`compacting` animate. An idle roster must be completely still —
  a wall of animating orbs is exactly what this rule exists to prevent.
- **Shape vocabulary is load-bearing**: a session/agent is a CIRCLE, a project is a rounded
  SQUARE. A character card must not turn an agent into a square avatar.
- All colours via CSS vars; no hardcoded colours in `src/renderer/`.
- Reuse `PageShell` and the type tokens rather than inventing new page chrome.

## Verify

- `npm run build` clean; `npm test`.
- Eyeball on the dev server at **port 1433** (already live — do NOT start another).
- **Use a realistic fixture.** The last channel task found the driver seeded 20-char bodies
  against a real median of 520 — a fixture more generous than reality validates a design that
  can't work. Seed from the real store: mixed live/idle, a project with only Operator, a lane
  with queued tasks, and long lane names.
- `node dev/drive-theme-pass.mjs` — all 6 palettes.

## Output

`dev/briefs/agents-hub-make-sense-RESULT.md`: the card anatomy you chose and what you rejected,
how live vs idle differ, what replaced the rollup chips, how it behaves at one lane (Operator
only) and at a full team, and what you deliberately left alone. Then one OPERATOR-REPLY line.
