# Brief: the usage view, re-aimed at tuning (Design lane) — 2026-09-05

Juan (2026-09-05): "we do need to bring back context, cost, usage per model, but some way we can
actually analyse to improve usage." The old Usage & cost view was deleted. The backend still
computes everything (`getUsageStats`/`getUsageInsights`, `src/shared/types.ts` ~L748-800:
byModel / byProject / byDay with tokens, cost, messages, apiMs, wallMs) and nothing reads it.
Landing framing (`~/Developer/Operator-landing/index.html`, cells 06-08): tune model + effort per
lane so the plan runs close to its limit and never past it. Audit with the data inventory:
`dev/results/simplify-audit.md` parts 4-5.

Design the view, do not implement it. Deliver `dev/results/usage-view-design.md` plus a static
mock (`dev/usage-preview.html`, same approach as dev/board-preview.html) that reads in light and
dark with the app's CSS vars. Follow feedback rules: transparent badges, no solid accent fills,
no focus rings, never stack opacity on --fg-muted, no stray single word after a full stop.

Questions the view must answer, in this order of importance:
1. Which lane (role × model × effort) spends the most, per day / 7 days / 30 days, and what one
   change would reduce it (move to cheaper model, drop effort a step)? Effort is NOT captured
   today (the tailer drops the transcript's `effort` field) — design for it being added.
2. Which project dominates the current session/week window, in the plan meter's own units where
   possible (session %, week %, per-model cap). Where a plan-fraction mapping does not exist yet,
   show tokens and say so; never show a dollar figure as the primary number ("tokens, never
   dollars" on the landing; cost may appear as a secondary readout, Juan said "cost").
3. Context pressure: compaction count per lane and share of turns above 150k context
   (`high_context_pct` exists), because a lane that compacts every few turns is mis-tuned.
4. tool_result bloat per lane (output_chars is persisted per turn in chat.db).
5. Cache efficiency per model (cache read vs. input).

Constraints: one PageShell page (see project_settings_page_template — reuse `PageShell`), entered
from the ⌘K palette and the rail foot; no dashboard sprawl; every number must lead to a knob the
app already has (roster model/effort picker) or say what to change by hand. State which slices
need new capture (effort, compaction) so Code can sequence backend work.
