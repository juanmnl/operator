# Report #2379 routing: no cross-project leak found (2026-10-14)

Question: report #2379 (project `web27-f6798fe1`, role `design`, terminal `t89`, `to_role` `operator`) was said to have been announced to the operator project's coordinator. Which code path matched it, does that path filter by project, and how many reports reached another project's coordinator? Research only; no code changed.

## Answer in four lines

- **#2379 was not announced to the operator project's coordinator.** It was announced to **t13**, which is the **web27** project's coordinator (role `operator`, project `web27-f6798fe1`, Claude session `59ae5610…`, bus name `web27-dc69--operator`). That is the correct recipient.
- **The announce path does filter by `project_id`**, in both the renderer call and the SQL.
- **Across every announcement the announce log still holds (2026-10-08 to now), 250 reports, 0 went to a coordinator of another project.** Nothing earlier than 2026-10-08 can be checked from logs.
- The operator coordinator (t94, session `23ebc533…`) learned the row existed by running `sqlite3 ~/.operator/artifacts.db "select … where id in (2379,2380)"` itself at 03:24:23Z, one minute after #2380 was announced to it. That query has no project filter. This looks like the origin of the impression.

## Evidence for where #2379 went

1. `~/.operator/logs/announce.log:3469`: `2026-10-15T03:23:55.303Z tab=t13 role=operator project=web27 stale=0 pending=1 outcome=announced=#2379`. The next lines for #2380 read `tab=t94 role=operator project=operator … announced=#2380`. #2370 to #2378 and #2380 all went to t94 (project `operator`), #2379 alone to t13.
2. `~/.operator/sessions.json`: t13 is `{roleId: operator, projectId: web27-f6798fe1, claudeSessionId: 59ae5610…, cwd: /Users/juanmnl/Developer/web27}`. t94 is `{roleId: operator, projectId: operator-3cfdffb0, claudeSessionId: 23ebc533…, cwd: /Users/juanmnl/Developer/operator}`.
3. `~/.claude/sessions/*.json`: session `59ae5610…` is named `web27-dc69--operator`; session `23ebc533…` (pid 46732, the sender of the request) is `operator-78f2--operator`.
4. Transcripts: the typed line `[Operator] report #2379 from design: Share card headline rewritten …` appears as a user turn at 03:24:54Z in `~/.claude/projects/-Users-juanmnl-Developer-web27/59ae5610….jsonl`. It does **not** appear as a typed turn in the operator coordinator's transcript (`-Users-juanmnl-Developer-operator/23ebc533….jsonl`); its first mention of 2379 there is the coordinator's own `sqlite3` call.
5. Also in the web27 coordinator's transcript at 03:24:02Z: `[Operator · reply from Design] Share card headline done … detail in report #2379`. That is the lane-reply path (`OPERATOR-REPLY`), also delivered into web27's coordinator.

## The matching path, with the project filter

| step | file | project filter |
|---|---|---|
| 1. Pick tabs | `src/renderer/lib/comms.ts:287` `coordinatorsToAnnounce` → `announceSkip` (`:262`) | None, and none needed: it selects tabs whose `roleId` is in `COORDINATOR_ROLE_IDS` and that are between turns. It returns one tab per coordinator, each carrying its own `projectId`. |
| 2. Serve one tab | `src/renderer/views/DashboardView.tsx:4472` `serveCoordinator(tab, role)` | Passes `tab.projectId` to both queries: `artifactStaleUndelivered(role, cutoff, tab.projectId)` and `artifactUndelivered(role, 3, tab.projectId)` (`:4491, :4503`). |
| 3. IPC | `electron/src/main/ipc.ts:217-227` | A missing project returns `[]` and logs once (`noteUnscopedAnnounce`). |
| 4. SQL | `electron/src/main/chat-store.ts:459-471` `undeliveredFor`, `:474-488` `staleUndeliveredFor` | `delivered_at IS NULL AND (to_role IN (…addresseesOf(role)) OR to_role IS NULL) AND (project_id = ? OR project_id IS NULL)`. |
| 5. Mark | `ipc.ts:221` `artifactMarkDelivered(id)` | By id only; runs after the line has been typed and confirmed. |

Why #2379 reached t13: `project_id = 'web27-f6798fe1'` equals t13's `projectId`; `to_role = 'operator'` matches the role of both coordinators, which is expected because every project's coordinator has role `operator`. `to_role` names a role, not a project. Only `project_id` separates projects, and it did.

## How many reports reached another project's coordinator

Method: parse every `announced=#…` and `summarised=#…` item in `~/.operator/logs/announce.log` (3,478 lines, first line 2026-10-08T16:39Z; the file is trimmed at 512 KB by `announce-log.ts`). For each id, read the row's `project_id` from `artifacts.db` and compare it with the `project=` field of the serving tab, taking project name or id as equal (`projects.json` maps id to name; no two projects share a name).

