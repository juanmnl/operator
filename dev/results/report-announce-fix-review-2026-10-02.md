# Review: report announce fix (branch `operator/424580`) — 2026-10-02

**Branch:** `operator/424580`, commit `c0ab77f` (plus result commit `7ef289c`).

**Inputs:**
- Code's write-up: `dev/results/report-announce-fix-2026-10-02.md`.
- Diagnosis: `dev/results/lane-signal-back-research-2026-10-02.md`.

**Method:**
- Read the full diff.
- Read the parts of `submit-queue.ts` the pass depends on: `submit`, `pending`, `confirm` and `cancelNudge`.
- Checked the queue SQL in `chat-store.ts`.
- Counted the live undelivered rows read-only (`sqlite3 -readonly ~/.operator/artifacts.db`).
- Ran both suites on a `git archive` export of the branch, and again on the tree from `git merge-tree operator/bbc780 operator/424580`. The main checkout was not touched.

## Verdict

**Merge: yes.** The core change does what it claims, and the reasons are confirmed in code:
- every idle coordinator is served;
- a new report or a 5 s tick triggers a pass;
- old reports are summarised instead of dropped silently.

None of the findings below is a regression large enough to hold the merge. R1 should land in the same release, because the 5 s tick is what makes it reachable in quiet periods.

**Merge order:** after `operator/bbc780`. The two branches merge without conflicts. Merged second, this branch's summary and announcement lines go through the stripped `submitSequence` (see R6).

## Tests

| Tree | Renderer vitest | Root tsc | Electron vitest | Electron typecheck |
|---|---|---|---|---|
| `operator/424580` | 112 files, 1670 passed | 0 | 46 files, 804 passed | 0 |
| merge with `operator/bbc780` (`4cb5129`) | 113 files, 1682 passed | 0 | 46 files, 811 passed | 0 |

`git merge-tree --write-tree operator/bbc780 operator/424580` produced no conflicts. The two branches touch `mcp-serve.ts` in different hunks (`:281` vs `:301-316`), and `operator/424580` does not touch `submit-queue.ts`.

## Findings

### R1. Medium, PLAUSIBLE: no backoff after an unconfirmed announcement; the 5 s tick now repeats it in quiet periods too

**Where:**
- `DashboardView.tsx:4389-4390` returns `summary unconfirmed, left undelivered`.
- `:4430` ends with `stopped=#id unconfirmed, left undelivered`.
- The tick is at `:4463-4466` (`ANNOUNCE_TICK_MS = 5_000`, `comms.ts:298`).

**How it repeats:** an unconfirmed line leaves the row undelivered. As soon as `inFlight` clears, the next tick serves the tab again if `canAnnounceTo` still reads idle, and types the same line again. Each cycle is about 35 s: the 30 s `RESCUE_AFTER_MS` deadline plus up to 5 s for the tick.

**Scenario:** this is the stale-session case the research suspects and item 6 left unfixed. The tailer is attached to the wrong session for this tab, so:
- no user turn is ever confirmed for it;
- its phase never leaves `idle`.

Each line is still a real keystroke sequence into the real pty, so the coordinator receives it and starts a model turn. Result: about 100 identical `[Operator] report #x …` turns per hour, continuing indefinitely.

**What is new:** before this branch the effect re-ran only when `sessions` or `terminals` changed. That still happened about once a second while other lanes were busy, so the loop already existed during busy periods. The tick extends it to an otherwise quiet app. The announce log will not show it, because `noteAnnounce` writes an identical line only once per tab.

**Fix:**
- Keep a per-tab backoff after an unconfirmed outcome, for example 1 min doubling to 15 min, reset on a confirmed one. Skip the tab in `announceSkip` with `backoff` while it runs.
- Log the retry count, so repeats are visible despite the identical-line dedupe.

### R2. Medium, PLAUSIBLE: two coordinators that see the same rows can now announce them twice

