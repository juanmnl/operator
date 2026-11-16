# Announce follow-ups R1, R2, R3 — 2026-10-02

**Branch:** `operator/58dc0`.

**Commits:**

| Commit | What |
|---|---|
| `055e207` | Merge of `operator/424580` into this branch (see "Base" below) |
| `5611eab` | R1: per-tab backoff after an unconfirmed announcement |
| `df40914` | R2: claim rows before announcing; NULL-project rows go to no coordinator |
| `c05436d` | R3: re-check the gate before the stale summary |

**Input:** `dev/results/report-announce-fix-review-2026-10-02.md`, sections R1-R3.

## Base

The brief said `operator/424580` was merged, but `main` was at `c21e7a8` (the `operator/bbc780` merge) and did not contain it. I merged `operator/424580` into this branch first (`055e207`, no conflicts). This is the merge order the review asked for: bbc780 first, then 424580. Merging this branch into `main` brings in 424580 as well.

## R1. Backoff after an unconfirmed outcome

**Changes:**
- `src/renderer/lib/comms.ts:262-295`:
  - `AnnounceBackoff` (`failures`, `until`);
  - `ANNOUNCE_BACKOFF_MIN_MS` = 1 min and `ANNOUNCE_BACKOFF_MAX_MS` = 15 min (`:266`);
  - `announceBackoffMs(failures)`, which gives 1, 2, 4, 8, then 15 min (`:275`);
  - `nextAnnounceBackoff(prev, outcome, now)` (`:283`).
- How `nextAnnounceBackoff` decides:
  - An unconfirmed outcome adds one failure and starts the wait.
  - A confirmed delivery with nothing unconfirmed clears the backoff.
  - A pass with neither (`nothing pending`, `stopped=turn started`) leaves it as it was.
  - A pass that confirmed one line and then left the next unconfirmed counts from one failure again.
- `announceSkip` (`comms.ts:312`) returns `'backoff'` while `now < until`. Both it and `coordinatorsToAnnounce` (`:324`) take the backoff map and `now` as optional trailing arguments, so existing callers are unchanged.
- `DashboardView.tsx:4367` adds `announceBackoffRef`, keyed by tab id.
- `serveCoordinator` (`:4379`) now returns `{ what, delivered, unconfirmed }` instead of a string.
- `announcePass` updates the backoff when a serve finishes (`:4491`).
- The announce log line gets `retry=N backoff=Ns` appended on an unconfirmed outcome (`:4496`).
  - The log writes an identical line only once per tab, so without this field a repeated unconfirmed outcome would not appear.
  - The `skip=backoff` line between attempts also changes the last-logged line, so each retry is written.

**Not changed:** the backoff lives in renderer memory. A renderer respawn clears it, so a broken tab gets one fresh attempt per respawn.

## R2. No double announce across coordinators

**Store (`electron/src/main/chat-store.ts`):**
- `migrateReports` adds `announcing_by TEXT` and `announcing_at TEXT` (`:390`).
- `REPORT_CLAIM_STALE_MS` = 5 min (`:258`).
- `claimReports(ids, by, at, staleBefore)` (`:427`):
  - It runs one `UPDATE` per id, all in one transaction, and returns the ids it got.
  - It takes a row only `WHERE delivered_at IS NULL AND (announcing_by IS NULL OR announcing_by = by OR announcing_at < staleBefore)`.
- `releaseReports(ids, by)` (`:438`) clears only the caller's own claims, and only on undelivered rows.
- `undeliveredFor` (`:490`) and `staleUndeliveredFor` (`:513`) are now `AND project_id = ?`; the `OR project_id IS NULL` branch is gone. Such rows still show in the Comms log, because `reportsOfProject` lists NULL-project rows under every project (`comms.ts:152`).

**IPC:**
- New invoke methods `artifactClaim(ids, claimant)` and `artifactRelease(ids, claimant)`:
  - `operator-api.ts:92-93`;
  - `env.d.ts:71, :73`;
  - `ipc.ts:218-223`;
  - Tauri no-ops in `operator-bridge.ts:206-207`.
- Main stores the claimant as `<app pid>:<tab id>`. Tab ids restart at `t0` every run, so a claim from an earlier run's `t2` must not count as this run's `t2`.