| | count |
|---|---|
| reports in `artifacts.db` | 2,379 (all have `delivered_at` set) |
| announce events in the log window | 250 (250 unique reports) |
| served to a tab of the report's own project | **250** |
| served to a tab of another project | **0** |
| delivered in the log window but absent from the log | 0 |
| delivered before the log window (no routing record) | 2,129 |

Limits of that count:

- Before 2026-10-08 the destination of a report is not recorded anywhere. `reports` stores `delivered_at` but not which tab received it, and the announce log only keeps about six days. The earlier leak that the code comments describe (#313, #316, #318, uwazi-app reports typed into an `operator` coordinator) predates the project scoping added on 2026-08-25 (`7f2bdd8`) and 2026-09-14 (`9abbda6`). I could not re-count it.
- Two rows have `project_id IS NULL` (#1 and #2, `probe-t1` and `code-lane-ac9328`, delivered 2026-08-25). The SQL lets NULL-project rows through to every coordinator by design (`chat-store.ts:446-449`). Both are 2026-08 smoke-test rows and were not in the log window, so I do not know which tab got them.
- Seven rows (#246, #260, #266, #274, #277, #281, #394, from 2026-08-19 to 2026-08-29) have `project_id = 'mantel-sincopa-7c340003'`, which is not in `projects.json`. They were delivered on 2026-08-25 and 2026-08-29. No coordinator for that project id exists now, so they could only have gone to a project whose id matches or to nobody; not verifiable.

## Why it looked like a leak, and what is actually weak

- The summary of #2379 names the branch `operator/7de040-og` and the worktree path `web27-7de040`; the `operator/` prefix is Operator's branch naming for every project, not the project name. `to_role` is `operator` for every project. Both read as "operator project" to anyone scanning the table.
- A coordinator that queries `artifacts.db` directly sees every project's rows. Nothing in the schema or the MCP tools stops that. This is a read, not a delivery.
- The announce line does not name the project (`[Operator] report #2379 from design: …`). A coordinator cannot tell from the typed line which project a report belongs to, and has to be right about its own tab's scope.

Weak points that exist independently of #2379, none demonstrated to have misrouted a report:

1. **No record of the destination.** There is no `delivered_to` column. After the log rotates, "which tab got report N" cannot be answered, which is why the pre-2026-10-08 count is unknown.
2. **NULL-project rows pass every filter** (`chat-store.ts:446`). Acceptable by the stated reasoning, but the stamp for a report is made from the reporting lane's own environment (`7f2bdd8`); a lane started without it files a NULL row that goes to whichever coordinator is idle first. Currently 2 such rows exist, none recent.
3. **`sessions.json` holds two live-looking entries for `terminalId: t13`** with the same `appPid: 77087`: an `el-encanto` design lane last active 2026-08-28 and the current web27 coordinator. Terminal ids restart at t0 each run (`ipc.ts` comment on `pendingReleases`). The announce pass looks up phase with `sessions.find(s => s.terminalId === tab.id)` on the in-memory list, not the file, so this did not matter for #2379, but any consumer that keys on `terminalId` alone from the file would pick the wrong row. I did not trace every consumer.

## Recommendation

No fix to the announce path is warranted by #2379; it behaved as designed. Small changes that would make the next report of this kind answerable in one query:

1. **Record the destination.** Add `delivered_to_terminal` and `delivered_to_project` (or just the tab's project id) to `reports`, written by `markReportDelivered` from the renderer call (`artifactMarkDelivered(id, tab.id, tab.projectId)`). Then "delivered to another project's coordinator" is a SQL query over all history and the count above is exact, not log-window-only. Smallest version: write the same fields into `announce.log` lines with the report's own `project_id` next to the tab's (`report=#2379 reportProject=web27-f6798fe1 tabProject=web27-f6798fe1`), which makes a mismatch visible on the line itself.
2. **Make the mismatch impossible to type.** In `serveCoordinator`, before `submitQueue.submit`, assert `report.projectId === tab.projectId` or `report.projectId == null`, and skip with a logged reason otherwise. The SQL already guarantees it; the assert protects against a future edit of the query or a stale `tab.projectId`.
3. **Name the project in the announce line** when more than one project has open tabs, e.g. `[Operator] report #2379 from design (web27): …`, so a coordinator and the person reading its transcript can see the scope without a lookup.
4. **Tell coordinators to filter by project when querying `artifacts.db` directly.** `where project_id = '<this project>'`. Nothing in the app enforces this; the operator coordinator's own `sqlite3` query is the likely source of the report that #2379 "reached" it.
5. **NULL-project rows:** log every announcement of a NULL-project row with `unattributed=true`, and consider writing them to the Comms log of the coordinator only after a human assigns them, since there are only 2 and none since 2026-08-25.

## Not verified

- The origin of the impression on the Operator side beyond its own transcript: I read only that coordinator's transcript and not the text the user may have been shown.
- Any announce before 2026-10-08.
- Whether other readers of `sessions.json` key on `terminalId` alone.
- Whether `OPERATOR-REPLY` (lane reply) routing has the same project scoping as report announcement. #2379's reply landed in the right session, but I did not read that code.
