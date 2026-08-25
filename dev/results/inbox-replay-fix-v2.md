# Inbox replay — reworked per review

**Date:** 2026-08-25 · **Branch:** `operator/51cf00` · supersedes `dev/results/inbox-replay-fix.md`
**Files:** `electron/src/main/{chat-store.ts, chat-store.test.ts, ipc.ts}`,
`src/renderer/lib/{inbox.ts, inbox.test.ts}`, `src/renderer/views/DashboardView.tsx`

All five review points are done. The v1 cutoff and the ack-on-announce are gone entirely.

## 1 · Announcing no longer acks (`ipc.ts`)

`artifactMarkDelivered` calls `markReportDelivered` again, and `markReportAnnounced` — which wrote
`acked_at` and `seen = 1` — is deleted. The review is right: announcing a report to a lane is not
a human reading it, and writing the ack there emptied the Inbox's unread count for messages nobody
had opened. `markReportDelivered`'s doc now says outright that it touches neither column.

## 2 · A one-time backfill, not a time cutoff (`chat-store.ts`)

`announceCutoff`, `computeAnnounceCutoff`, the `MAX(acked_at)` read and the `AND at > ?` clause are
all removed; `undeliveredFor` is back to `delivered_at IS NULL AND (to_role = ? OR to_role IS NULL)`.

In their place, `backfillDelivered()` runs once per database, guarded by `PRAGMA user_version`
(`ARTIFACTS_SCHEMA_VERSION = 1`) — the same mechanism `ChatStore.purgeInjectedRows` already uses,
on `artifacts.db`'s own independent counter:

```sql
UPDATE reports SET delivered_at = at WHERE delivered_at IS NULL
```

- `delivered_at = at`, not the migration's timestamp: the claim is "this one had its moment", and
  `at` is when that moment was. It also keeps the value honest for the Inbox, which displays it.
- **It is not an ack.** Backfilled rows keep `acked_at IS NULL`, so history still shows unread and
  still counts — it just stops shouting.
- No backup file: nothing is destroyed, one NULL column becomes a timestamp already sitting in the
  row beside it.
- Any process may run it — the app, or a lane's MCP server — which is safe because it is
  idempotent and ordered before that process's own writes.

**Why this is the better division, in one line:** the cutoff answered "older than launch?", which
also silenced reports a lane files while the app is **closed** — exactly when a lane is most
likely to be working unattended. The migration answers "older than the fix?", which is the
question that was actually being asked.

## 3 · The phase guard moved inside the loop (`DashboardView.tsx`, `lib/inbox.ts`)

The batch drains up to three reports. The phase was checked once, before the first — but the first
announcement is what **wakes** the lane, so announcements 2 and 3 were pasted into a composer that
was by then mid-turn. That is the precise race reports exist to avoid.

The check is now a pure `canAnnounceTo(session)` in `lib/inbox.ts`, asked before the pass **and
before every line in it**, reading `sessionsRef.current` rather than the effect closure's
`sessions` — the closure's snapshot still says `idle` and would never see the lane wake. Whatever
is left stays undelivered and goes out on the next idle.

**The mark moved too, and this is the part the review's test note is about.** It was
mark-then-submit; it is now submit-then-mark, inside a `try`. The old order marked a report
delivered whether or not the line ever reached the composer, so a failed or skipped announcement
was silently swallowed. Worst case now is one duplicate announcement after a crash between the
two — recoverable, where a silent drop is not.

## 4 · The `markReportUnread` doc

Rewritten to what it actually does: clears `acked_at` **and** `seen`, leaves `delivered_at` alone
(it *was* announced; saying otherwise would announce it again), and names its real caller — the
`mark unread` control in `InboxPanel`'s row footer, via `artifactMarkUnread`. That control existing
is what makes ack-on-open safe to have, which is what the old wording was gesturing at without
being checkable.

## 5 · The timestamp invariant

There is no longer a timestamp **comparison** anywhere in the store — that was the cutoff's
`at > ?`, and it is gone. What remains is documented at the write site (`markReportDelivered`):
`at` and `delivered_at` are ISO-8601 UTC strings from `new Date().toISOString()` (the MCP server's
for the row, `ipc.ts`'s for the mark), and the column is only ever read back for display or tested
`IS NULL` — a display contract, not an ordering one. The backfill copies `at` verbatim, so it
cannot introduce a second format.

## Tests

**`electron/src/main/chat-store.test.ts`** — the cutoff block is replaced by
`ArtifactStore — the one-time delivered backfill` (8 cases). Legacy databases are built by hand at
the real pre-fix state: lifecycle columns present, every `delivered_at` NULL, no `user_version`.

- pre-migration rows are all marked delivered and never announced — **and still in `listReports`**
- `delivered_at` comes from `at`, not from the migration's clock
- they are **not** acked (`ackedAt` undefined), so the Inbox still counts them unread
- **runs once**: a report inserted after the migration, with the app closed, is announced on the
  next launch — the case the cutoff broke
- an **unmarked** announce stays announceable: read the queue twice, reopen the store, still there
- `markReportDelivered` empties the queue and touches nothing else (`ackedAt` still undefined)
- announcing twice keeps the first delivery timestamp
- `markReportUnread` clears ack + seen and leaves delivery intact

**`src/renderer/lib/inbox.test.ts`** — `canAnnounceTo` (3 cases): idle/waiting allowed,
`running`/`compacting` refused (the mid-turn paste), ended lane and missing session refused.

## Verification

- root `npx tsc --noEmit` exit 0; `electron/ npm run typecheck` clean.
- `electron/ npx vitest run` → **375 pass**, 23 files (chat-store: 30).
- root `npm test` → **920 pass**, 33 fail — the same pre-existing jsdom/localStorage failures
  (`forgotten projects`, `ghost probe`, rail-fold `persistence`) present before any of this work,
  in files these diffs do not touch.
- Not GUI-verified: the announce loop needs a live Electron app with a coordinator lane. The
  decision it makes is unit-tested (`canAnnounceTo`); the ordering around `submitQueue.submit` is
  by inspection.

## Left out

- The announce loop itself still lives in `DashboardView`, so only its guard is unit-testable.
  Extracting the whole pass into `lib/` would make the submit-then-mark ordering testable too;
  that is a refactor beyond this rework and I did not start it.
- No backfill of `acked_at` and no change to `seen`.
