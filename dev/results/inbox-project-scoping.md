# Inbox project scoping — two bugs, one symptom

Branch `operator/a3a4c0`. Reports #313 / #316 / #318 / #319 arrived at an `operator`-project
coordinator stamped `project_id=uwazi-app-d9bb8dcc`, and #313/#316's text is a review of
`operator/51cf00`. That is two independent defects that happen to land on the same row.

---

## Bug 1 — the queue was never scoped to a project

`~/.operator/artifacts.db` is ONE store for every project on this machine (10 projects, 318 rows
at the time of writing). `ArtifactStore.undeliveredFor` selected `project_id` and filtered on
`to_role` alone:

```sql
WHERE delivered_at IS NULL AND (to_role = ? OR to_role IS NULL)
```

Every one of those 318 rows has `to_role IS NULL` — nothing has ever written that column — so the
predicate is vacuously true and the queue was fully global. The announce pass in
`DashboardView` then walks `terminals`, takes the first idle lane whose role is a coordinator,
and drains that global queue into it. Whichever project happened to be open and idle first got
every project's reports.

And `markReportDelivered` stamps `delivered_at` exclusively, so this is not a duplicate — it is a
**steal**: the wrong coordinator's announcement closes the row, and the real owner is never told.

The same bleed ran through the read side. `artifactReports(200)` is a global fetch and both
consumers used it raw:

- `InboxPanel` listed other projects' reports.
- `unreadByRole` keys by role id, and role ids repeat across projects — every project has an
  `operator` and a `code` — so two projects' lanes merged into one badge count.

### Fix

- `undeliveredFor(role, limit, projectId?)` adds `AND (project_id = ? OR project_id IS NULL)`.
  A row with **no** project still passes every scope: it is unattributable, not foreign, and a row
  that belongs to no queue is a row nobody is ever told about — the exact silence this plane
  exists to remove. Omitting `projectId` keeps the old unscoped behaviour so a bridge that cannot
  supply one degrades rather than returning nothing.
- `artifactUndelivered(role, limit, projectId)` through `ipc.ts`; the announce pass passes
  `tab.projectId` — the RECEIVING session's project, not the report's.
- `forProject(reports, projectId)` in `lib/inbox.ts`, pure and tested, applied to the `InboxPanel`
  list and to `unreadByRole`. The fetch stays global (one poll, one global store); the scope is
  applied where the receiving lane is known.

**Residual, deliberate**: a `project_id IS NULL` row is still announceable to any coordinator, and
`delivered_at` being a single scalar means the first to drain still takes it. That is the same
trade as above — shown to the wrong coordinator beats shown to nobody — and it only affects rows
that could not name their project, which after Bug 2 is fixed should be none.

---

## Bug 2 — `OPERATOR_TERMINAL_ID` is not unique, so the stamp itself was wrong

This is why #313/#316 say `uwazi-app` while their text is an `operator` review.

`mcp-serve.ts`'s `resolveCaller` had exactly one fact about its caller — `OPERATOR_TERMINAL_ID` —
and resolved the project and role by looking it up in `sessions.json`:

```ts
const hit = list.find((s) => s?.terminalId === terminalId)
```

Terminal ids are minted **per app run** and restart at `t0` every launch. `sessions.json` is
durable across runs and across projects. So one id matches many rows. The live snapshot has `t2`
four times:

```
t2 | uwazi-app-d9bb8dcc  | operator
t2 | el-encanto-799f5efe | operator
t2 | operator-3cfdffb0   | review
t2 | operator-3cfdffb0   | research
```

`find` takes the first. Every report the operator project's **Review** lane filed as `t2` was
written to the store as `project_id=uwazi-app-d9bb8dcc, role_id=operator` — wrong project AND
wrong role. Confirmed in the data: #313 and #316 are reviews of `operator/51cf00` filed by `t2`,
both stamped `uwazi-app-d9bb8dcc` / `operator`.

Note the interaction: **Bug 1's fix makes Bug 2 worse if shipped alone.** Once the queue is scoped,
a mis-stamped report is no longer merely mislabeled — it is routed to a coordinator who has never
seen that repo, and invisible to the one who needs it. The two had to land together.

### Fix — the environment is the authority

