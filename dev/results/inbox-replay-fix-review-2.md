# Adversarial re-review — inbox backfill v2 (`operator/51cf00` @ `ffe7d09`) + Files scroll (`6cf4495`)

**Against:** `dev/results/inbox-replay-fix-review.md` (my five points) and Code's response in
`dev/results/inbox-replay-fix-v2.md`.
**Read:** the full `ceb8b90..ffe7d09` diff, `6cf4495` in full, plus `submit-queue.ts`,
`lib/inbox.ts`, `mcp-serve.ts`, `chatstore.rs`, and the live `~/.operator/artifacts.db`.

## Verdict: **MERGE, with one fix first** — the backfill needs a transaction.

Four of my five points are fully closed and one is closed in substance with a documented residual.
The rework is the right shape: the migration divides on the fix rather than on the clock, which is
strictly better than what I asked for. But the new `user_version` migration is a check-then-act on
a database this project explicitly gives **two concurrent writers**, and I reproduced a genuine
report being silently swallowed by it. That is one line to fix and it is the same class of silent
drop the whole branch exists to remove, so it should not ship as-is.

The Files commit is clean and cannot touch Chat/Preview/Console.

---

## The five points, re-checked

| # | v1 finding | Status |
|---|---|---|
| 1 | ack-on-announce marks unread reports read | ✅ **CLOSED.** `markReportAnnounced` deleted; `ipc.ts:172` back to `markReportDelivered`, which touches neither `acked_at` nor `seen`. Asserted (`chat-store.test.ts`, "touches NOTHING else"). |
| 2 | `MAX(acked_at)` future-date lockout | ✅ **CLOSED.** `announceCutoff`, `computeAnnounceCutoff` and the `AND at > ?` clause are all gone. No timestamp comparison remains in the store. |
| 3 | reports filed while the app is down are lost | ✅ **CLOSED**, and better than my suggestion: `delivered_at = at` rather than the migration's clock keeps the Inbox's displayed value honest. Covered by the "RUNS ONCE / filed while closed" test. Verified the constructor ordering — `exec(DDL)` → `migrateReports()` → `backfillDelivered()` → any `insertReport` — so a lane's own MCP process cannot backfill over its own write. |
| 4 | mixed timestamp formats | ✅ **CLOSED for the store.** One overclaim: the v2 doc says "there is no longer a timestamp comparison anywhere", but `lib/inbox.ts:103` still sorts `laneComms`/`inboxFor` by string `at`. That is pre-existing and, per review 1's byte analysis, sub-second — but the backfill now copies 20-char `at` values into `delivered_at`, so that column is mixed-format too. Display-only today; the invariant comment at `markReportDelivered` should say the *column*, not just this writer, is unordered. |
| 5 | `markReportUnread` doc / dead `seen` / missing tests | ✅ mostly. Doc now says exactly what it does and names `InboxPanel`'s control — and the test asserts it. `seen` is still write-only (only `markReportAcked`/`markReportUnread` touch it), which is fine now that delivery doesn't. The `computeAnnounceCutoff` per-MCP-call `MAX()` scan is gone, replaced by a `pragma user_version` read — cheaper. Remaining gap: the renderer's submit-then-mark ordering is still untested, and that is where the one live defect below sits. |

---

## 1. 🔴 MUST FIX — the `user_version` backfill is a check-then-act on a two-writer database

`chat-store.ts:241-246`:

```js
const version = Number(this.db.pragma('user_version', { simple: true }) ?? 0)
if (version >= ARTIFACTS_SCHEMA_VERSION) return
this.db.prepare('UPDATE reports SET delivered_at = at WHERE delivered_at IS NULL').run()
this.db.pragma(`user_version = ${ARTIFACTS_SCHEMA_VERSION}`)
```

Three separate statements, three separate implicit transactions. The doc says this is "safe
because it is idempotent and ordered before that process's own writes" — idempotent it is,
**atomic it is not**, and that is the property the concurrency needs.

`artifacts.rs`'s own header says why this matters here and not in `ChatStore`: *"two processes
write here that never touch chat.db — the app AND a short-lived MCP server spawned per lane"*.
`purgeInjectedRows`, the pattern this copies, guards a **single-writer** database. `artifacts.db`
is the one place in the app where the pattern is wrong.

