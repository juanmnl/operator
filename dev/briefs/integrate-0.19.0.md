# Brief — Integrate the Inbox rework onto 0.19.0, without dropping 7f2bdd8

## Where things stand
Branch `operator/integrate-0.19.0` (pushed) already contains, cleanly, with ZERO
conflicts:
1. local `main`'s 11 unpushed commits (Inbox delivery work, Files view, orbs
   and twinkle perf)
2. `origin/main` @ `d22538b` (0.18.1, including both updater fixes)
3. `operator/reap-dev-servers` — your reap + quit-freeze fix

## What is left, and why it is delicate
Merging `operator/inbox-cut-mailbox` into it conflicts in **5 files**:

    electron/src/main/ipc.ts
    src/renderer/env.d.ts
    src/renderer/lib/inbox.test.ts
    src/renderer/lib/inbox.ts          (modify/delete)
    src/renderer/views/DashboardView.tsx

The cause is that **two lanes fixed the same bug family independently, from
different bases**:

- **`7f2bdd8`** (on local main, so it is IN the integration branch) —
  "Inbox: scope the report queue to the receiving project, and stamp the caller
  from its own env". Touches 10 files. Its BACKEND half is the part at risk:
  `chat-store.ts` (`undeliveredFor` filtered on `to_role`, which is NULL on all
  318 rows, so the queue was global and the first idle coordinator DRAINED it —
  `markReportDelivered` stamps exclusively, so that is a steal, not a duplicate)
  and `mcp-serve.ts` + `terminals.ts` exporting **`OPERATOR_PROJECT_ID`**,
  because terminal ids restart at t0 each run while sessions.json is durable, so
  `t2` matched four rows and `find` took the first.
- **`operator/inbox-cut-mailbox`** (Design, cut from `origin/main`, so it does
  NOT contain `7f2bdd8`) — deletes `src/renderer/lib/inbox.ts` entirely, folds
  the surface into `CommsLog`, and independently fixes the FRONTEND half with
  `reportsOfProject` (which deliberately KEEPS rows with no projectId rather
  than dropping them).

**I verified `OPERATOR_PROJECT_ID` appears in 0 files on Design's branch.** So a
naive "take Design's side" resolution silently deletes a whole backend fix. That
is the exact failure this project has been bitten by before — a merged change
that was never actually built.

## What you must do
1. Merge `operator/inbox-cut-mailbox` into `operator/integrate-0.19.0`.
2. Resolve so that **BOTH survive**:
   - Design's renderer wins: `inbox.ts` stays DELETED, `CommsLog` is the
     surface, the mailbox stays cut. Do not resurrect `unreadCount`,
     `unreadByRole`, ack-on-open, mark-unread or the unread dot.
   - `7f2bdd8`'s backend survives INTACT: `chat-store.ts`'s `undeliveredFor` /
     `markReportDelivered` scoping, and `OPERATOR_PROJECT_ID` through
     `mcp-serve.ts` and `terminals.ts`.
   - `ipc.ts` and `env.d.ts` are the interface seam between them — reconcile so
     the surviving renderer calls the surviving backend. Design also removed
     `artifactMarkAcked` / `artifactMarkUnread` from env.d.ts, the Tauri bridge,
     the Electron SPEC table and its IPC handler; keep them removed.
3. **PROVE the backend fix still works after your resolution.** Do not assert
   it — `7f2bdd8` shipped tests in `chat-store.test.ts`; they must still pass,
   and if the resolution changed the shape, adapt them rather than deleting
   them. If project scoping ends up covered twice (once per lane), collapse to
   ONE implementation and say which you kept and why.

## Then finish the release prep on the same branch
4. **Fix the stale release notes.** `.github/workflows/electron.yml` (~line 236)
   builds the GitHub release body AND `latest.json`'s `notes` field from a
   heredoc hardcoded to the 0.17.0 story — "the app moves from Tauri to
   Electron", "this is the last release the Tauri updater installs". Only
   `${VERSION}` interpolates. Every 0.19.0 updater would read that. Make the
   notes come from a per-release source (a file in the repo the tag carries is
   fine) and write 0.19.0's actual notes: the quit-dialog freeze fix, dev-server
   reaping on lane/session/app close, and the comms surface replacing the Inbox.
   Keep it short — it is a release body, not a changelog.
5. **Bump `electron/package.json` to `0.19.0`.** CI hard-fails if the tag
   version and that file disagree, and a stable tag refuses a prerelease package
   version. Check whether any other file carries the version and bump it too.
6. Do NOT tag and do NOT push a tag. The user approves the publish.

## Verify before reporting
- `electron`: typecheck + full suite (was 404 passing on your reap branch)
- root: `npx tsc --noEmit` + `npx vitest run`. Baseline is **33 failed / 956
  passed** at `d22538b`; Design's branch alone is **33 failed / 962 passed**.
  I measured both myself. Anything beyond 33 failures is yours to fix.
- `npm run build`

## Deliverable
`dev/results/integrate-0.19.0.md`: how you resolved each of the 5 conflicts, the
EVIDENCE that `7f2bdd8`'s backend half survives, what the release notes now say,
and the final test numbers. Report when the branch is ready to tag.
