# Adversarial review — inbox launch-cutoff + ack-on-announce (`operator/51cf00` @ `ceb8b90`)

**Reviewed:** `electron/src/main/chat-store.ts`, `electron/src/main/ipc.ts`,
`electron/src/main/chat-store.test.ts`, against `dev/results/inbox-replay-fix.md`.
**Also read for context** (unchanged by the diff, but the change's blast radius):
`electron/src/main/mcp-serve.ts`, `electron/src/main/index.ts`, `src-tauri/src/mcp.rs`,
`src/renderer/views/DashboardView.tsx` (announce pass), `src/renderer/lib/inbox.ts`,
`src/renderer/lib/submit-queue.ts`, and the live `~/.operator/artifacts.db` (read-only copy).

## Verdict: **MERGE THE CUTOFF, REVERT THE ACK-ON-ANNOUNCE HALF.**

The launch cutoff (finding 0 below) is correct and fixes the reported bug. The `acked_at` half —
`markReportAnnounced` and `computeAnnounceCutoff`'s `MAX(acked_at)` — buys **nothing** the diff
does not already have, and pays for it with two ways a genuine report is silently lost forever.
Do not merge it as written.

---

## 0. What works (so silence here isn't ambiguous)

- **The reported bug is really fixed.** Live db: 311 rows, `min(at) = 2026-08-06T01:20:13Z`,
  86 with `delivered_at IS NULL`. With `at > announceCutoff` every one of those 86 is below a
  present-day launch time, so the replay stops. Verified against the real data, not just the tests.
- **`listReports` is untouched** — no cutoff, no backfill, nothing deleted. The Inbox still shows
  all 311. The doc's claim holds.
- **`to_role = ? OR to_role IS NULL`** is unchanged and still correct: neither MCP path
  (`mcp-serve.ts:141`, `src-tauri/src/mcp.rs:192`) ever passes `toRole`, so every report is
  coordinator-addressed and none is orphaned by the new clause.
- **Test hygiene is fine.** `SANDBOX` is `mkdtempSync` per run (`chat-store.test.ts:8`), so the
  fixed db filenames (`cutoff.db`, `announce-ack.db`, …) do not accumulate rows across runs.
- **`ORDER BY id ASC` vs. `at > ?`** cannot disorder in practice — both writers stamp `at` at
  insert time on the same clock, so id order and `at` order agree.

---

## 1. 🔴 HIGH — an announcement that never reaches the lane is marked **read**, and cannot be recovered

`chat-store.ts:272-276` (`markReportAnnounced`), reached from `ipc.ts:174`.

`DashboardView.tsx:3407-3414` marks **before** it submits, deliberately — but the mark is now
`delivered_at` **and** `acked_at` **and** `seen = 1`. The submit that follows is `void`ed and can
genuinely fail: `submit-queue.ts` has a whole closed-loop confirmation path ending in
`onUndelivered` (line 362) precisely because a paste+CR into a busy Ink composer gets swallowed.

**Failure scenario, and it is the common case, not the exotic one.** The pass drains three at a
time. Announcement #1 lands and *starts a turn*. The phase guard (`session.phase !== 'idle' &&
!== 'waiting'`, line 3401) was evaluated **once**, before the `await`, so #2 and #3 are now pasted
into a lane that is mid-turn — exactly the state the memory note "a prompt typed into a mid-turn
lane leaves only `queue-operation: enqueue`, never a `user` turn" describes. All three rows are
already `delivered_at` + `acked_at` + `seen = 1`.

Result: reports #2 and #3 are (a) gone from the announce queue forever (`delivered_at IS NOT
NULL`), (b) gone from the unread badge — `unreadByRole` (`inbox.ts:168`) skips any row with
`ackedAt` — and (c) indistinguishable in `listReports` from the 310 rows of history. Under the
**old** `markReportDelivered` they would at least still have shown in the badge.

**And the documented recovery does not work.** Both the code comment (`chat-store.ts:271`) and the
result doc say "`markReportUnread` puts the mark back if the announcement was never actually
read." `markReportUnread` (line 286) sets `acked_at = NULL, seen = 0` — it does **not** clear
`delivered_at`. So Mark-unread restores the badge and *never* restores announceability. The claim
in the comment and in the doc is false as written.

*Mitigation that exists:* `reportUndelivered` (`DashboardView.tsx:1368`) fires a sticky toast. It
does not un-mark the row, and it matches against `project.dispatches` — an announcement has no
DispatchRecord, so only the toast fires, with no record and no way back.

---

## 2. 🔴 HIGH — a single future-dated `acked_at` permanently and silently disables the announce queue

`chat-store.ts:230-234` (`computeAnnounceCutoff`).

`announceCutoff = max(launchedAt, MAX(acked_at))`, and `MAX(acked_at)` is read from a column that
is now written on **every announce**, is written by **manual db edits** (see below), and is never
bounded or sanity-checked against the current time.

**Failure scenario.** The Mac's clock is ahead — a wrong RTC before NTP settles at boot, a
timezone/`SystemTime` glitch, or the user hand-patches the db. One report gets
`acked_at = 2027-01-01T…`. From that launch onward, **every** launch computes
`announceCutoff = 2027-01-01`, `at > cutoff` is false for every real report, and the coordinator
is never announced anything again. Nothing in the UI says why. There is no reset, no clamp, no
log line — the only fix is Mark-unread on the exact poisoned row (which the human has no way to
identify) or editing SQLite by hand.

**This is not hypothetical on this machine.** The live `~/.operator/artifacts.db` already carries
a manual patch: all 310 legacy rows share `acked_at = '2026-08-25T14:17:59Z'` with `seen = 0` —
a combination the code cannot produce (`markReportAcked` sets `seen = 1`). So `MAX(acked_at)` is
*already* a hand-written value on the box this ships to. It is benign today only because it is in
the past.

**The clause is also unnecessary.** The comment justifies it as "an announced report has to raise
that bar itself or the next launch starts below it" — but `undeliveredFor` already filters
`delivered_at IS NULL`, and `delivered_at` persists across restarts. An announced report is
excluded on the next launch by `delivered_at` alone, cutoff or no cutoff. The test at
`chat-store.test.ts:143-158` ("acks on announce, so a restart does not re-announce") passes
identically with the `acked_at` write removed — it does not isolate what it claims to test.

Net: `MAX(acked_at)` protects against nothing, and creates a permanent silent lockout.
`MAX(delivered_at)` would be the defensible watermark if one is wanted at all, and it carries no
"a human opened this" meaning to destroy.

---

## 3. 🟠 MEDIUM — reports filed while the app is down are permanently, silently unannounceable

`at > announceCutoff` with `announceCutoff ≥ launchedAt` means **any** report written between one
shutdown and the next launch is dropped from the queue forever. The doc frames this as "history is
not news", which is right for the 310-row backlog and wrong for a five-minute gap.

**Reachability.** `mcp-serve.ts` is a short-lived process spawned by Claude Code, not by the app
window. Any `claude` session the user runs in their own terminal with the `--mcp-config` — a
review lane, a `claude -p` script, a session that outlives the app — can call
`mcp__operator__report` with the app closed. The report lands in the table and the next launch
suppresses it. The lane is told "queued for the coordinator's Inbox and will be marked delivered
when it is shown there" (`mcp-serve.ts:150`), which is then untrue.

The 1.1–1.2GB renderer respawn does *not* trip this (the store lives in main), but an auto-update
restart or a crash does.

**The narrower fix the doc rejected is the safer one:** a one-time
`UPDATE reports SET delivered_at = <migration time> WHERE delivered_at IS NULL` at the moment the
column is added targets exactly the 310 rows that are actually pre-migration, and leaves every
future report announceable regardless of when the app happens to be running. The doc declines it
to preserve the "nobody ever read this" mark — but that mark lives in `acked_at`, not
`delivered_at`, and finding 1 shows this diff destroys `acked_at`'s meaning anyway.

---

## 4. 🟡 LOW — mixed timestamp formats: checked, direction is benign today, and one flip makes it a bug

The brief's suspicion is real — the table genuinely holds two formats — but the harm direction is
the opposite of the one feared, so **this is not currently a defect**. Recording the analysis so it
isn't re-derived:

- `src-tauri/src/mcp.rs:79-103` (`now()`) emits **second** precision: `…T14:20:25Z`, 20 chars.
- `electron/src/main/mcp-serve.ts:132` and `ipc.ts` emit `new Date().toISOString()` — **millisecond**
  precision, 24 chars.
- Live db confirms: 310 rows at length 20, 1 at length 24; `MAX(acked_at)` is length 20.

Byte-wise at index 19, `'Z'` (0x5A) > `'.'` (0x2E), so within the same second the seconds form
always sorts **above** the ms form. `at` is compared against a cutoff that is ms-form (launch) or
seconds-form (the patched acks). Worst case is ±1 second of **over**-inclusion — an extra
announcement, never a suppressed one. Harmless.

**It flips if** anyone ever writes `acked_at`/`delivered_at` from the Rust side, normalises one
writer to seconds, or introduces an offset form (`+00:00`, where `'+'` < `'.'` and the comparison
*does* suppress). The comparison is a raw SQL string `>` on a column with no format invariant and
no comment saying one is required. Worth a normalising helper or at least a note at line 233.

---

## 5. 🟡 LOW — smaller things

- **`seen` is write-only.** `markReportAnnounced` sets `seen = 1`; nothing anywhere reads the
  column or the `reports_seen` index (`chat-store.ts:201`) — `unreadByRole` and `reportState` both
  go through `ackedAt`. Adding a third write to a dead column widens the number of places a future
  reader has to reconcile.
- **The production constructor path is never tested.** Every new test passes `launchedAt`
  explicitly; the `= new Date().toISOString()` default — the only form `index.ts:200` uses — has
  no coverage.
- **No test covers a failed announce.** The one behaviour the change makes strictly worse (finding
  1) has no case asserting anything about it.
- **`computeAnnounceCutoff` runs in `mcp-serve.ts` too** — `new ArtifactStore()` per tool call
  (line 130) now adds a `MAX(acked_at)` scan alongside the existing per-call `migrateReports()`
  `ALTER TABLE` attempts. Negligible at 311 rows; noted because the constructor is on a hot path
  it was not obviously written for.
- **The clock-skew test asserts the lockout as correct.** `chat-store.test.ts:130-141` documents
  "the bar is whichever is higher, never the lower one" as intended behaviour, which is how
  finding 2 ships as a feature.

---

## What I'd ask for before merge

1. Revert `ipc.ts:174` to `markReportDelivered`; drop `markReportAnnounced`, or keep it writing
   only `delivered_at`. The badge trade-off the doc flags is not a trade-off worth taking — it is
   what makes findings 1 and 2 unrecoverable.
2. Drop `MAX(acked_at)` from `computeAnnounceCutoff` (or clamp any watermark to `≤ now`, and read
   it from `delivered_at`).
3. Fix the false recovery claim in the `markReportAnnounced` comment and the result doc, or make
   `markReportUnread` clear `delivered_at` too so the claim becomes true.
4. Move the phase guard inside the announce loop (`DashboardView.tsx:3409`) so #2 and #3 are not
   pasted into a lane that #1 just made busy. Out of this diff's scope, but this diff is what
   makes the consequence permanent.
5. Consider the one-time `delivered_at` backfill instead of a time cutoff, which closes finding 3
   as well.
