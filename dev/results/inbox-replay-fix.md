# Inbox replay on launch — fixed

**Date:** 2026-08-25 · **Branch:** `operator/51cf00` · Files: `electron/src/main/chat-store.ts`, `electron/src/main/ipc.ts`, `electron/src/main/chat-store.test.ts`

## The bug

`ArtifactStore.undeliveredFor` returned every report with `delivered_at IS NULL`. The lifecycle
columns (`to_role`, `delivered_at`, `acked_at`) were added by `migrateReports()` long after the
table existed, so all 310 pre-migration rows — oldest 2026-08-06 — read as "never announced".
The idle-announce pass in `DashboardView` drains that queue three at a time whenever the
coordinator lane is between turns, so every launch replayed the whole history at it, one pty line
per row.

## The fix

**1. A launch cutoff, computed once per `ArtifactStore` construction.**

`ArtifactStore(path, launchedAt = new Date().toISOString())`. After the migration runs, the
constructor takes `MAX(acked_at)` from the table and keeps whichever of that and `launchedAt` is
later as `announceCutoff`. `undeliveredFor` gained `AND at > ?` against it. History is not news: a
report the app was not running to hear has missed its announcement, and the Inbox is still where
its text lives.

The cutoff is read **once**, not per query, on purpose — otherwise a human opening an old row
mid-session would raise the bar under reports that are genuinely still waiting to be announced.

**2. Ack on announce.**

New `markReportAnnounced(id, at)` sets `delivered_at`, `acked_at` and `seen = 1` in one statement,
each timestamp under `COALESCE` so a second announce keeps the first moment. `ipc.ts`'s
`artifactMarkDelivered` now calls it — the announce pass is that channel's only caller, so no API
surface changed and the renderer was not touched. `delivered_at` alone would already survive a
restart, but the cutoff is computed from `acked_at`, so an announced report has to raise that bar
itself or the next launch starts below it.

**Trade-off, flagged:** `unreadByRole` counts reports with no `ackedAt`, so a report announced to
the coordinator no longer contributes to the Inbox unread badge — being announced now counts as
read. `markReportUnread` (already wired to `artifactMarkUnread`) puts the mark back. Say the word
if the badge should instead track `delivered_at` and the cutoff should read `MAX(delivered_at)`;
that is a two-line change to the same two methods.

Old rows are untouched — `listReports` has no cutoff, so the Inbox UI shows all of them exactly as
before. Nothing is deleted.

## Tests

Five new cases in `electron/src/main/chat-store.test.ts`, under
`ArtifactStore — the announce cutoff`, each on its own db file so the launch time is real:

- a report written before this launch is never announced — **and is still in `listReports`**
- a report written after launch is announced
- the newest `acked_at` wins over launch time when it is later (clock skew / future-dated rows)
- **ack-on-announce**: `markReportAnnounced` writes both timestamps, empties the queue, and a
  fresh store on the same file stays quiet while the row remains readable
- announcing twice keeps the FIRST timestamps

## Verification

- `electron/`: `npm run typecheck` clean; `npx vitest run` → **23 files, 372 tests, all pass**
  (chat-store.test.ts: 27).
- root: `npx tsc --noEmit` exit 0. `npm test` → 910 pass, 33 fail across 5 files
  (`forgotten projects`, `ghost probe`, rail-fold `persistence`, …). **Pre-existing and
  unrelated** — jsdom/localStorage-environment failures in files this change does not touch; the
  diff is three files, all under `electron/src/main/`.
- Not GUI-verified: a real launch with the live 310-row `~/.operator/artifacts.db` is the user's
  check. Expected behaviour there: silence at startup, full list in the Inbox.

## Left out

- No backfill of `delivered_at`/`acked_at` on the existing 310 rows. The cutoff makes it
  unnecessary and a mass `UPDATE` would destroy the "nobody ever read this" mark those NULLs
  carry.
- The Tauri store (`src-tauri/src/artifacts.rs`) has no lifecycle columns and no undelivered
  query, so there is nothing to mirror there.