`terminals.ts` knows both facts at spawn, so it states them instead of having them guessed:

- `SpawnOptions` gains `projectId` / `roleId`; `buildCommand` exports `OPERATOR_PROJECT_ID` and
  `OPERATOR_ROLE_ID` into the lane's env (and `stripNestedSessionEnv` deletes both, so a nested
  session cannot inherit its parent's identity).
- `ipc.ts terminalSpawn` passes them down — `projectId` was already riding in `launchOptions` for
  the tailer; `roleId` is added at both renderer launch paths (fresh launch and restore).
- `resolveCaller` reads the env first and returns immediately when both are present. The
  `sessions.json` lookup stays for a lane spawned by an OLDER build that is still running, and is
  now **narrowed** by whichever variable the environment did supply.

---

## The four already-stolen rows — NOT rewritten, and why

Operator asked for these to be redelivered rather than just filtered. Clearing `delivered_at` on
them today would be wrong, because their `project_id` is wrong:

| id | stamped | actual content | delivered | acked |
|----|---------|----------------|-----------|-------|
| 313 | uwazi-app-d9bb8dcc | review of `operator/51cf00` @ `ceb8b90` | yes | no |
| 316 | uwazi-app-d9bb8dcc | re-review of `operator/51cf00` @ `ffe7d09` | yes | no |
| 318 | uwazi-app-d9bb8dcc | Contífico → mantel migration research | yes | yes |
| 319 | uwazi-app-d9bb8dcc | accountant-facing import routes audit | yes | no |

With scoping now in place, clearing delivery alone would announce all four to a **uwazi-app**
coordinator — the one project none of them is about. Redelivery has to fix the stamp first, and
the only evidence of the true owner is the prose. #313/#316 are unambiguously `operator-3cfdffb0`
(they name the branch). #318/#319 are mantel work, and this machine has two mantel projects
(`mantel-58143479`, `mantel-sincopa-7c340003`) — I cannot tell which, and guessing would put a
wrong stamp back in a table whose wrong stamps are the bug.

So the repair is left as an explicit, approvable statement rather than run silently against the
user's live store:

```sql
-- #313 / #316: re-attribute to the project and role that actually filed them, and reopen
-- them for announcement. Neither has been acked, so nothing is being un-read.
UPDATE reports SET project_id = 'operator-3cfdffb0', role_id = 'review', delivered_at = NULL
 WHERE id IN (313, 316);
-- #318 / #319: same shape, once a human says which mantel project they belong to.
-- UPDATE reports SET project_id = '<mantel-…>', delivered_at = NULL WHERE id IN (318, 319);
```

Say the word and I'll run the first statement.

---

## Diff summary

| File | Change |
|------|--------|
| `electron/src/main/chat-store.ts` | `undeliveredFor` takes an optional `projectId` and scopes the query; null-project rows still pass |
| `electron/src/main/ipc.ts` | `artifactUndelivered` forwards `projectId`; `terminalSpawn` passes `projectId`/`roleId` into the lane |
| `electron/src/main/terminals.ts` | `SpawnOptions.projectId`/`roleId`; exports `OPERATOR_PROJECT_ID`/`OPERATOR_ROLE_ID`; strips both from an inherited env |
| `electron/src/main/mcp-serve.ts` | `resolveCaller` reads the env first; `sessions.json` becomes a narrowed fallback |
| `src/renderer/lib/inbox.ts` | new pure `forProject` |
| `src/renderer/views/DashboardView.tsx` | announce pass scoped by `tab.projectId`; `InboxPanel` list and `unreadByRole` scoped by the active lane's project |
| `src/renderer/env.d.ts` | `artifactUndelivered` signature |
| `electron/src/main/chat-store.test.ts` | +1 test: the queue is scoped and keeps unattributable rows |
| `src/renderer/lib/inbox.test.ts` | +4 tests for `forProject`, including the badge count |

`tsc --noEmit` clean. `electron` suite 378/378. Root suite: the 33 failures are pre-existing —
`localStorage` is undefined in several suites and they fail identically on the main checkout.

**Not verified in a real window.** This is a data-routing change with no visual surface; the
behaviour to watch is that a coordinator stops being announced other projects' reports.
