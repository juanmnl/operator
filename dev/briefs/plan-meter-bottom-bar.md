# Brief: plan meter → bottom bar, with the session's context (Design lane) — 2026-09-06

Juan (2026-09-06, screenshots /tmp/operator-shots/plan-meter-popover-2026-09-06.png and
rail-ring-fable-only-2026-09-06.png): "this needs to be improved, i think we can move it to the
bottom bar, and show the context of the session; also here it's showing only fable use."

Facts:
- `PlanMeter.tsx` (rail foot) draws ONE ring for the BINDING limit (`bindingLimit`: whichever of
  session / week / per-model is closest to stopping you — 66% Fable in the screenshot). The
  popover lists all three with reset times, from `lib/plan-limits.ts` / `usePlanLimits`. Juan
  read the ring as "only Fable", so the binding-limit idea is not landing; the popover is
  generic copy ("You are currently using your subscription…") and takes a lot of space.
- The bottom bar per session is `SessionInfoBar.tsx` (Review button, activity). Operator also
  has the rail foot row (Agents · plan meter · Tuning).
- Session context is available now: the tailer keeps `AgentSession.usage` (cumulative), the
  latest assistant record's `input + cache_read + cache_write` is the live context size, model
  window is 200k (1M for `[1m]` variants), and on branch operator/e78fc0 the tailers also carry
  `effort` and `compactions` per session.

Design (mock + result, no implementation): `dev/results/plan-meter-bottom-bar.md` and
`dev/plan-bar-preview.html` (light + dark, app CSS vars, the style rules: transparent badges, no
solid accent fills, no focus rings, no stacked opacity on --fg-muted, no stray word after a stop).
1. A bottom bar reading for the ACTIVE session: context used of window (e.g. `ctx 84k / 200k`,
   with the compaction count when > 0), the lane's model · effort, and the plan reading. Decide
   what stays in the rail foot (probably nothing, or the ring only) so the number lives once.
2. The plan reading must show session, week and the model cap at a glance, not one ring: three
   small bars or three figures, the binding one marked, reset time on hover or beside the
   binding one. Cut the subscription sentence. "no data" never renders as 0%.
3. Amber past 75, red past 90, as the landing says; the same TONE_FILL thresholds.
4. State the click target: the reading opens the Tuning page (from the Tuning-page design,
   "What's driving this").
Call `mcp__operator__report` when done.