**Reproduced**, exact code path, two `better-sqlite3` handles on one WAL db:

```
both read user_version: 0 0
new report delivered_at before P2 finishes: null
new report delivered_at AFTER  P2 finishes: '2026-08-25T12:00:00Z'
undeliveredFor(operator): []
```

Interleaving: app opens and reads `0`; a lane's `mcp-serve` opens and reads `0`; the app runs the
UPDATE and sets version `1`; a lane files a **genuine new report**; the lane's still-pending
backfill runs its UPDATE and marks that report delivered. It is never announced, and unlike the
v1 failures it is not even visibly unread — `delivered_at` set, `acked_at` NULL, sitting among 311
rows in `listReports`.

**Reachability.** `mcp-serve.ts:130` builds a fresh `ArtifactStore` **per tool call**, so every
`report`/`task_status` from every lane is a candidate second runner. The window is only until the
first successful pass on a `user_version = 0` database — but that is precisely the upgrade
moment, with lanes already running, and the live `~/.operator/artifacts.db` is at
`user_version = 0` today (checked). One-shot exposure, permanent loss of whatever it catches.

**Same class, second trigger:** a process that dies between the UPDATE and the `pragma` leaves
version `0`, so the next open re-runs the UPDATE — swallowing everything filed in the interim.
(The reverse order is safe: the UPDATE commits before the version bump, so "marked done, rows not
backfilled" cannot happen. That half is right.)

**Fix is one line** — wrap the read, the UPDATE and the pragma in a single
`db.transaction(...)`, `.immediate()` so the write lock is taken before the version is read.
`PRAGMA user_version` is journalled, so it rolls back with the UPDATE.

---

## 2. 🟠 MEDIUM — `submitQueue.submit()` never rejects, so the `catch { break }` is dead code

`DashboardView.tsx:3418-3422` wraps the submit in `try/catch` and breaks on failure, and the v2
doc's headline claim is that "a failed or skipped announce leaves the row announceable".

Half of that is true. `submit-queue.ts:394` ends the chain with
`.catch(() => { awaiting.delete(id) /* dropped submission */ })` and returns *that* promise — so
**a failed write is swallowed inside the queue and `submit()` resolves normally**. The `catch`
in the announce loop can never fire.

- **Skipped** (`canAnnounceTo` false → `break` at line 3410): row stays announceable ✅.
- **Failed / lost**: the write throws, or the closed loop later declares the submission undelivered
  via `onUndelivered` — either way `submit()` has already resolved, `artifactMarkDelivered` runs,
  and the report is never announced again.

This is v1's finding 1 narrowed rather than eliminated. It is **much less bad now**: without the
`acked_at` write the row still counts in the badge (`unreadByRole` skips only `ackedAt`), so it is
visibly unread rather than invisible. But the code and the doc both claim a protection that isn't
there. Either wire the announce loop's own handler through `onUndelivered` (which already exists
and already fires a toast), or delete the `try/catch` and say plainly that a lost line is not
recovered.

Related, same site: `await submitQueue.submit(...)` now **blocks the batch on the closed-loop
confirmation** — up to `RESCUE_AFTER_MS` (30s) per report on a watched terminal that never
confirms, so a 3-report batch can hold `announcingRef` for ~90s. Previously it was `void`ed. Not a
correctness bug (the per-report `canAnnounceTo` re-check keeps the decision fresh, and no pass can
overlap because `.finally` waits on the async `.then` body), but it is a real behaviour change
that nothing in the doc mentions.

---

## 3. ✅ Checked clean — a report inserted between backfill and the first announce pass

Traced both orderings; **no gap**, absent finding 1.

- *App-first:* `index.ts:200` constructs the store (backfill runs, version → 1) long before the
  dashboard mounts. Any report filed in that window has `delivered_at IS NULL`, and the now
  cutoff-free `undeliveredFor` returns it on the first pass.
- *Lane-first (app closed):* `mcp-serve`'s constructor runs the backfill, *then* `insertReport`
  writes a NULL `delivered_at`. The next launch sees version 1, skips, and announces it. This is
  their "RUNS ONCE" test, and it is the case v1's cutoff broke.
- *Steady state:* every later `mcp-serve` reads version 1 and returns before touching a row.