**Where:**
- `announcePass` serves every selected coordinator in parallel (`DashboardView.tsx:4448-4456`). Rows are not claimed: `undeliveredFor` and `staleUndeliveredFor` only read (`chat-store.ts:452-462, :474`). `markReportDelivered` stamps only `WHERE delivered_at IS NULL` (`:410`), after the line is typed.
- The old single `announcingRef` serialised passes. The second coordinator therefore queried after the first had marked, and found nothing.

**When two coordinators see the same rows:**
1. Two coordinator tabs in the same project, for example a second instance (`…--operator--2`) or one `operator` plus one `orchestrator` (`addresseesOf` maps both to the same addressees, `chat-store.ts:250-252`).
2. Rows with `project_id IS NULL`, which both queries hand to every project's coordinator (`AND (project_id = ? OR project_id IS NULL)`).

Both coordinators type the same announcement. The stale summary is duplicated too, and for case 2 it lists another project's report ids and lane names in each coordinator.

**Today:** the live store has 45 undelivered rows and none with a NULL project (read-only count). Case 2 is therefore latent. It becomes reachable when `mcp-serve`'s `callerFromSessions` cannot stamp a project.

**Fix:**
- Claim before typing: an atomic `UPDATE … SET announcing_by = ? WHERE id = ? AND delivered_at IS NULL AND announcing_by IS NULL`, cleared on an unconfirmed outcome. Or serialise per project with an in-flight set keyed by `projectId` as well as by tab.
- Drop the `OR project_id IS NULL` branch from both queries, and give NULL-project rows to no coordinator. They stay in the Comms log.

### R3. Low, CONFIRMED: the stale summary is typed without re-checking that the coordinator is still between turns

**Where:** `DashboardView.tsx:4387-4389`.
- `artifactStaleUndelivered` is awaited, an IPC round trip.
- Then `submitQueue.submit(tab.id, line)` runs with no `canAnnounceTo` check.
- Each per-report announcement re-checks off `sessionsRef` before typing (`:4404`); the summary does not.

**Scenario:** the coordinator was idle when the pass selected it. The user, or another lane, starts a turn during the IPC. The summary line is then pasted into a live composer, which is the race the gate exists to prevent. The window is short (one IPC), so this is Low.

**Fix:** add the same `if (!canAnnounceTo(sessionsRef.current.find(...))) return 'stale=… outcome=stopped=turn started'` before the summary `submit`.

### R4. Low, CONFIRMED: the stale query reads the full rows, including `artifacts`, with no limit

**Where:** `chat-store.ts:474-486`. `staleUndeliveredFor` selects `summary, artifacts` for every stale row, with no `LIMIT`.

**Why it matters:**
- The summary needs only `id`, `role_id` and `terminal_id`, and lists at most 20.
- Reports carry content blobs; my audit report artifact alone was about 3 KB of headline plus a full file in other reports.
- The query runs on every pass for every idle coordinator: about once a second while sessions change, plus every 5 s. It returns the whole set over IPC each time until the rows are marked, and under R1 they are never marked.

**Today:** mantel has 21 stale rows. Cheap at this size, but it scales with the backlog.

**Fix:** select only the columns the summary uses. Return `COUNT(*)` plus the first `STALE_SUMMARY_MAX_IDS` rows, and mark the remainder by id range or by a second query.

### R5. Low, CONFIRMED (pre-existing, unchanged): "unconfirmed" is read from `pending(id)`, and a deliberate stop counts as delivered

**Where:**
- `submit-queue.ts` `cancelNudge('interrupt')` deletes `awaiting`.
- `serveCoordinator` treats "`pending(tab.id)?.text !== line`" as delivered (`DashboardView.tsx:4389, :4430`).

**Scenario:** if the user presses Stop or Escape on the coordinator while the summary or an announcement is in its confirm window, the row is marked delivered although the line may not have been submitted.

