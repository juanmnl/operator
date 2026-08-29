# Result — 0.19.0 integration: the mailbox cut AND the project scoping

Branch `operator/integrate-0.19.0`. Two new commits on top of what was already there:

    4f2e7c8  Release 0.19.0: notes come from the tag, not from the 0.17.0 story
    aac07e6  Merge operator/inbox-cut-mailbox: keep the cut mailbox AND the project scoping

**Not tagged, and no tag pushed.** The branch is ready for `electron-v0.19.0`.

## The shape of the problem

Two lanes fixed the same bug family from different bases. Design cut the mailbox and rebuilt the
surface as `CommsLog`, fixing the **read** side with `reportsOfProject`. `7f2bdd8` — on local
`main`, absent from Design's base — fixed the **write** side: `undeliveredFor` scoped by project,
and `OPERATOR_PROJECT_ID` / `OPERATOR_ROLE_ID` exported into the lane's environment so its MCP
server stamps a report from what it was launched as, rather than resolving a terminal id that
several durable sessions share. Taking either side wholesale silently drops the other.

The good news, established before resolving anything: **`chat-store.ts`, `mcp-serve.ts` and
`terminals.ts` are untouched by Design's branch**, so the whole backend half of `7f2bdd8` arrives
through the merge intact and never entered a conflict. The five conflicts are the seam and the
renderer only.

## How each conflict was resolved

### 1. `electron/src/main/ipc.ts`
Design rewrote the lifecycle comment (`acked` is cut) on the same lines where `7f2bdd8` had added
the `projectId` argument. **Both kept**: Design's comment, over `7f2bdd8`'s three-argument
`artifactUndelivered`, with the scoping rationale folded in. `artifactMarkAcked` and
`artifactMarkUnread` stay removed. `7f2bdd8`'s `projectId` / `roleId` spawn options (`ipc.ts:135`,
`:136`) were outside the conflict and survived untouched — verified, not assumed.

### 2. `src/renderer/env.d.ts`
Same shape, same resolution: Design's "THE LIFECYCLE ENDS HERE" doc comment, over the
`projectId?: string` signature. The `artifactUndelivered` doc now states what the parameter is
for. `artifactMarkAcked` / `artifactMarkUnread` stay removed.

### 3. `src/renderer/lib/inbox.ts` (modify/delete) — **stays deleted**
Its exports were checked one by one against Design's `comms.ts` before accepting the deletion:

| `inbox.ts` export | Disposition |
|---|---|
| `forProject` | **Collapsed** into Design's `reportsOfProject` — see below |
| `headline`, `reportState`, `announcement`, `CommsRow` | Already in `comms.ts` |
| `inboxFor`, `outboxFor`, `reportedBy`, `laneComms`, `unreadCount`, `unreadByRole` | Cut with the mailbox, deliberately |
| `canAnnounceTo` | **NOT duplicated anywhere — moved to `comms.ts`** |

**`forProject` and `reportsOfProject` were the same function written twice.** Truth tables are
identical (`!projectId` → everything; otherwise keep the project's rows and every null-project
row). I kept **Design's `reportsOfProject`**, because it lives in the module that survived and is
the one the surviving surfaces already call; keeping `forProject` would have meant resurrecting a
deleted file to hold a duplicate. This is the "collapse to ONE implementation" the brief asked for.

**`canAnnounceTo` is the trap in this conflict.** It came from local `main`'s inbox-delivery work,
so Design's branch — cut from `origin/main` — never saw it, and it is used three times in
`DashboardView`. It guards the *announce* path, which the mailbox cut did not touch, so it moved
into `comms.ts` next to `announcement`, the line it guards.

### 4. `src/renderer/lib/inbox.test.ts` (modify/delete) — **stays deleted**, tests ported
- The `canAnnounceTo` block moved verbatim into `comms.test.ts`.
- The `forProject` block: three of its four cases are already covered by Design's
  `reportsOfProject` tests. The fourth — "returns everything when there is no project to scope by"
  — was **only** in the deleted copy, so it was ported into Design's describe. The block's last
  case asserted on `unreadByRole`, which no longer exists; it could not be ported and was dropped
  with the badge it measured.

### 5. `src/renderer/views/DashboardView.tsx` — four hunks
- **Imports** → `announcement, canAnnounceTo` from `../lib/comms`. `InboxPanel` gone.
- **`unreadCounts` + `activeLaneProjectId`** → both removed. The memo existed only to feed the
  unread badge, which is cut.