## 4. ✅ Checked clean — submit-then-mark duplicates

The only duplicate window is a crash or quit **between** the pty write and
`artifactMarkDelivered` — one repeated announcement on the next launch. That is the trade the doc
names, it is the right way round, and the window is small (submit resolves as soon as the
transcript shows the turn started, typically one tailer poll).

No other duplicate path: `announcingRef` is released in a `.finally()` on the chain whose `.then`
body is the async loop, so passes cannot overlap; `undeliveredFor` is called once per pass; a
`break` on a busy lane leaves the remainder unmarked and unfetched until the next idle.
`markReportDelivered`'s `AND delivered_at IS NULL` still makes a second mark a no-op.

---

## 5. 🟡 LOW — smaller things in the store diff

- **No test for the race, and the "RUNS ONCE" test cannot catch it** — it opens stores serially.
  A two-handle interleave test is ~10 lines and would have failed on the code as written.
- **No test for a legacy db that already has `user_version` set.** If `artifacts.db` ever acquires
  a non-zero version from elsewhere, the backfill silently skips and the replay bug returns with
  no signal. (Live db is at `0`, so this ships correctly today; `chat.db` is at `1`, which is a
  different file and a different counter — that separation is correct and worth the comment it has.)
- **The live database will not show what the doc promises.** An earlier manual patch set
  `acked_at = '2026-08-25T14:17:59Z'` on 310 of 311 rows (with `seen = 0`, a state the code cannot
  produce). So "history still shows unread and still counts" will read as **1**, not 86, on the
  user's actual db. Nothing in this branch is wrong; the expectation should just be set before
  someone reads the badge as evidence the backfill misfired.

---

## Files-view scroll — `6cf4495`

**Nothing here can break Chat, Preview or Console.** Checked rather than assumed:

- `chrome.ts` only **adds** `SURFACE_FILL`. `TOOLBAR_BAND_H` (44) and `PANEL_SUBHEAD_H` (30) are
  byte-identical, and every existing consumer imports those unchanged.
- The only components with changed markup are `FilesView`, `FilesPanel` and `FileTree`. Grep
  confirms `SURFACE_FILL` has exactly two consumers, both under `components/files/`.
- `CanvasConversation` (Chat) and `AppPreviewPanel` (Preview) already declare `height: '100%'` on
  their real roots — verified at `CanvasConversation.tsx:934` and `AppPreviewPanel.tsx:362`. They
  are listed in the new guard but not modified by it, so the guard documents existing behaviour
  rather than changing it.
- `{ ...SURFACE_FILL }` adds `height: '100%'` alongside the `flex: 1` that was already there and
  keeps `minHeight/minWidth: 0`. In a parent that *is* a flex column the height resolves against a
  definite box and is a no-op; in the block slots it is the fix. No regression path either way.
- `tabIndex={-1}` + `outline: 'none'` on the tree column stays out of the tab order and honours
  the app's no-focus-ring rule. `data-file-row` / `data-files-*` are test hooks only.

**🟡 LOW — the new guard measures the wrong element for Preview.** `chrome.test.ts`'s `rootStyle`
takes `lastIndexOf('return (')`. In `AppPreviewPanel.tsx` the last `return (` belongs to the
`Centered` helper (line 674), not to `AppPreviewPanel` (line 361). `Centered`'s root happens to
carry `height: '100%'`, so the case **passes for the wrong element**: strip the height from the
panel's real root tomorrow and the guard still goes green. The other three entries resolve
correctly (`CanvasConversation.tsx:933`, `FilesView.tsx:51`, `FilesPanel.tsx:71` are each the
exported component's only trailing return). In a file whose own comment says "a rule enforced only
by review is not enforced", a guard that silently measures a different element is worth anchoring
on the exported component's name rather than on file position.

---

## Before merge

1. **Wrap `backfillDelivered` in an immediate transaction.** Everything else is optional.
2. Either honour or drop the `try/catch` around `submitQueue.submit` — do not leave the code
   claiming a recovery the queue's own `.catch` makes impossible.
3. Anchor `chrome.test.ts`'s `rootStyle` on the exported component, not the last `return (`.
4. Optional: a two-handle interleave test for the migration, and a note that `delivered_at` is
   now mixed-format for display.
