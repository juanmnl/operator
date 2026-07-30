# Task lifecycle is broken — tasks never leave `running`, and the chip mislabels them

> **REWRITTEN 2026-07-28 after reading the durable state. The first version of this brief said
> "a live lane's queue has no start button" and asked for a per-lane start action. That diagnosis
> was WRONG and building it would have fired already-dispatched tasks at running lanes. Ignore it.
> The real defects are below.**

**Reported as:** "a lot of jobs seem queued, but no way to trigger them" — six lanes showing
16 / 9 / 28 / 19 / 5 / 7 QUEUED.

## What the durable state actually says

From `~/.operator/projects.json`:

| Project | running | done | genuinely queued |
|---|---|---|---|
| operator | 77 | 9 | 8 (all unassigned) |
| uwazi_app | 92 | 20 | 2 (all unassigned) |
| fastrack | 26 | **0** | 0 |
| el-encanto | 16 | 1 | 0 |

Almost nothing is queued. Almost nothing is ever done. **Tasks enter `running` and stay there
forever**, across every project, accumulating without limit.

## Defect 1 — the count is a lifetime total, labelled "QUEUED"

`RosterPanel.tsx:119-120`:

```js
for (const t of project.tasks ?? []) if (t.roleId) taskCounts[t.roleId] = (taskCounts[t.roleId] ?? 0) + 1
```

No status filter. It counts `running` and `done` tasks too, then renders as `{queued} QUEUED`
(`:529`) and `Launch {queued} →` (`:594`). So "28 QUEUED" on Code is really 23 running + 7 done,
and an idle lane offering `Launch 28 →` would be claiming to start tasks that are finished.

Fix: count only `status === 'queued'`, and the chip must name what it shows. If running and done
counts are worth surfacing, they are a different chip with a different word — never folded into one
number under the wrong label.

## Defect 2 — a task marked `running` can never be marked done again (root cause)

`DashboardView.tsx:597-598`, the completion matcher:

```js
const isMatch = (t) =>
  t.status === 'running' && (t.terminalId === terminalId || (!!roleId && t.roleId === roleId && !t.terminalId))
```

`markTasksRunning` stamps the live `terminalId` onto the task (`:1090`, `:1112`, `:1041`). But
`terminalId` is the pty id **of the current backend run** — `shared/types.ts` says outright that it
is stale and ignored after a restart.

So once the app restarts (or that pty dies), the task holds a `terminalId` that no live terminal
will ever match again. And the roleId fallback cannot rescue it, because that branch requires
`!t.terminalId` — the very field that was stamped. **The task is permanently unmatchable.** Every
restart strands the entire in-flight set. That is why fastrack has 26 running and zero done.

Fix direction (decide with evidence, do not just widen the matcher):
- Reconcile stale `terminalId`s at startup — a task pointing at a pty that no longer exists is not
  running, and hydration is the natural place to say so.
- Make the roleId fallback able to match a task whose `terminalId` is *dead* rather than only one
  that never had it.
- Consider whether `running` should be durable at all, or derived from a live lane at render time.
  A status that outlives the process that set it is the underlying design problem here.

## Defect 3 — unassigned tasks are unreachable

The only genuinely `queued` tasks (8 in operator, 2 in uwazi) have **no `roleId`**. Nothing picks
them up: `startProjectTasks` skips `!t.roleId`, and lane launch only claims its own role's tasks.
They sit in the backlog permanently. They need to be assignable — or visible somewhere that admits
they are unrouted.

## Defect 4 — no way to clear the wreckage

There must be a way to inspect a lane's task list and dismiss or requeue individual entries. With
~200 stuck tasks across four projects, a fix that only corrects the lifecycle going forward leaves
the existing pile in place. A one-time reconciliation on hydration (defect 2) would clear most of it
automatically — prefer that over asking the user to hand-delete 200 rows.

## Related

Some fraction of these were dispatched, half-delivered, and never run at all — see
`dev/briefs/submit-queue-long-message-split.md`. Fix that first; it is upstream of this.

## Verify

Unit-test the matcher directly: a task stamped with a dead `terminalId` must become completable.
Add a hydration test proving stale-terminal tasks are reconciled on load. Then drive the mock
harness on a free port (**not** 1433 — bare Python server, not the app) and assert the chip counts
only real queued tasks across all six palettes.
