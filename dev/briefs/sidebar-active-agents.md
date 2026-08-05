# Brief — the sidebar lists what's RUNNING, not the whole roster

User, for the second time: **"i still see all of the roster in the sidenav when opening a project."**

Screenshot: `AGENTS` listing Operator (running) plus Research · Code · Review · Design · QA, all
`IDLE`, with `1 active` underneath.

## Why this is a change of position, and mine to own

The first time this came up I treated it as a *data* problem — the seeded-roster prune — and
explicitly scoped the Agents-hub fix with *"don't change the roster board or the sidebar; idle
lanes stay visible there."* The prune then correctly **kept** these six, because in this project
every one has real history.

That reasoning was sound and it answered the wrong question. The user does not want fewer lanes on
the roster; they want the sidebar to be about **what is happening**. `Sidebar.tsx:16` states the
current intent — *"its list is the project's TEAM: every roster lane, live or idle"* — and that
intent is what is being rejected. Change it.

This also makes the app consistent with itself: the Agents hub is now active-only for exactly the
same reason.

## What to build

**The AGENTS list shows agents that are running.** Idle lanes stop occupying a row each.

The hard part is not hiding them — it is that **the sidebar is currently how you launch one.** An
idle row's click action is `onLaunchRole`. If idle rows go away, launching must not go away with
them. That is the thing to solve, not to drop.

Decide and argue:

- **Where launching lives now.** Candidates: the existing `+` beside `AGENTS` (already there, and
  already opens the roster); a single collapsed row (`+5 idle` / `Ready · 5`) that expands in
  place; or the roster board becoming the only launch surface. My lean is the collapsed row — it
  keeps one click to launch, keeps the team discoverable, and costs one line instead of five.
  But if the `+` is enough, that is simpler and I would take it.
- **What "running" means here.** Use the same definition the Agents hub settled on rather than
  inventing a second one. A lane with **queued tasks** is arguably active — something is waiting
  on it — and the hub already had to answer this. Match it.
- **The `1 active` line** at the bottom becomes redundant or becomes the summary. Say which.
- **Empty state**: a project with nothing running is now an empty AGENTS section, and after the
  prune most projects are exactly that. It must invite launching, not look broken. This is the
  common case, not an edge.

## Constraints

- **Do not remove the ability to launch a lane in one click** without saying so explicitly and
  justifying it. That is the regression to avoid.
- The roster board keeps showing the full team — that is its job, and it is where lanes are added
  and configured.
- Keep the lane accent, the StatusWave orb, the phase word, and `⌘1-9` shortcut indices for the
  rows that remain.
- Motion rule unchanged: only running/compacting animate.
- No colour-changing border on a radiused element; no browser focus rings; no stacked opacity.

## Verify

- A project with one running agent; with several; with **none**.
- Launching still works, in whatever form you chose, and still lands you in the session.
- `⌘1-9` still addresses the right sessions.
- `npm test`, `npm run build` clean; `node dev/drive-theme-pass.mjs`.

## Where to work

`main` is at `a794840`. Commit in your own worktree; I'll merge forward. Do not touch
`/tmp/claude-501/merge-main`.

## Output

`dev/briefs/sidebar-active-agents-RESULT.md`: what counts as active, where launching went and how
many clicks it costs now, what happened to `1 active`, the empty state, and anything you
deliberately kept. Then one OPERATOR-REPLY line.
