# RESULT — session/task lifecycle

Read-only pass first (unchanged from the interim report), then implemented options 1–3 plus the
`SavedSession` prune as its own unit. Decision taken: **`abandoned`, not `done`**.

---

## What the store actually said (read-only, before any write)

| Brief says | Measured | Verdict |
|---|---|---|
| 46 live sessions, **0 ended** | 48 records, **no `status` field in that file at all** | premise was a category error |
| duplicates 5/5/4/3/3/3 per role | 5 research, 4× each operator/qa/review/design/code, +2 uwazi | confirmed |
| 16 tasks stuck `running` | **68** by the time I measured (18→ operator, 36+ el-encanto) | far worse |
| cause: stale `terminalId` + `!terminalId` precondition | **already fixed** in a prior pass | real cause was different |

### The mechanism for each bug

**1. Sessions never reach `ended` — there was nothing to fix.** `sessions.json` holds
`SavedSession`: `claudeSessionId, customName, cwd, effortLevel, key, lastActiveAt, model,
permissionMode, projectId, projectName, roleId, terminalId`. **No `status` field exists in that
type**, so "0 ended out of 46" counted a field the file never had. `core.rs:297` builds
`AgentSession` — the tailer-derived live view, recomputed every run from whether the pty is
alive. `ended` is derived state and it works. The real defect in that file was that nothing
pruned it (48 records, oldest nine days old, 20 of them duplicates) — handled as the prune below.

**2. Duplicate lanes — confirmed, and the guard was missing, not broken.** The in-flight guard
only covered the seconds a launch takes. Nothing stopped a *second* lane for a role that already
had a live session, which is how one project accumulated 4–5 per role.

**3. Tasks stuck `running` — two causes, one of them unfixable here.**

- **(a) `terminalId` is not unique across runs.** It's a per-run counter, so `t5` is held by
  three different sessions in the real store (uwazi qa Jul 21, operator qa Jul 23, operator code
  today). Every liveness test keyed on it, so a task from last week looked alive today merely
  because this run reused the counter. **That is why reconciliation never caught these.**
- **(b) Completion only fires when a lane DIES** — `onTerminalExit`, or closing a session through
  the app. There is no per-turn completion signal, so a long-lived lane accumulates every
  dispatch it was ever sent as `running` even after finishing each one. **Not fixed here and not
  fixable by reconciliation**: those lanes are alive, so `running` is the honest status.
  Closing them needs a real completion signal. This is now stated in the module header so the
  next person doesn't mistake it for the same bug.

---

## What landed

### A. Liveness re-keyed on `claudeSessionId` (option 1)

- `ProjectTask` gains **`claudeSessionId?`** — a UUID, one per session, stable across restarts.
  `terminalId` stays for the diff link, with its collision documented in the type.
- `lib/task-lifecycle.ts` rewritten around `LiveLane[]` instead of a `Set<string>` of terminal
  ids. `liveLaneOf` matches on the session id; a task stamped before the field existed falls
  back to terminal **+ role**, as a one-time bridge that `reconcileStaleRunning` then stamps.
- `markTasksRunning` / `addRunningTask` stamp it at pickup, via a new `claudeIdOf(terminalId)`
  that reads the live session list (and ignores `local-…` ids from untracked sessions).
- `completeTerminalTasks` matches by session id first. Previously an exiting lane could close a
  *previous* run's tasks that happened to share its counter.

### B. `abandoned` as a fourth status (option 3) — the decision

`ProjectTask.status` is now `queued | running | done | abandoned`. Reconciliation writes
**`abandoned` + `reconciledAt`**, never `done`, and invents no `doneAt`.

**Why:** the old code wrote `done` and tried to admit the difference in a `reconciledAt`
subfield — but every count, chip and header reads `done`. With 68 tasks in scope that is a large
lie told in aggregate. `abandoned` says exactly what is known: *its run ended and we never saw
it finish.* Re-queue (`↩`) is still one click away on the row for anything that wasn't done.

**UI consequence I had to fix or it would have been worse than the bug:** an `abandoned` task
matched none of `TaskQueue`'s three buckets, so ~50 tasks would have **vanished from the UI
entirely**. The closed section now covers done ∪ abandoned, its header counts them separately
(`Closed · 68 · 50 abandoned`), and abandoned rows reuse the existing `⋯` / unverified treatment
with an `abandoned` label rather than `unconfirmed`.

### C. Duplicate-launch guard + one deterministic resolver (brief §2)

- `handleLaunchRole` now **reuses a live lane** for the role — submits the prompt into it and
  focuses it — instead of spawning a second. The in-flight guard stays as-is behind it.