This branch does not introduce it, but the summary path now marks up to every stale row of a project on one such stop. Recorded so the next change to the pass does not build on it.

**Fix:** have `submit` return its verdict (`'confirmed' | 'cancelled' | 'unconfirmed'`) instead of the caller inferring it from `pending`.

### R6. Low, CONFIRMED: merge order with `operator/bbc780`

**Where:** `staleSummary` (`comms.ts:309-319`) builds the line from `r.roleId` and `r.terminalId`. Those are stamped from the lane's environment, so a lane with a shell can choose them (audit M3).

If this branch ships without `operator/bbc780`, a role id carrying control characters is typed raw. After the merge, `submitSequence` strips the line, and `awaiting` keeps the raw text, so the `pending(...).text === line` comparison still works. I checked this on the merged tree.

**Fix:** merge `operator/bbc780` first, as planned.

## Checked and clean

### Mid-turn and parallel passes

- `inFlight.add(tab.id)` runs synchronously in `announcePass`, before `serveCoordinator` yields (`DashboardView.tsx:4450-4451`). The effect-triggered pass and the tick run on the same JS thread, so a second pass cannot select a tab already being served.
- `inFlight.delete` is in `.finally` after `.then`/`.catch` (`:4452-4454`), so it is cleared on success, on a throw inside `serveCoordinator`, and on a throw inside `noteAnnounce`.
- Every per-report announcement re-checks `canAnnounceTo` off `sessionsRef` (`:4404`). Only the summary misses it (R3).

### Marking

- A row is marked only after `submit` resolved with no matching `pending` entry, for both the summary and each report (`:4389-4391`, `:4430-4431`).
- An unconfirmed summary returns before the per-report loop.
- `markReportDelivered` is idempotent (`WHERE … delivered_at IS NULL`).

### Project scope

- `staleUndeliveredFor` and `undeliveredFor` return nothing without a project (`chat-store.ts:453, :476`).
- The IPC also refuses without a project and logs once (`ipc.ts:211-213`).
- The only cross-project path is the NULL-project branch (R2).

### First boot

The live store holds 45 undelivered rows: mantel 21, uwazi-app 11, web27 9, operator 4. 32 of them are older than 12 h, and none has a NULL project.

The first pass types one summary line per project coordinator. mantel's lists 20 ids and says "and 1 more". There is no flood, provided R1 does not apply.

### Announce log (`announce-log.ts`)

- Serialised appends.
- Newlines flattened.
- Trimmed to the newer half past 512 KB.
- Never throws.
- Lines contain the tab id, role, project name, phase, counts, report ids and error messages. No report text.
- `announceLoggedRef` grows by one entry per tab id per app run, which is negligible.
- Like everything in `~/.operator` it is 0644 (audit L7).

### IPC rename

- `artifactExpireUndelivered` is gone from code; only historical `dev/results` notes mention it.
- `artifactStaleUndelivered` and `announceLog` appear consistently in:
  - `operator-api.ts:91-92`;
  - `ipc.ts:211, :500`;
  - `env.d.ts:67, :69`;
  - `operator-bridge.ts:205, :257` (Tauri no-ops).
- The preload generates from `SPEC`, so it needs no change.
- Both typechecks pass, and `registerIpc`'s boot assertion covers a missing handler.

### Performance

Each pass costs:
- one `filter` over the tabs with a `find` over sessions per tab;
- two IPC/SQLite reads per idle coordinator;
- no re-render, because the timer reads refs.

This is fine at current scale apart from R4.

### Report tool wording

`mcp-serve.ts:281` now describes what actually happens, and no longer promises an Inbox.

## Recommended follow-ups (not dispatched)

- **Code, same release:** R1 (per-tab backoff after an unconfirmed outcome) and R3 (re-check before the summary).
- **Code, next:**
  - R2: claim rows or serialise per project, and drop the `project_id IS NULL` branch.
  - R4: a narrow stale query.
  - R5: `submit` returns its verdict.
