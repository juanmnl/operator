# Plan tab as the coordinator's task list (2026-09-16)

Commit `b85a0fc` on `operator/230fc0` (worktree `~/.operator/worktrees/operator-230fc0`).
Not GUI-verified.

## What changed

### 1. Dispatched tasks in the coordinator's Plan tab

- `src/renderer/lib/plan-dispatches.ts` (new): `dispatchedTasks(projects, projectId, reports)`.
  Reads `project.tasks`, the existing board store. No new store. Returns tasks with
  `source === 'mcp-dispatch'` as rows: lane name (from the roster, falling back to the role id),
  task text, status, and the id of the newest report whose `taskId` and `projectId` match.
  Order: blocked, running, queued, done, abandoned; newest `startedAt ?? createdAt` first
  within each.
- `src/shared/types.ts`, `ProjectTask`: two optional fields.
  - `source?: 'mcp-dispatch'`: set when Operator creates the task while routing an
    `mcp__operator__dispatch` call.
  - `blockedAt?: string`: set by `task_status(id,'blocked')`, cleared by any later status.
    I did not add `blocked` to `status`: `completeTerminalTasks`, the reconciler, SessionItem,
    RosterPanel and session-task all key on `status === 'running'`. A fifth status value would
    take blocked tasks out of the close path and leave them `blocked` forever.
- `src/renderer/views/DashboardView.tsx`:
  - `addProjectTask` and `addRunningTask` take an optional `source`.
  - Bus `send` path passes `'mcp-dispatch'`. `deliverDispatchRef` passes it when the id starts
    with `bus-`, which covers the launch path, the launch-failed queue fallback, and approval of
    a held bus dispatch. Sentinel (`OPERATOR-DISPATCH`) tasks are not marked.
  - The `task_status` poller used to ack `blocked` and drop it. It now calls the new
    `setTaskBlocked`. `setTaskStatus` clears `blockedAt`.
  - `CanvasPanel` gets `dispatched` when the active session's `roleId` is a coordinator id and
    it has a `projectId`; `undefined` otherwise. The value comes from `projects` state and the
    existing 4s `reports` poll, so it updates as either changes.
- `PlanPanel.tsx`: a DISPATCHED section between the agent todos and YOUR TASKS, only when
  `dispatched` is defined. Each row has a status glyph (`!` blocked in `--yellow`, `▸` running,
  `○` queued, `✓` done, `–` abandoned; `aria-label` carries the status), the lane in mono, the
  task on one line with an ellipsis, and on the right `blocked`/`abandoned` and `#<report>` when
  present. The full text is in the row's `title`. Empty state: "Tasks you hand to lanes appear
  here with their status." Agent todos and YOUR TASKS are unchanged.

### 2. Default coordinator charter

The brief's phrase "keep a running summary of who is doing what" is not in today's default
charter. It exists only in the second frozen entry of `LEGACY_COORDINATOR_CHARTERS`
(`prune-seeded-lanes.ts`), which is history and was not edited. Today's default is
`OPERATOR_CHARTER` in `src/renderer/lib/roster.ts`. Its equivalent sentence, "Track who has what,
and check returned work against the goal.", is now:

> Keep your own drafted and pending steps in Claude Code’s task list (TaskCreate/TaskUpdate) so
> they show in Operator’s Plan tab; don’t print that list into chat and never label it private.
> Check returned work against the goal.

Two consequences, both handled:
- The replaced wording is appended to `LEGACY_COORDINATOR_CHARTERS`. Without it, `isStockLane`
  would stop recognising coordinator lanes created from the old preset, and the seeded-lane
  prune would treat them as user-edited. The comment that said "this list never grows" now says
  each rewrite appends the text it replaced.
- The size guard for the orchestration note (`roster.test.ts`) failed: the coordinator note went
  from 3097 to 3261 characters, against a ceiling of 3100. The test's own comment allows a
  deliberate raise for a stated addition, so I raised it to 3300 and wrote down why. The lane
  note did not change.

Only `rolePresets()` / `DEFAULT_ROLE_PROMPTS` changed. `~/.operator/projects.json` was only read.

## Projects that need the charter edit by hand

Coordinator charters as stored in `~/.operator/projects.json` today:

| Project | Path | Stored charter |
|---|---|---|
| importer | ~/Developer/importer | previous default |
| Operator-landing | ~/Developer/Operator-landing | previous default |
| fastrack | ~/Developer/fastrack | previous default |
| Fastrack-landing | ~/Developer/Fastrack-landing | previous default |
| uwazi_web | ~/Developer/huridocs/uwazi_web | previous default |
| enfant-terrible | ~/Developer/enfant-terrible | previous default |
| mantel | ~/Developer/mantel | previous default |
| mantel-landing | ~/Developer/mantel-landing | previous default |
| darkmatter | ~/Developer/darkmatter | previous default |
| operator | ~/Developer/operator | legacy "Coordinate — don’t implement…" (the "running summary" text) |
| el-encanto | ~/Developer/el-encanto | legacy "Coordinate — don’t implement…" |
| uwazi_app | ~/Developer/huridocs/uwazi_app | legacy "Coordinate — don’t implement…" |
| web27 | ~/Developer/web27 | legacy "Coordinate — don’t implement…" |
| walter | ~/Developer/walter | legacy "Coordinate — don’t implement…" |
| visual language | ~/Documents/Claude/visual language | empty or absent |

All 15 need the edit. For "visual language": RosterPanel only backfills a charter when `prompt`
is `undefined`, so an empty string launches the coordinator with no charter at all. Check that
one separately.

## Tests

`src/renderer/lib/plan-dispatches.test.ts`, 7 tests:
- Scoping: only the named project's tasks; unknown project gives `[]`; only
  `source: 'mcp-dispatch'` tasks; newest matching report attached, and a report filed under
  another project is ignored; lane name from roster with id fallback.
- Ordering: blocked, running, queued, done, abandoned; newest first within a status; missing
  status reads as queued; `blockedAt` on a finished task does not make it blocked.

## Results

Run with the main checkout's `node_modules` and `electron/node_modules` symlinked in (removed
after).

- Root `tsc --noEmit -p .`: exit 0.
- `electron`: `tsc -p tsconfig.json --noEmit` exit 0; `tsc -p tsconfig.renderer.json --noEmit`
  exit 0.
- Renderer suite (`vitest run src/renderer`): 83 files, 1256 passed, 0 failed. The first run
  had 1 failure, the note-size guard described above.
- Electron suite (`electron`, `vitest run`): 32 files, 562 passed, 0 failed.

## Limits and what I left out

- Worker lanes are mostly not given the task id. On the bus `send` path the id goes back to the
  COORDINATOR in the verdict. On the launch path the id is created after the verdict, so nobody
  gets it. A lane's `task_status(id, …)` and `report(taskId)` therefore often name an id that
  does not match, and the poller acks those. In practice rows will mostly show `running` until
  the lane closes (then `done` or `abandoned`), and report numbers will appear only when a lane
  quotes the right id. Getting the task id to the receiving lane would fix this; it is outside
  this brief.
- Tasks stored before this commit have no `source`, so existing dispatched tasks do not appear.
  Only new bus dispatches show.
- Sentinel dispatches are not listed, as the brief specified `mcp__operator__dispatch`.
- No change to how Claude Code's own TaskCreate/TaskUpdate entries appear. They already reach
  `session.todos` through `transcript.ts`, and the agent todos section is unchanged.