- **The panel** → Design's: no `InboxPanel`, no `unreadCount` prop, no `inbox` tab.
- **The announce loop** → **HEAD wins whole, and this is the one place where taking Design's side
  would have been a regression rather than a merge.** Design's branch still carried
  `origin/main`'s older *mark-first* ordering. Local `main` had since replaced it with: re-ask
  `canAnnounceTo` per report off the **ref** (announcement #1 wakes the lane, so #2 and #3 were
  being pasted into a live composer), and mark delivered **after** the line actually lands, read
  from the submit queue rather than from a throw. Design only reworded that region's comments;
  they had not touched the logic. HEAD's logic was kept and the wording that named the Inbox was
  updated to the surface that replaced it.

Also: a stale comment in `chat-store.ts` pointed `markReportUnread` at `InboxPanel`'s row footer,
a component that no longer exists. Rewritten to say the method is no longer reachable and why it
is kept.

## Evidence that `7f2bdd8`'s backend half survives

Not asserted — checked in the merged tree:

- `undeliveredFor(role, limit, projectId?)` still carries `AND (project_id = ? OR project_id IS
  NULL)`, with the null-project row still passing every scope.
- `OPERATOR_PROJECT_ID` / `OPERATOR_ROLE_ID` present in all four places: written in
  `terminals.ts:193-194`, stripped for nested sessions at `:575-576`, read in `mcp-serve.ts:64-65`.
- The renderer→IPC→store chain is intact end to end: `DashboardView.tsx:3427` passes
  `tab.projectId` → `ipc.ts:186` forwards it → the store scopes on it.
- `launchOptions.roleId` survives at `DashboardView.tsx:2338` and `:2718` (the launch and restore
  paths), which is what puts the role in the lane's environment in the first place.
- `chat-store.test.ts`: **33 tests pass**, including *"the undelivered queue is scoped to the
  receiving project, and keeps unattributable rows"*.
- **Mutation-checked**: removing the `AND (project_id = ...)` clause makes exactly that test fail.
  The coverage is real, not incidental.

## The release notes

`.github/workflows/electron.yml` built the GitHub release body **and** `latest.json`'s `notes`
from *two separate heredocs*, both hardcoded to the swap story — "the app moves from Tauri to
Electron", "this is the last release the Tauri updater installs". Only `${VERSION}` interpolated.
Every 0.19.0 updater would have been told the 0.17.0 story, and the duplication is what let the
two copies drift apart in the first place.

Both now read **`electron/release-notes/<version>.md`**, carried by the tag. A missing or empty
file **fails the release** rather than falling back — silently shipping the previous release's
notes is precisely the defect being removed. What genuinely varies per release *type* (whether
the updater feeds were published) is still generated, because that is not a property of the
version.

0.19.0's notes cover: the quit-dialog freeze and the two-dialog disagreement; dev servers reaped
on lane, session and app close; the Inbox replaced by the Comms log; and reports no longer landing
in the wrong project.

Both rewritten shell blocks were **executed locally** against a fake `RUNNER_TEMP`/`VERSION` — the
body renders, `jq --rawfile` embeds the notes into `latest.json` cleanly, and the missing-file
guard fires for a version with no notes file. The workflow YAML parses.

## Version

`electron/package.json` **0.18.1 → 0.19.0**, and `electron/package-lock.json` with it (it carries
the version in two places). The gate at `electron.yml:150` reads only that file; simulated against
it, `electron-v0.19.0` passes as stable, `electron-v0.19.0-rc.1` passes as a prerelease, and a
stale `electron-v0.18.1` is correctly refused.

**Left alone, deliberately:** root `package.json` still says `0.16.0`. It has been stale since the
Electron move, nothing in the release path reads it (the only `require(...).version` in the repo
points at `electron/package.json`), and quietly bumping an unrelated version during a merge is not
a change to make without being asked. Flagging it rather than fixing it.

## Verification

```
electron:  typecheck                    clean
electron:  vitest run                   23 files, 415 tests passed
root:      tsc --noEmit                 clean
root:      vitest run                   33 failed / 987 passed  (baseline 33 failed / 956)
root:      npm run build                built in 1.89s
```

Root failures are **exactly the briefed baseline of 33**, in the same five pre-existing suites —
`forgotten-projects`, `ghost-probe`, `lane-accents`, `rail-foot`, `terminal-options` — all failing
on `Cannot read properties of undefined (reading 'clear')`, a jsdom `localStorage` problem. Zero
new failures. Passing count went from 956 (baseline) / 962 (Design alone) to **987**, which is
both branches' tests present and green.

## Ready to tag

`git tag electron-v0.19.0 && git push origin electron-v0.19.0` — yours to run. Not done here.