- `pickLaneTab(tabs, projectId, roleId)` in `lib/dispatch.ts` is now **the** resolution of
  "which terminal is this role's lane", used by both `routeDispatch` and the launch guard, so
  the two can't pick different duplicates and both look right. Where duplicates exist it prefers
  **most recently active**, ties to latest in input order — replacing `find()`'s array order,
  which was whatever reattach happened to produce.

### D. `SavedSession` prune — separate unit (option 4)

`lib/session-prune.ts` + `pruneSavedSessions(saved, liveClaudeIds)`. Drops **duplicate lane
records only**; keeps the most recently active per (project, role), **never** prunes a record
whose session is live, and never touches a singleton or an ad-hoc (roleId-less) record.
Order-preserving and idempotent.

Wired after reattach (so liveness is real) and **backed up before its first write** to
`~/.operator/backups/sessions.json.<stamp>` via `folderPrefsSaveMd` — which creates its parent
dirs, so no Rust change. **If the backup fails the prune is skipped**, and it reports what it did
in a toast. Note: the backup is re-serialized JSON, same data, not the same bytes.

---

## Projected effect on your store (read-only, before any write)

**Sessions — 48 records → 28 kept, 20 pruned.** Under the brief's ~43 stop-line. Every keeper is
the most-recently-active record of its lane; today's working lanes are all keepers. A unit test
pins these exact numbers against the measured group shape.

**Tasks — 68 running.** None carry `claudeSessionId` yet, so all take the one-time bridge, and
the split depends on which lanes are live when the app next starts:

| lanes live at hydrate | adopted (stay `running`) | abandoned |
|---|---|---|
| cold start, nothing live | 0 | **68** |
| this Code lane only | 18 | 50 |
| + operator research | 21 | 47 |
| + el-encanto's four lanes | 65 | 3 |

Since you've closed the dev window, the likely outcome on next launch is the **cold-start row**
or close to it: nearly all 68 become `abandoned` in one pass, with `reconciledAt` stamped, and
the roster stops claiming work is in flight. That is the intended result — and it's reversible
per row via `↩`, which is much of why `abandoned` beat `done` here.

**Residual, stated plainly:** any lane that *is* live keeps its tasks `running` forever, because
cause (b) is untouched. On next launch that's a small number; over a long session it grows again.

---

## Verification

- `npm test` — **286 passed** (was 275). `cargo test` — 100 passed. `npm run build` — clean.
- **New/rewritten unit tests (24 in the two modules):**
  - a task on a live lane is not stale; one whose session is gone **is** — keyed on the session
    id, and explicitly **ignoring `terminalId`**, which is the collision fix;
  - the legacy terminal+role bridge matches, and refuses a same-terminal/different-role task;
  - reconcile **adopts** a live legacy task (stamping the key) and **abandons** a dead one,
    inventing no `doneAt`;
  - **idempotent** — second pass returns the same array reference, so no write is triggered;
  - an already-abandoned task is never resurrected;
  - `pickLaneTab` prefers most-recently-active, is order-independent, never returns an ended /
    wrong-project / wrong-role tab, and `routeDispatch` resolves through it;
  - prune: keeps the newest of a group, **never prunes a live duplicate**, leaves singletons and
    ad-hoc records alone, preserves order, is idempotent, and reproduces the real store's
    48 → 28/20 split.
- `node dev/drive-task-lifecycle.mjs` — passes with the new semantics:
  `{"queued":3,"running":1,"done":0,"abandoned":2,"reconciled":2}`, header reads
  `Closed · 2 · 2 abandoned`, row markers read `abandoned`. **`running: 1` is the important
  one** — the live lane's in-flight task was not closed out from under it.
- `drive-roster`, `drive-navigation`, `drive-sidebar`, `drive-project-rail` — pass. `drive-sidebar`
  confirms launching a genuinely **idle** lane still spawns (the reuse guard didn't break it).
- The dev server had gone down with your window; I started a temporary vite on **1440** for the
  driver runs and stopped it afterwards. Nothing bound 1432–1435.

## Not done, deliberately

- **A per-turn completion signal** (cause 3b). The brief didn't ask and it's a design question:
  Operator hosts the CLI over a pty, so "this turn finished the task" has no existing signal.
- **No retroactive relabelling** of the 312 tasks already `done` — some carry `reconciledAt` and
  were closed by the old logic, i.e. they are abandoned by today's definition. Rewriting history
  seemed worse than leaving it; their `reconciledAt` still marks them unverified in the UI.
- Agent-to-agent reply delivery, and the reply-sentinel Rust — untouched, per your out-of-scope list.

## Queue

Next: `harden-lane-dispatch-authority.md`, then shelf-9 (AGENTS live-only), then
`global-agent-model-config.md` (its §4 numbers already measured: 78 role entries, 73 model fields
would clear to inherit, 5 stay pinned — `4× operator→opus`, `1× code→fable`).
