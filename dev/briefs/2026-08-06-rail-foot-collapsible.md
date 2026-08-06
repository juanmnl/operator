# The rail foot should collapse — it costs too much vertical space

**User, 2026-08-06**, pointing at the icon strip at the bottom of the rail: "this is something that
could be collapsible to save real estate."

## What it is today

`RailFoot` in `src/renderer/components/sidebar/ProjectRail.tsx:1064` — **four rows of two**, each
pair fenced by a hairline, plus the version line under them:

| row | left | right |
|---|---|---|
| views across projects | **Agents** | **PlanMeter** (the usage ring) |
| navigation between projects | **All projects** (⌘⇧O) | **Open folder** (⌘N) |
| Claude file shortcuts | **.claude** (this project) | **~/.claude** (global) |
| app | **Preferences** | **Theme toggle** |

Note the existing `collapsed` prop is about the RAIL's width (labels shown or not) — the screenshot
is already in that state. This ask is the **vertical** cost: four rows, three hairlines, ~10px
padding and a version line, all of it permanently occupying the bottom of a strip whose scarce
resource is height, competing directly with the agent list above it.

## The design question — this is yours to answer, not mine

I am not specifying the mechanism. What I need decided, with reasons:

1. **What collapses to what.** The eight are not equals. Agents, All projects and Open folder are
   navigation you reach for constantly; `.claude` / `~/.claude` / Preferences are occasional; the
   theme toggle is rare-but-delightful; the usage ring is *ambient* — its value is being visible
   without being clicked, so folding it away may cost more than it saves. Decide which tier stays
   at rest and which folds, and say why.
2. **The affordance.** Whatever reveals the folded set must not collide with the sidebar's own
   collapse control (`SidebarToggle.tsx`) — house rule: two verbs never share a glyph. A chevron
   that means "collapse the sidebar" in one place and "unfold the foot" in another is exactly the
   confusion that rule exists to stop.
3. **Rest state.** Per house rule, a hover-only control must not reserve space at rest — if the
   affordance only appears on hover, the collapsed foot must actually be shorter, not merely look
   emptier.
4. **Whether the pairs survive.** The four hairline-fenced groups carry real meaning (across-
   projects / between-projects / Claude files / app). If collapsing flattens them, say what
   replaces the grouping.
5. **Persistence.** Collapsed/expanded must survive a restart, alongside the rail's existing state.
6. **Keyboard.** ⌘⇧O and ⌘N must keep working while the foot is collapsed — a folded control is
   still a live command.

## Constraints

- House UI rules: semantic CSS vars only, transparent/surface treatments, no solid accent fill, no
  browser focus ring, no coloured left-border stripe, never recede with a group `opacity`, never
  stack opacity on `--fg-muted`. Align INK, not boxes — the foot's existing comments are unusually
  precise about painted extents (12px of ink per glyph, 14/15 for sun/moon); do not undo that work.
- Do not touch `Toast.tsx` or the toast state in `DashboardView` — that is your other in-flight
  change; land this as a separate commit.
- Keep the version/update line reachable; an available update must remain discoverable when the
  foot is collapsed.
- Tests for the collapse state + persistence. `npm test` + `npx tsc --noEmit` + `npm run build`
  green, and **commit your work on your branch** — verify with `git log` that the commit exists and
  `git diff` renders as text before reporting.

## Output

`/Users/juanmnl/Developer/operator/dev/briefs/2026-08-06-rail-foot-collapsible-RESULT.md`
— that absolute path in the MAIN repo, not only your worktree — plus `operator__report`. Lead with
the tiering decision from step 1; that is the part I want to see even if the rest is mechanical.
Implement it, do not stop at a document.