**Renderer (`DashboardView.tsx`):**
- Stale summary (`:4401`): claim every stale id, then summarise only the claimed rows. Rows another coordinator holds are skipped.
- Unconfirmed summary: release its claims (`:4416`).
- Per report (`:4458`): claim the one row just before typing its line. If the claim fails, skip that report. If the line is unconfirmed, release it (`:4463`).
- Skipped ids are logged as `held elsewhere=#a,#b` (`:4470`).
- A throw between claim and mark leaves the claim in place. It stops holding after 5 min.

**Why claims and not per-project serialisation:** claims also hold across processes and windows. They also let a second coordinator in the project pick up rows that the first one released after an unconfirmed line. The cost is two columns and two IPC methods.

## R3. Re-check before the stale summary

`DashboardView.tsx:4406-4412`: right before the summary `submit`, the pass re-asks `canAnnounceTo(sessionsRef.current.find(...))`. If the coordinator is no longer between turns:
- it releases the claimed ids;
- it returns `stale=N outcome=stopped=turn started` with `delivered: false, unconfirmed: false`, so the backoff is not touched.

The check sits after both IPC round trips, the stale read and the claim.

## Tests

**New renderer tests** (`src/renderer/lib/comms.test.ts:296`, `announce backoff`):
- The schedule: 1, 2, 4, 8, 15, 15, 15 min, and 0 for no failures.
- Consecutive unconfirmed outcomes count up, and each `until` is taken from the time of its outcome.
- Reset on a confirmed delivery, kept on a neutral pass, and back to 1 after a delivered-then-unconfirmed pass.
- `announceSkip` returns `'backoff'` until `until` and `null` from then on. `coordinatorsToAnnounce` still serves a second, un-backed-off coordinator.

**New electron tests** (`electron/src/main/chat-store.test.ts:328`, `two coordinators in one project`):
- An `operator` and an `orchestrator` queue read the same rows, and only the first claim gets each row. The holder may re-claim; the other may not.
- Release:
  - only the holder's release counts;
  - a released row can be claimed by the other coordinator;
  - a delivered row cannot be claimed, even after a release.
- A claim older than the timeout no longer holds, and the new claimant then holds the row against the old one.
- An older database without the claim columns is migrated, and its rows can be claimed.

**Changed electron tests:**
- `:303`: the scoping test now expects NULL-project rows in no queue, stale or not, and still listed by `listReports`.
- The "already at user_version 1" test inserted a row with no project and relied on the dropped branch. It is about the migration skip, so the row now carries `project_id = 'p'`.

**Results on `c05436d`:**

| Check | Result |
|---|---|
| Root `npx tsc --noEmit -p .` | exit 0 |
| Renderer `npx vitest run` | 113 files, 1686 passed |
| `electron/ npm run typecheck` | exit 0 |
| `electron/ npx vitest run` | 46 files, 815 passed |

**Not covered by a unit test:** the `serveCoordinator` / `announcePass` wiring in `DashboardView.tsx`. It has no render harness; the pure parts it calls are tested.

## GUI checks (for the user; not run here)

1. **R1.** Make a coordinator's announcement go unconfirmed, for example by pointing its tailer at a stale session.
   - Expect `~/.operator/logs/announce.log` to show `outcome=… unconfirmed … retry=1 backoff=60s`, then `skip=backoff`.
   - The next attempt about a minute later should show `retry=2 backoff=120s`, and so on up to `900s`.
   - The coordinator should get one line per attempt, not one every ~35 s.
2. **R1 reset.** After a confirmed announcement on that tab, the next unconfirmed outcome should log `retry=1` again.
3. **R2.** Open two coordinator tabs in one project, both idle, then have a lane file a report.
   - Exactly one coordinator should get the `[Operator] report #…` line.
   - The other's log line should show `held elsewhere=#…` or `nothing pending`.
   - Repeat with a report older than 12 h for the stale summary.
4. **R2 NULL project.** A report row with `project_id` NULL should be announced to no coordinator and should still appear in each project's Comms log.
5. **R3.** Hard to trigger by hand, because the window is two IPC round trips. If a coordinator's log ever shows `stale=N outcome=stopped=turn started`, the summary was held back and its rows stay undelivered for the next idle.

## Left out on purpose

- **R4** (narrow stale query, `COUNT` + first 20), **R5** (`submit` returns its verdict) and **R6** (merge order, already satisfied here): not in this brief.
- **R5 still applies:** a Stop/Escape during the confirm window counts as delivered, and with R2 that delivered row's claim is never released. That is harmless, because a delivered row is never queried again.
- **Claim columns on delivery:** nothing clears `announcing_by`/`announcing_at` when a row is delivered. Only undelivered rows are claimed or read, so the stale values have no effect.
