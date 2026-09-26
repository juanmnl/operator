# Cross-project messaging holes — fixes, 2026-09-25

Brief: Research's Part 1B in `dev/results/lane-instances-and-message-mixing-2026-09-25.md` (main checkout; code refs at 65ffdd2). Branch **`operator/d91080-xproject`**, cut from `operator/d91080` at `58c402a`, one commit per item. Not merged, not verified in the running app.

| # | Hole | Fix | Commit |
|---|---|---|---|
| X1 | The session bus is machine-wide, and sessions show there as `<cwd>-<2 hex>` with no project or role | Every lane launches with `--name <project-slug>-<role id>` on launch, restore and restart (`lib/bus-name.ts`). The launch note tells the coordinator and every lane the rule, see below. | 774200f (+ 1cf5a07, a typecheck fix to its test) |
| X2 | `laneKey` fell back to the bare role for a tab with no project | An unstamped tab is keyed `unscoped:<its id>/<role>`; the one caller that can pass such a tab passes its terminal id | 7012877 |
| X3 | The report queue and its expiry went unscoped with no project; `to_role` was never written | With no project: nothing announced, nothing expired, logged once per role. A lane's report is written with `to_role = operator` | 7a805f4 |
| X4 | The MCP caller fallback took the first `sessions.json` row with the terminal id, across projects | `callerFromSessions`: the terminal id must match AND be corroborated by the lane's Claude session id or its directory. A field the corroborated rows disagree on is left unstamped and logged. | 1563633 |
| X5 | The bus tick took the project from the request but the role from the tab reusing its terminal id | `dispatchSender`: project and role come from the request; the tab only fills a gap and only if it agrees. The same rule applies on the OPERATOR-REPLY path and the approval-delivery path. | 76feb3f |
| X6 | Routing trusted a tab's project label alone | `tabRunsIn`: the tab's cwd, or a worktree lane's source repo, must be inside the project's path. A tab with no directory keeps routing. | da11965 |

## X1 in detail

- **Flag verified** on the installed CLI: `claude --version` = 2.1.283; `claude --help` lists `-n, --name <name>  Set a display name for this session`.
- **Inferred, not observed:** that `--name` becomes the bus descriptor's `name`. Every live descriptor today has `nameSource: "derived"`. The installed binary's strings show name sources `user`, `derived`, `collision`, `auto` and others, which fits a given name being registered as the bus name. No `claude` was launched to check, because that would spend API usage.
- **Name:** `<project-slug>-<role id>`, for example `mantel-design` and `uwazi-app-design`.
  - The role id is used, not the display name, so renaming a lane does not rename its session.
  - The slug is the project name. A 4-hex hash of the project id is added only when another project's name gives the same slug.
  - A fan-out's extra sessions get `-2`, `-3`. That suffix is the room left for lane instances.
- **Note text** (to the coordinator and every lane, when launched with a project):

  > Sessions in this project are named `<prefix>-<role>` on Claude Code's session bus, which every project on this machine shares. Reach a lane of this project through `mcp__operator__dispatch` or OPERATOR-REPLY. Send with SendMessage only to an address Operator returned, or to a name from ListAgents that starts with `<prefix>-`, exactly as listed; never pick a session by a guessed prefix.

  The note grows by about 390 characters. The longest as launched is Infra, at 4143. A new guard measures the real launch shape (below 4300), with the reason recorded.
- **Takes effect** for lanes launched, restored or restarted after this lands. Running lanes keep their derived names.

## X3 in detail

- `undeliveredFor` and `expireUndelivered` return `[]` and `0` when the project is null or undefined.
- The IPC handlers log `[reports] a '<role>' tab with no project asked for the report queue…` once per role and process.
- A scoped query still includes `project_id IS NULL` rows, as before: an unattributable report is better shown to one coordinator than to none.
- The existing test that pinned "no project = the unscoped queue" was changed on purpose to assert the new rule.
- `to_role` is `operator` for a non-coordinator lane's report and null for the coordinator's own. The announce query already matches `to_role = role OR NULL`, so delivery does not change.
- `to_project` was not added: `project_id` already carries it.

## X4 in detail

- **Session id:** `CLAUDE_CODE_SESSION_ID` is read from the MCP server's environment. `claude` sets it for its children; Operator strips it as a nested-session marker (`stripNestedSessionEnv`). That it reaches MCP servers is inferred, not observed.
- **Directory:** `OPERATOR_LANE_CWD`, else `process.cwd()`. Either one corroborates a row.
- **Only for older lanes:** it applies only to a lane whose environment lacks `OPERATOR_PROJECT_ID`/`OPERATOR_ROLE_ID`, meaning one launched by an older build.

## Tests

| # | Tests |
|---|---|
| X1 | `bus-name.test.ts` (8): name shape, stability, `-2`, slug clash gets a hash; `--name` in args without swallowing the prompt; restart keeps the name; note content for coordinator and lane; launch-shape size guard; no bus text without a prefix |
| X2 | `agent-delivery.test.ts`: distinct keys for two unstamped tabs of one role; one's exhausted budget leaves the other free, and resetting one does not touch the other |
| X3 | `chat-store.test.ts`: no project gives no reports and zero expired, while each project still sees its own; `to_role` stays in the coordinator's queue and no other role's. `mcp-serve.test.ts`: a lane's report is written with `to_role = operator`, the coordinator's with none |
| X4 | `mcp-serve.test.ts` (5), with `t2` under three projects: picks the right row by session id, or by directory; stamps nothing without corroboration; leaves a disagreed field null with `ambiguous`; keeps and narrows by the env's own values |
| X5 | `dispatch-bus.test.ts` (3): a stale request whose id now belongs to another project's lane keeps its own project and role; the role is never borrowed from another project's tab; a gap is filled only from an agreeing tab |
| X6 | `dispatch.test.ts` (4): a mislabelled tab is not picked and routing queues; main-checkout and worktree lanes of the project are picked; a sibling path with a shared prefix is not inside; a tab with no directory is allowed |

## Verification

- Root: `tsc --noEmit` exit 0; vitest 104 files, **1553 passed**.
- `electron`: typecheck exit 0; vitest 42 files, **770 passed**.
- Not verified in the running app: nothing was launched, so no lane has been seen on the bus under its new name.

## Not done

- **Logging a SendMessage whose target belongs to another project** (Research's recommendation 5, second half). `DeliveryEvent` is parsed, but mapping a bus target to a project needs the name scheme above to be live first. Recommended as a follow-up.
- **X7** (a dedupe store shared across projects), **X8** (global role defaults) and **X9** (the coordinator known by role id). Research rated them non-mixing or informational, and they were not in this brief.
