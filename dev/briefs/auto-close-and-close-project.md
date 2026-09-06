# Brief: two things that exist in code and do not happen in use (Research lane) — 2026-09-06

Juan (2026-09-06): "we are still missing the auto close for agents that have done their work and
reported back, and being able to close a project in the sidenav even when there are multiple
sessions open." Both are implemented on paper. Find why neither works for him. Report only.

A. Auto-close. Policy: `src/renderer/lib/lane-lifecycle.ts` (`laneCloseDecision`, `planLaneCloses`,
   keep-warm window from PrefsView, `0` disables). Driver: the lane-close effect in
   `DashboardView.tsx` (grep `planLaneCloses(`). The decision needs `reportedDoneAt` (set from
   `operator__task_status(id,'done')` rows — `~/.operator/artifacts.db` table `task_status`),
   `openWork === 0`, phase `idle`, not focused, not a coordinator role.
   Determine, with evidence from this machine (artifacts.db, sessions.json, the lane transcripts),
   which guard blocks in practice: is `reportedDoneAt` ever populated (do `task_status` rows get
   `applied`? are they scoped to the right project post-0.19.0?); is `openWork` stuck > 0 because
   tasks never leave `running`; is the keep-warm default 0; is the effect even mounted; does
   `focused` block because the user has the lane open. Then the same for lanes that call
   `mcp__operator__report` but never `task_status` — Juan's phrase is "reported back", so decide
   whether a `report` alone should count as done for the close policy and say what that would
   cost (the went-quiet backstop exists; what is its value?).
B. Close project from the rail with several sessions open. `DashboardView.tsx:1079 closeProject`
   + the rail context menu (~L4120, confirm when live > 0, 4s per-lane timeout). Reproduce with
   3+ sessions through the dev/qa-real bridge (drive-close-project.mjs exists). Find what fails:
   the confirm never firing, `handleCloseSession` timing out at 4s for worktree lanes (git
   worktree remove is slow), `stuck` lanes keeping the project on the rail, the closing chip
   never clearing, or the menu item not reachable (right-click only; memory
   project_close_project_affordance says a ⋯ was designed and not shipped). Include file:line
   and the exact sequence Juan would see.
Write `dev/results/auto-close-and-close-project.md` with a recommended fix set per item, sized;
call `mcp__operator__report`. No code changes.
