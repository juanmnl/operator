# Report announce fix — 2026-10-02

Code lane, branch `operator/424580`, commit `c0ab77f`. Implements items 1-5 of "Proposed fix" in
`dev/results/lane-signal-back-research-2026-10-02.md`. Item 6 (match the session by `claudeSessionId`)
was not done; see "Left out".

## Changes

### 1. Every idle coordinator is served on each pass (D1)

- `src/renderer/lib/comms.ts:266` `announceSkip(tab, sessions, inFlight)` returns why a tab is not served
  (`not a coordinator`, `no session`, `phase <phase>`, `phase ended`, `in flight`) or `null`.
- `src/renderer/lib/comms.ts:287` `coordinatorsToAnnounce(terminals, sessions, inFlight)` is the pure
  selection: every tab for which `announceSkip` is `null`. The between-turns gate is still `canAnnounceTo`.
- `src/renderer/views/DashboardView.tsx:4364` replaces the app-wide `announcingRef` with
  `announceInFlightRef`, a `Set` of tab ids. `announcePass` (`:4440`) serves every selected coordinator
  in parallel; each one's entry is removed in `finally`. The trailing `break` is gone.
- `serveCoordinator` (`:4374`) is the old per-coordinator body. The per-report re-check of
  `canAnnounceTo` off `sessionsRef` and the "mark only after `pending(tab.id)` cleared" rule are unchanged.

### 2. The pass re-runs on report arrival and on a 5 s timer (D2)

- `DashboardView.tsx:4459` `newestReportId` (max id in the 4 s `reports` poll) is in the effect deps
  with `terminals` and `sessions`, so a new report triggers a pass.
- `DashboardView.tsx:4464` a `setInterval(announcePass, ANNOUNCE_TICK_MS)`; `ANNOUNCE_TICK_MS = 5_000`
  at `comms.ts:298`. The pass reads `terminalsRef`/`sessionsRef`, so the timer causes no re-render.
  Renderer timers resume after sleep, so the first tick after a wake catches up.

### 3. Expiry types one summary line instead of dropping silently (D3)

- `electron/src/main/chat-store.ts:474` `staleUndeliveredFor(role, before, projectId)` replaces
  `expireUndelivered`. Same filter (role addressees, project scope, `NULL` project passes, no project
  returns nothing), but it only reads.
- IPC `artifactExpireUndelivered` is replaced by `artifactStaleUndelivered`
  (`electron/src/main/ipc.ts:211`, `electron/src/shared/operator-api.ts:91`, `src/renderer/env.d.ts:67`,
  `src/operator-bridge.ts:205` returns `[]` on Tauri).
- `comms.ts:309` `staleSummary(reports)` builds the line, for example:
  `[Operator] 3 reports older than 12 h were not announced while you were busy or away: review #1788; design #1789 #1792 — full text in the Comms log`.
  Grouped by lane, oldest id first, at most 20 ids (`STALE_SUMMARY_MAX_IDS`, `comms.ts:301`) then
  "and N more".
- In `serveCoordinator` the summary is typed through `submitQueue.submit`; if it is unconfirmed the
  stale rows stay undelivered, otherwise each is marked delivered with `artifactMarkDelivered`. Then the
  normal queue of up to 3 is announced as before.
- The "N older reports were not announced" toast is removed: the coordinator is now told directly, and
  the toast text would no longer be true.

### 4. Announce log

- New `electron/src/main/announce-log.ts`: `logAnnounce(line)` appends to
  `~/.operator/logs/announce.log` (`$OPERATOR_DIR/logs/announce.log`), serialised, trimmed to the newer
  half past 512 KB, never throws. Wired as the `send` method `announceLog` (`ipc.ts:500`,
  `operator-api.ts:92`, `env.d.ts:69`; no-op in `operator-bridge.ts:257`).
- `DashboardView.tsx:4367` `noteAnnounce` writes
  `tab=<id> role=<role> project=<name> <what>`, where `<what>` is either
  `skip=<reason>` for a coordinator that was not served, or
  `stale=<n>[ summarised=#a,#b] pending=<n> outcome=<nothing pending | announced=#x,#y[ stopped=…] | summary unconfirmed… | error …>`.
  A line identical to the previous one for the same tab is not repeated, so an idle coordinator with
  nothing pending logs once, not every 5 s. `not a coordinator` and `in flight` skips are not logged.
- A coordinator tab with no project shows as `project=none ... pending=0`; that answers the open
  question in the research about whether the X3 no-project branch fires.

### 5. Report tool wording

- `electron/src/main/mcp-serve.ts:281` now says a line announcing the report is typed into the
  coordinator the next time it is between turns, the report is marked delivered once that line has
  gone in, and the full text stays in the project Comms log. The "Inbox" mention is gone.

## Tests

- New `src/renderer/lib/comms.test.ts` cases: three idle coordinators all served; one mid-turn and one
  in flight left out while the third is served; non-coordinator, ended and session-less tabs never served;
  `announceSkip` reasons; `staleSummary` grouping/order, singular form, terminal fallback, id cap.
- `electron/src/main/chat-store.test.ts`: the expiry test now checks that `staleUndeliveredFor` lists
  only old rows of the project, does not mark them, and that `markReportDelivered` removes them from the
  queue; the no-project and `orchestrator` alias tests use the new method.
- New `electron/src/main/announce-log.test.ts`: path, line order, newline flattening, size cap.

Results:

```
renderer  npx tsc --noEmit -p tsconfig.json          clean
electron  npm run typecheck (main + renderer config)  clean
renderer  npx vitest run      Test Files 112 passed (112)   Tests 1670 passed (1670)
electron  npm test            Test Files  46 passed (46)    Tests  804 passed (804)
```

## Needs GUI verification (not done here)

1. With two or more coordinator tabs idle in different projects, file a report from a lane in the
   project whose coordinator is later in the tab list. It should be announced within about 5 s, without
   touching any other tab.
2. A report filed while its coordinator is already idle should arrive within about 5 s (previously it
   waited for an unrelated session update).
3. Stale summary: in an isolated `OPERATOR_DIR`, insert an undelivered report with `at` older than 12 h
   for a project, open its coordinator; it should receive one summary line and the row should get a
   `delivered_at` only after that line is submitted.
4. `~/.operator/logs/announce.log` exists after a pass and shows skip reasons and outcomes per tab. Check
   it does not grow quickly with several busy coordinators (expected: a couple of lines per coordinator
   turn).
5. Sleep the Mac with a pending report and an idle coordinator; after wake it should be announced on
   the first tick.
6. The current backlog (41 undelivered at research time, many over 12 h old) will be summarised in one
   line per project coordinator on the first pass after this ships. That is intended, but expect it.

## Left out, and risks

- Item 6 of the research (match session by `terminalId` + `claudeSessionId`) is not done; the stale-row
  case was not confirmed. The new log's `skip=phase …` lines for a coordinator that is visibly idle would
  confirm it.
- An announcement that stays unconfirmed (no user turn seen within the submit deadline) while the lane
  still reads as between turns is retried on the next pass, now at most every ~35 s (5 s tick + 30 s
  deadline) instead of on the next session change. This was already possible before (sessions change
  about once a second with other lanes active); a per-tab backoff after an unconfirmed outcome would
  bound it if the log shows it happening.
- `lib/comms.ts` now imports `COORDINATOR_ROLE_IDS` from `lib/dispatch.ts`, which imports
  `isBetweenTurns` from `comms.ts`. Both uses are at call time, so the cycle is harmless; typecheck and
  both suites pass.
- Recommend a Review pass (as the research suggests): this effect gates every coordinator in every project.
