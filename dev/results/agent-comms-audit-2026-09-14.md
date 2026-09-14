# Agent ↔ coordinator communication audit — 2026-09-14

Coordinator, with three read-only subagents. Covers 2026-09-07 to 09-14 across projects operator,
mantel, uwazi_app (and web27 where it showed up). Code references are against `main` = `2dcb9af`.
Nothing was changed. Key counts were re-run by the coordinator.

## Summary

Three defects account for almost everything the user saw:

1. **One brake counter for every project.** The 24-message limit is keyed by the bare role id, and
   15 projects name their coordinator `operator`. Today mantel (9 sends), uwazi_app (10) and operator
   (4) added up to 23; at 15:15:05Z operator's coordinator was refused, uwazi's at 15:26:04Z,
   mantel's at 15:31:31Z. 20 dispatches were refused after that. Typing to a coordinator does not
   reset it.
2. **Reports never expire and are announced oldest first.** Reports filed while no coordinator was
   idle waited up to 9 days, then were typed into today's coordinators one per idle turn. Genuine
   new reports queued behind them (operator #866 waited 31 min behind 36 old rows).
3. **Refusals are invisible to the user.** A refused bus dispatch produces no toast and no Comms
   log row; only the calling lane sees it.

## Evidence

### Dispatch outcomes, 2026-09-07..14 (`artifacts.db` `dispatch_requests`)

| project | send | launching | refused |
|---|---|---|---|
| mantel | 19 | 7 | 26 |
| uwazi_app | 18 | 11 | 18 |
| operator | 5 | 6 | 4 |
| web27 | 0 | 2 | 5 |

Refusal reasons: 24-send brake (mantel 8, uwazi 8, operator 4), chain-hop brake with pair keys
shared across projects (mantel 13, uwazi 10), expired after the app stopped answering (mantel 5).

All 26 `launching` dispatches did start their lane with the brief as the first user turn (1.2–2.8 s).
No lost launches this week. SendMessage failed 1 time in 575.

### Report backlog (`artifacts.db` `reports`)

| id | filed (UTC) | project | delivered_at |
|---|---|---|---|
| 621 | 09-05 19:16 | operator | 09-07 02:55 |
| 622 | 09-05 19:21 | operator | 09-11 21:02 |
| 623 | 09-05 19:37 | operator | 09-14 14:09 |
| 658 | 09-06 22:56 | operator | 09-14 14:45 |
| 835 | 09-11 17:37 | operator | 09-14 14:45 |
| 866 | 09-14 14:14 | operator | 09-14 14:45 |

Mantel #842–#863 (filed 09-12) were delivered 09-14 14:02–14:11; mantel's new coordinator treated
them as current and spent dispatches correcting lanes about work merged two days earlier, which
also counted toward the shared brake. `to_role` is NULL on every row.

No report or dispatch reached another project's coordinator.

## Defects, by priority

### P1 — brakes

| # | Defect | Where |
|---|---|---|
| B1 | `laneSends` and pair keys use the bare role id; every project's coordinator shares one budget, and one project's board Send → resets the others | `agent-delivery.ts:91,195,240,265`; `DashboardView.tsx:247,1636`; `dispatch-bus.ts:169` |
| B2 | Human input typed into a lane never resets its budget; only a board card's Send → / Start all (`DashboardView.tsx:2805,2844`) or an app restart does | same |
| B3 | Refused bus dispatches: no toast, no Comms log row | `DashboardView.tsx:1650-1715` |
| B4 | Refusal text "until you send it a task" does not name the board Send → | `agent-delivery.ts:201` |
| B5 | MCP `reply` is counted as a dispatch and creates a running board task (`kind` ignored) | `DashboardView.tsx:1616-1640` |
| B6 | "Running but not reachable on the session bus yet" refusals still consume budget | `dispatch-bus.ts:187-197` |
| B7 | Count increments on the verdict, not on confirmed SendMessage delivery | `agent-delivery.ts:240` |
| B8 | `OPERATOR-DISPATCH` sentinel is unbraked, and the MCP timeout text tells lanes to use it | `DashboardView.tsx:1741+`, `mcp-serve.ts:265` |

### P2 — report announcements

| # | Defect | Where |
|---|---|---|
| R1 | No expiry: `undeliveredFor` has no age limit | `chat-store.ts:426-435` |
| R2 | Oldest first (`ORDER BY id ASC LIMIT 3`), one line per idle turn | same; `DashboardView.tsx:3827-3884`, `comms.ts:235-242` |
| R3 | An unconfirmed announcement stops the pass without marking it (inferred: can stall a whole session, as #621/#622 did) | `DashboardView.tsx:3876` |
| R4 | One app-wide `announcingRef`; a submit that never resolves stops announcements for every project (inferred) | `DashboardView.tsx:3827,3881` |
| R5 | No link to the lane's direct SendMessage, so the same news arrives twice | — |
| R6 | `to_role` never written; null-project rows and tabs without `projectId` fall back to unscoped queries | `chat-store.ts:427`, `ipc.ts:183` |

### P2 — app stopped answering dispatches for 61 h (mantel)

5 `mcp__operator__dispatch` calls between 09-11 23:38Z and 09-13 00:34Z returned "Operator did not
answer in time"; rows were closed as expired at 09-14 12:59Z. `updater.log` shows a 0.21.0 app
running throughout, with `quitAndInstall(0.22.0)` at 22:35 and update checks every 3 h. Cause not
determined — needs its own investigation (candidates: renderer dispatch loop stalled after the
vetoed install, or the renderer respawn).

### P3

| # | Defect | Where |
|---|---|---|
| T1 | Bus dispatches truncated at 2000 chars although SendMessage has no pty hazard | `dispatch-bus.ts:205-207`, `agent-delivery.ts:143` |
| T2 | `mcp__operator__report` rejected 4–10 KB inputs as unparseable JSON (5 cases) | uwazi 09-08, mantel 09-12 transcripts |
| T3 | Terminal ids (`t2`) are reused across projects while `dispatch_requests`/`reports` are stamped by terminal id (risk, not observed) | — |

## Workaround until fixed

Restart Operator (the brake counters are in memory only), or press Send → on a board task assigned
to the coordinator. Either clears the brake for every project's coordinator at once.

## Re-check commands

```
sqlite3 -readonly ~/.operator/artifacts.db "select project_id,outcome,count(*) from dispatch_requests where at>='2026-09-07' group by 1,2;"
sqlite3 -readonly ~/.operator/artifacts.db "select project_id,count(*) from dispatch_requests where at>='2026-09-14T13:00' and at<'2026-09-14T15:15:05' and outcome='send' group by 1;"
sqlite3 -readonly ~/.operator/artifacts.db "select project_id,min(at),count(*) from dispatch_requests where at>='2026-09-14' and reason like '%has sent 24%' group by 1;"
sqlite3 -readonly ~/.operator/artifacts.db "select id,at,project_id,delivered_at from reports where id in (621,622,623,658,835,866);"
```
