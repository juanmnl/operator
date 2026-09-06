# Brief: last fixes before merge + auto-close + close from the rail (Code lane) — 2026-09-06

Branch `operator/e78fc0` at `50b448e`. Inputs: `dev/results/review-2-simplify-batch.md` (verdict:
fix A and B then merge), `dev/results/qa-2-simplify-batch.md`, and
`dev/results/auto-close-and-close-project.md` (Research). Decisions made; do not re-litigate.

## Review-2 blockers
A. `SessionToolbar.tsx:116` `tunable = live && phase === 'idle'` — no tracked lane ever has phase
   `idle` (the tailers emit only running|compacting|waiting). Enable on `waiting` too, same test
   `comms.ts:227` uses. If either tailer can tell a permission prompt apart from an ordinary
   "your turn" (an unresolved tool_use awaiting approval), disable during that; if it cannot,
   say so in the result and leave the CR risk documented in the chip's tooltip-less code comment.
   Fix the fixture: `dev/qa-real-bridge.ts:34,47,51` hardcodes `phase:'idle'` — fixtures must
   match reality; use `waiting`, and make `drive-tuning-chips.mjs` fail on the old build.
B. `tuning.ts:130-134` "latest session wins" must sort by `lastTsMs`, not tokens.

## Review-2 residuals, also in
- #1: `provesOwnServer`'s deep-process gate must require the process to match `DEV_SERVER_RE`
  (one shared definition; delete the duplicate in port-alloc.ts:200; drop `\bserve\b` or exclude
  `--mcp-serve` explicitly, not by test ordering).
- #11: `retryScanWithoutV6` applies the lease check and returns the `shared` flag like `scan`;
  v6 failure count is per scan.
- C: the cwd-only join attributes the role from the session's roleId; the Not attributed row is
  labelled "Not attributed", never a project name.
- D: `getTuning` uses one window for both computeTuning and toolOutputStats.
- E: if `AgentSession.effort/.compactions` are read by nothing after B, wire them into the
  toolbar chip (effort shows the live value, with the launch pin as fallback) or drop them.

## Auto-close (Research part A)
`reportedDoneAt` is fed only by `task_status` rows; over a month lanes called `report` 643 times
and `task_status` 5 times. Decision: a `report` counts as done for the close policy. Feed
`doneReportsRef` from `reports` rows (scoped to the lane's terminal/session) as well as
`task_status`; keep the went-quiet backstop. Lanes with open tasks still do not close. Test the
decision with a report-only lane.

## Close from the rail (Research part B)
The mechanics work; the UX does not. Ship both:
1. `ProjectRail.tsx`: a `closing` state on the tile mirroring the gallery card's chip, set the
   moment the confirm fires.
2. The `⋯` project-actions trigger on the group header row at both rail widths, per the design in
   memory `project_close_project_affordance` (hover/focus-revealed, absolutely positioned, zero
   layout space at rest; hover state and the hoverCard ref move to the ROW wrapper;
   `data-popmenu-trigger` + `aria-expanded`), opening the existing menu.
3. `CardMenu.tsx:104-134`: key the armed confirm on the item's action identity, not its label.
4. Retire `dev/drive-close-project.mjs` or rewrite it against the rail menu.

Done: all suites (incl. cargo) + tsc + both builds; `dev/results/pass-3-and-close-features.md`;
call `mcp__operator__report`. Commit on operator/e78fc0 with explicit paths; do not merge.
