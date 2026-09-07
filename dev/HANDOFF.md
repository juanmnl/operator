# Handoff — 2026-09-06

**`main` = `2418772`, pushed. 0.21.0 is PUBLISHED and LIVE** (tag `electron-v0.21.0`, run
34067520738 green: `test` + `release`). Verified: the swap feed's `latest.json` serves **0.21.0**
with the new notes; the `juanmnl/operator` release is `draft:false` with `Operator-0.21.0-arm64-mac.zip`,
`Operator.app.tar.gz` + `.sig`, `latest-mac.yml`, `latest.json`. Every 0.20.0 install will be offered it.

Final gates on `main`: renderer **1141 / 0**, electron **536 / 0**, cargo **197 / 0 (3 ignored)**,
root `tsc`, electron typecheck, electron build all clean. The 33 "pre-existing" renderer failures
every earlier handoff carried are gone: they were Node 26 shadowing jsdom's `localStorage`
(`src/test-setup.ts`), not code defects.

**⚠ THE ONE THING TO DO FIRST: nothing in 0.21.0 has been seen rendered by a person.** Two Review
passes and two QA passes (Playwright + the dev/qa-real bridge) covered it; no human opened a real
window. Look at, in this order: the session toolbar's model/effort chips (enabled only between
turns), the Dev servers panel in Worktrees preferences (every row a confirm-gated kill), the
Tuning page (plan-meter footer link, ⌘K "Tuning", rail foot), the session bottom bar's context and
plan cells, and the rail's ⋯ close on a project row. Clean path back is `git revert 2418772` + a
`0.21.1` tag, or a targeted revert of the merge commits below.

## What 0.21.0 is: the app narrowed to the landing's meaning

Direction set 2026-09-05 (`memory: project_simplify_direction`, hub note): open a project, launch
sessions for specific work, hand work between agents, tune each lane's model and effort so plan
limits are approached and never hit. Chat and Files were unused and went.

Merge commits on main, in order: `b521fc6` (the simplify batch, branch `operator/e78fc0`),
`5bdf083` (`operator/dispatch-bus`), `cc536be` (`operator/plan-bar`).

1. **Chat + Files removed** from both shells (−5,100 lines, 25 files, `@codemirror/*` dropped, ⌘J
   unbound). Survivors that look like chat and must stay: `chat-signal.ts` (task board + quit
   guard), `chatstore` write path (Comms log), the tailers. `chat.db` is read again by the Tuning
   page's tool-output stats.
2. **Port allocation** (`electron/src/main/port-alloc.ts`, `port-probe.ts`): bind check on v4+v6,
   lease check, serialized allocations, same-cwd sharing only when `provesOwnServer` (deep process
   matching `DEV_SERVER_RE` + a lease) — fails closed. The real cause of the 2026-09-05 double
   allocation was the release path: `shouldReleaseCwdPort` now keeps a shared reservation while a
   sibling holds it.
3. **Orphan reaper** (`dev-servers.ts`): lane close reaps reparented servers (pinned by test); a
   10-minute sweep with the boot sweep's three gates + shape filter; a Dev servers list by owner
   class (`dead-app` / `abandoned-lane` / `untagged` / `live-lane`), confirm-only, no select-all.
4. **Settings prune**: per-project Effort Level field removed. `compacting` phase is now emitted
   (both tailers, cleared on the next real main-thread record, 5-minute ceiling).
5. **Remote Control per role**: every per-session settings file writes `remoteControlAtStartup`
   explicitly (flag scope outranks the user's settings.json; unset = org default = ON, which is why
   the phone listed every lane). On for `operator`, off otherwise, per-role toggle on the roster;
   session named `<project> · Operator` via `--remote-control`. Verified against claude 2.1.261.
6. **Tuning page** (`src/renderer/lib/tuning.ts`, `electron/src/main/tuning.ts`): design in
   `dev/results/usage-view-design.md`. Capture added: `effort` per assistant record, compaction
   count + tokens re-read, per-session context stats, tool output p50/p90 from chat.db.
7. **Bottom bar** (`.actions-footer` in DashboardView; `SessionInfoBar.tsx` was dead and is
   deleted): `ctx used / window ↺n`, `Model · Effort`, `Session % Week % <Model> %` with the
   binding limit marked. Context comes from the latest main-thread assistant record (sidechain
   excluded); window inferred from a `[1m]` pin or observed context > 200k. Rail foot ring removed;
   text-only reading there when no session is active.
8. **Auto-close**: a `report` counts as done (lanes call `report` ~130× more than `task_status`).
9. **Close from the rail**: ⋯ trigger on the project row, closing state on the tile, confirm keyed on
   action identity.
10. **Dispatch/reply over the session bus**: MCP tools `dispatch` and `reply` (bare names; Claude
    Code prefixes `mcp__operator__`). The server asks the app for a verdict through a request/verdict
    row in the artifact store (15s), the app applies route → authority gate → hop brakes, and the
    LANE sends via native `SendMessage` to `uds:/tmp/cc-socks/<pid>.sock` (matched by sessionId from
    `~/.claude/sessions/<pid>.json`). Both tailers record the `SendMessage` tool_result as the
    delivery outcome (send book keyed by sender + address). Sentinels still work this release.
    **Not run end to end between two live lanes** — the first real dispatch from a 0.21.0
    coordinator is the test. Spike: `dev/results/session-bus-spike.md`.

## Gotchas learned this cycle
- **Briefs are invisible in a fresh lane worktree unless COMMITTED to main first.** Untracked
  `dev/briefs/*` never reach the lane. Commit, then dispatch.
- **QA and Code shared one worktree**; a `git add -A` swept a 431KB real chat history into a commit.
  Purged from history before any push; `dev/*fixture*.json` is gitignored. Explicit paths only.
- **One dispatch per idle lane**: the second is dropped silently. Queue the rest after it reports.
- The coordinator can merge/push when the user types the command or sets `/goal`; an unprompted
  `git merge` was blocked by the permission classifier once.
- The long-running 0.20.0 process showed a "Diff unavailable" panel whose copy exists nowhere on
  disk: a stale in-memory renderer bundle. Fully quitting clears it (`dev/results/diff-panel-unavailable.md`).
- `phase === 'idle'` is never emitted by the tailers (only running/compacting/waiting); fixtures
  that hardcode `idle` validate nothing.

## Open
- GUI pass by a person (above). Bus dispatch end to end.
- Deferred Review lows on the batch: `devServerKill` pid cross-check, `\b<port>\b` log regex,
  `chat.db` purge policy, two kill-list cosmetics. Six comments still name the deleted `PlanMeter.tsx`.
- Rust keys `portsByCwd` on the canonical cwd, Electron on the raw string (sharing granularity).
- `dev/drive-close-project.mjs` retired/rewritten? Check `dev/results/pass-3-and-close-features.md`.
- Landing (`~/Developer/Operator-landing`) cell 07 now matches the app again; cells 06–09 should
  be re-read against 0.21.0's actual screens once seen.
