# Brief — the lifecycle leak: 46 live sessions, 0 ended, 16 tasks stuck running

Measured from durable state, not the UI (`~/.operator/sessions.json`, `projects.json`). **Read the
files yourself before changing anything** — the roster UI misreports these counts, so don't trust it.

## The evidence

```
live sessions: 46     ended sessions: 0        ← nothing ever closes

duplicates in the "operator" project, per roleId:
  5× operator   5× research   4× code   3× design   3× qa   3× review

operator project tasks:  126 done · 16 running · 8 null-status
dispatches:              100 total — 77 from operator, 16 research, 3 design, 2 code, 2 qa
```

Three independent bugs. Fix them in this order; each is separately shippable.

---

## 1. Sessions never reach `ended`

`core.rs:297` can produce `"ended"`, but `sessions.json` holds **zero** ended records across 46
sessions, so whatever sets it never fires in practice — or the persisted copy is written from a path
that always says `active`. Find out which, and report the actual mechanism before fixing it.

Requirements:
- A session whose pty is gone must reach `status: 'ended'` and stay there across restart.
- **Never infer `ended` from phase or from silence.** A lane thinking for 20 minutes is not ended.
  Base it on the pty/terminal actually being gone.
- **NEVER pattern-kill processes** to reconcile this (house rule). Read state; don't sweep.

## 2. Duplicate lanes — the direct cause of "unanswered stuff in each lane"

A dispatch resolves its target by building a `roleId → terminal` Map
(`DashboardView.tsx`, the `byRole` pattern). With four `code` sessions carrying `roleId: 'code'`,
**one wins and three are orphaned** — still live, still holding whatever they were last sent,
permanently unreachable. Work went into them; answers came back where nothing was looking.

There is an in-flight launch guard at `DashboardView.tsx:1205`, but it only covers the
launch-takes-seconds window — it does not prevent a *second* lane for a role that already has a live
session, which is what actually happened five times over.

Requirements:
- Launching a role that already has a **live** session for that role must **focus/reuse** it, not
  spawn another. This is the real guard; the in-flight one stays as-is.
- Make the `roleId → terminal` resolution **deterministic and explicit** rather than last-write-wins.
  If duplicates somehow exist, prefer the most recently active and say so in a comment.
- **One-time reap on hydrate**: mark orphaned duplicate sessions `ended` (keep the live one per
  role). Do it as an idempotent, content-sniffing migration in the style of
  `migrateLegacyCoordinator` (`lib/roster.ts:49-70`) — early-bail when there's nothing to do.
  **Only reap a session whose pty is confirmed gone.** If liveness can't be confirmed, leave it.
- Back up `sessions.json` before the first reap writes (same pattern as `~/.operator/backups/`).

## 3. Tasks stuck `running` forever

16 tasks are `running`, including every dispatch sent today — most of which finished and wrote their
result file. Known cause on record: a task is stamped with a `terminalId` that goes **stale on
restart**, while the roleId fallback in the matcher requires `!terminalId`, so a stamped-but-stale
task can never match again and is unclosable.

`reconcileStaleRunning` exists (`lib/task-lifecycle.ts:60`) — determine why it doesn't catch these.

Requirements:
- A task whose stamped `terminalId` no longer exists must fall back to roleId matching. Removing the
  `!terminalId` precondition is the obvious fix — verify it doesn't cause cross-matching between two
  tasks of the same role.
- Reconcile the existing 16 on hydrate. A task whose lane is gone becomes `done` or a new
  `abandoned` state — **your call, but state it**: silently marking unfinished work `done` is a lie,
  and leaving it `running` forever is the current bug.
- The roster chip must not label a total as `N QUEUED` when the number includes running and done
  (recorded defect). Count and label each status honestly.

---

## Explicitly out of scope

- Agent-to-agent reply delivery (`dev/briefs/agent-to-agent-delivery.md`) — **held deliberately
  behind this work.** Do not start it.
- Do not touch `src-tauri/src/{chatstore,transcript,lib}.rs`'s reply-sentinel additions. They're
  unreviewed and separately queued.

## Verify

- `npm test` + `cargo test` + `npm run build` green.
- Unit tests: a session with a dead pty reaches `ended`; a live-but-idle session does **not**;
  launching a role twice yields one session; a task with a stale `terminalId` reconciles via roleId;
  the reap migration is idempotent (running it twice changes nothing).
- **Against the real store, read-only first**: report how many of the 46 sessions and 16 tasks your
  logic would reap, and what it would leave, *before* any write. Include those numbers in the result
  file. If it would reap more than ~43 sessions, stop — something is wrong.
- Confirm the 3-4 genuinely reachable lanes survive.

## Write your result to

`dev/briefs/fix-session-task-lifecycle-RESULT.md` — the mechanism found for each bug, the
before/after counts, and the decision you made on abandoned-vs-done.
