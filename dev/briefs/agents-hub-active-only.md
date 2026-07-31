# Brief — the Agents hub is for ACTIVE agents

User: **"agents button should be just for active agents."**

The rail's robot button opens `AgentsHubView`. Its Fleet tab currently shows every lane across
every project — live ones and idle ones. Make it about **what is running right now**.

## Why this is the right shape, and what it settles

The original complaint about this view was "2 live agents buried under 76 idle lanes". The
character-card pass made the idle cards *better*; the user is now saying they don't belong here at
all. That's a cleaner answer, and it gives the app a real division of labour:

- **A project's roster board and its sidebar** — the team you *have*. Idle lanes live there,
  where you launch them.
- **The Agents hub** — the fleet that is *working*, across every project. It is the one
  cross-project surface (that's why it lives at the rail's foot, present in every state), and its
  job is "what is happening right now, everywhere".

Two renderings of the same idle list, 40px apart, is the duplication the rail/sidebar split
already exists to avoid. This removes it.

## What to do

- Fleet shows **active agents only**. Use the same definition the view already computes for
  "in play" — a launched, non-ended session — rather than inventing a second notion of active.
- **Rollup chips**: `N in play` stays meaningful; `teams` probably does; drop or rework anything
  that counted idle lanes. Whatever survives must count comparable things.
- **A project with nothing running does not appear.** Don't render an empty group per project.
- **The empty state matters more than it used to** — with nothing running anywhere, this view is
  empty, and that is now its normal resting state rather than an edge case. It should say what it
  is and point at where lanes are launched, without becoming a second roster board.
- **Queued work is the one exception worth arguing about.** An idle lane holding queued tasks is
  arguably "active" — something is waiting on it. You already surface `3 tasks waiting`. Decide
  whether a queued-but-not-running lane belongs here and say why; I lean yes, because it is the
  most actionable thing this view can show, and "nothing is running but four lanes are backed up"
  is exactly the state a fleet view should surface.
- **The rail button's tooltip** says "every agent across your projects". That stops being true —
  update it.

Do **not** delete the character-card work. The card anatomy stays; this changes *which* cards the
view contains, and possibly lets the card lean harder into live state now that it never has to
represent a bench.

## Constraints

- Don't change the roster board or the sidebar. Idle lanes stay visible there — this is about one
  surface, not about hiding lanes generally.
- Keep the shape vocabulary (agent = circle, project = rounded square) and the motion rule (only
  running/compacting animate — which, if this view is active-only, means most orbs now move; check
  that a screen of animating orbs doesn't read as noise, and say what you did about it).
- Transparent badges, no solid accent fills, `laneTextColor` for names, no stacked opacity.

## Verify

- With several agents running, with exactly one, and with **none** — the last is the important one.
- Confirm the roster board and sidebar are unchanged.
- `node dev/drive-theme-pass.mjs`; `npm test`; `npm run build` clean.

## Where to work

`main` is at `573deaa`. Commit in your own worktree; I'll merge forward. Do not touch
`/tmp/claude-501/merge-main`.

## Output

`dev/briefs/agents-hub-active-only-RESULT.md`: what counts as active, your call on queued lanes,
the empty state, what the chips became, and the animating-orbs question. Then one OPERATOR-REPLY line.
