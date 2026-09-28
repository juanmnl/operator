# Brief: lanes as profiles, steps 1-3 (dark: no second instance can exist yet)

Plan: /Users/juanmnl/Developer/operator/dev/results/lane-profiles-plan-2026-09-25.md, section 2, Steps 1, 2 and 3. Background: /Users/juanmnl/Developer/operator/dev/results/lane-instances-and-message-mixing-2026-09-25.md.

Base: a new branch from `main` @ 8d607ce (0.27.1) or later, in your own fresh worktree. No earlier branch for this work exists; start clean.

## What changed since the plan was written (2026-09-25) — re-check its line numbers

- Step 0 landed differently: bus names are `<project slug>--<role id>`, with `--<n>` reserved for instance n >= 2 (`src/renderer/lib/bus-name.ts`). Use that grammar, not the plan's `<project>-<role>-<n>`. `sessionName(project, role, n)` in step 1 must agree with bus-name.ts; reuse it rather than duplicating.
- 0.27.1 added retire-a-released-lane routing: `routeDispatch` has `retire`/`finishing` kinds, `markReleased`, reply-vs-dispatch kind, `retire-watch.ts`, `prompt-kind.ts`, and `worktree_release` cancellation (`chat-store.ts`). Steps 1-3 must not change any of that behaviour; step 4+ will fold it into the instance resolver later.
- `DashboardView.tsx`, `dispatch.ts`, `dispatch-bus.ts`, `chat-store.ts`, `mcp-serve.ts` line numbers in the plan are stale.

## Scope

- Step 1: `src/renderer/lib/lane-instance.ts`, pure, no callers, with its tests, as the plan specifies (`instanceLabel`, `instanceToken`, `sessionName`, `nextInstanceNumber`, `pickInstance`, `clampMax`, token grammar incl. `code-2` role id vs `code#2`).
- Step 2: stamp and persist `instance` on `SavedSession` and `TerminalTab`, the `OPERATOR_INSTANCE` env at spawn, `Role.instances?: { max, worktree }` type only. Every reader tolerates absence (reads as 1).
- Step 3: identity in the artifact store (`instance` / session columns via the tolerated ALTER loop) and the MCP caller (`resolveCaller` reads `OPERATOR_SESSION_ID`/`OPERATOR_INSTANCE`).
- Behaviour must be identical while every profile has max = 1. Do not start step 4.

## Done means

- Tests per the plan for each step; root and electron suites green, exact counts, typecheck clean.
- One commit per step on your branch.
- Result file `dev/results/lane-profiles-steps-1-3-2026-09-28.md` on the branch: branch, shas, deviations from the plan and why, what step 4 needs to know.
- Then `worktree_done`, then `mcp__operator__report`.
