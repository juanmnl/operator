# Renderer leak fix (2026-10-26)

Branch `operator/95280`, from main `4f330e0`. Not merged.

- `61ad42d` Stop session events from chaining retained DashboardView renders (the brief's items 1 to 4).
- `0ac83f5` Keep project traffic from chaining retained renders too (beyond the brief's list; separate so it can be dropped).

Background: `renderer-leak-measurement-2026-10-25.md`, `renderer-leak-live-lanes-2026-10-26.md`.

## Result

- Every `useCallback` in DashboardView that listed `sessions`, `terminals`, `sessionLayouts`, `savedSessions` (or a value rebuilt from them) in its deps now reads that state through a ref. Session events no longer recreate any memoised callback. The one exception is `identifyQuitLane`, left as it was on purpose (see below).
- The sidebar entries are built in `lib/sidebar-sessions.ts` with a per-lane cache. An unchanged lane keeps one entry object across renders.
- The two persist effects keep a fingerprint of the last JSON they wrote instead of the JSON itself.
- A source-pin test fails on the old DashboardView (15 of 16 cases), with unit tests for the builder and the fingerprint.
- Root and electron typechecks and test suites pass (output below).
- Not measured on the real app. A toy model under vitest with forced GC shows that the brief's change alone stops the chain only when no other two sets of callbacks are recreated at different moments. In the app, `projects` changes from dispatch and task traffic between lane switches would keep the chain growing at about the old rate, and QA's earlier 2 h workload had no such traffic. The second commit covers that case. Details under "Why a second commit".

## Mechanism, as the fix assumes it

V8 gives each DashboardView render one context object holding every component variable that some closure of that render refers to. A memoised callback created in render k keeps render k's context. That context holds the other memoised callbacks as they were in render k, and each of those keeps the render that created it. If two callbacks are recreated at different moments (one on session events, one on lane switches), each link points to an older render, and the chain only ends at mount. Every retained render holds that moment's `sessions`, `allSidebarSessions`, `terminals` and so on.

A callback that is never recreated points only to the mount render. A callback recreated on every render points only to the current one. Either ends the chain. A value made outside the component (a module-level factory) holds only its arguments and never links renders.

## Callbacks changed

Line numbers are on the branch (`src/renderer/views/DashboardView.tsx`). Old deps are at `4f330e0`.

| Callback | Old deps | New deps | Reads through | Why |
|---|---|---|---|---|
| `setPanelOpen` (:494) | `patchLayout, sessionLayouts, beginLayoutMove, cardWFor, sidebarCollapsed` | `patchLayout, beginLayoutMove, cardWFor, sidebarCollapsed` | `sessionLayoutsRef` (new) | Named in the snapshot chain. |
| `togglePanel` (:503) | `setPanelOpen, sessionLayouts` | `setPanelOpen` | `sessionLayoutsRef` | Root of the chain (`onTogglePanel`). |
| `focusTerminal` (:3613) | `terminals, sessions` | `[]` | `terminalsRef`, `sessionsRef` | The session-driven half of the chain. |
| `openLaneTerminal` (:3639) | `terminals, sessions, selectMainView` | `selectMainView` (stable) | `terminalsRef`, `sessionsRef` | Same shape as `focusTerminal` (QA's recommendation 4). |
| `dispatchToRole` (:3667) | `terminals, handleLaunchRole` | `handleLaunchRole` (stable) | `terminalsRef` | `terminals` in deps. |
| `sendProjectTask` (:3697) | `terminals, dispatchToRole, …` | without `terminals` | `terminalsRef` | `terminals` in deps. Now stable. |
| `startProjectTasks` (:3736) | `terminals, dispatchToRole, …` | without `terminals` | `terminalsRef` | `terminals` in deps. Now stable. |
| `handleResumeProject` (:3954) | `savedSessions, handleRestoreSession, pushToast` | `handleRestoreSession, pushToast` | `savedSessionsRef` | `savedSessions` changes with session saves. |
| `handleSelectSession` (:4882) | `terminals` | `[]` | `terminalsRef` | `terminals` in deps. |
| `resumePreviousRun` (:6316) | `resumeOffer, runResumeQueue` | `runResumeQueue` | `resumeOfferRef` (new) | `resumeOffer` is rebuilt on every `terminals` change. |
| `handleDumpBuffer` (:5737) | `activeSession, activeTerminalId, pushToast` | `activeSessionKey, activeSessionTerminalId, activeTerminalId, pushToast` | two id strings | After item 2, `activeSession` is the same object until the active lane's session changes, so this would have become a session-driven callback. Before, it was recreated on every render, which links nothing. |

Second commit (`0ac83f5`):

| Callback | Old deps | New | Why |
|---|---|---|---|
| `roleOf` (:5036) | `useCallback`, `[projects]` | `useMemo(() => roleLookup(projects), [projects])`, factory at :230 | Recreated by every `projects` change. Identity changes exactly as before, so children and memos that read it re-render as before, but it holds only `projects`. |
| `accentOf` (:5037) | `useCallback`, `[roleOf, sessionAccents]` | `useMemo(() => accentLookup(roleOf, sessionAccents), …)`, factory at :236 | Same. It is passed to ProjectRail, ProjectView and ProjectGallery as a prop, which is why it was not turned into a ref reader. |
| `setAccentForSession` (:5046) | `roleOf, projects, updateProject` | `updateProject` | Reads `projectsRef` and calls `roleLookup` on it. |
| `requestCloseProject` (:5108) | `closeProject, roleOf, customNames, accentOf` | `closeProject` | Reads `roleOfRef`, `accentOfRef`, `customNamesRef` (new). The dialog's rows were already frozen at open. |
| `openProjectOrFolder` (:2778) | `projects, handleOpenProject, handleNewSessionInFolder` | without `projects` | Reads `projectsRef`. |
| `toggleSidebar` (:607) | `beginLayoutMove, sidebarCollapsed, cardWFor, panelOpen` | without `panelOpen` | Reads `panelOpenRef` (new). A panel toggle no longer recreates it. |

Every callback above is now stable from mount except `setPanelOpen`, `togglePanel` and `toggleSidebar`, which still change with layout events (lane switch, window or panel width, panel tab, ⌘B).

### Children that depend on these identities

- None of ProjectRail, AgentsHubView, ProjectView, SessionToolbar or ProjectGallery uses `onSelectSession`, `onFocusSession`, `onFocusTerminal`, `onOpenLaneTerminal`, `onTogglePanel`, `onSendTask` or `onStartAll` in a hook's deps (grep of `src/renderer/components`).
- In DashboardView, the effects and memos that list `handleSelectSession`, `togglePanel` or `setPanelOpen` also list `sessions`, `terminals` or `allSidebarSessions`, so they still re-run when those change.
- `QuitGuard` computes its rows in `useMemo([request, identify])`. That is why `identifyQuitLane` is unchanged.

### Left as it was: `identifyQuitLane`

Its deps are `sessions, roleOf, customNames, accentOf`. It is passed straight to `<QuitGuard identify={…}>` in the render's JSX and no closure refers to it, so it is not in the render context and links no renders. Making it stable would freeze each lane's state word in the quit dialog at the moment the dialog opens. The source pin allows this one exception by name.

## Item 2: sidebar entries

- The builder moved from the render body to `sidebarSessions(terminals, sessions, prev, now)` in `src/renderer/lib/sidebar-sessions.ts`, comments included. DashboardView keeps the cache in `sidebarEntriesRef` and passes it back each render.
- An entry is reused when its tab object and its tracked session object are the same as last time. A lane that left `terminals` drops out of the cache.
- `allSidebarSessions` is still a new array every render, so memos that list it still recompute every render, as before.
- **Behaviour change:** an untracked lane (no session from the observer yet, a suspended lane, a shim lane) used to get `startedAt` and `lastActivityAt` set to the render's clock, a new value every render. Both are now the time the lane first got an entry, and they stay that time while it stays untracked. Where this shows:
  - `relativeTime(lastActivityAt)` in ActivityDashboard reads "since first seen" for such a lane instead of always "now".
  - Sorting by `lastActivityAt` (`lib/session-groups.ts`, the close guard's order in `lib/project-close-guard.ts`, `lib/quit-guard.ts`) places these lanes by when they appeared instead of always first. The quit and close dialogs freeze their rows at open, so their order does not move while open.
  - Idle suspension reads the observer's `sessions`, not these entries, so it is unaffected.

## Item 3: persist fingerprints

- `savedSerRef` and `projectsSerRef` now hold `fingerprint(ser)` from `src/renderer/lib/fingerprint.ts` (cyrb53 plus the length, about 15 characters) instead of the serialized JSON. The comparison still uses the same JSON (`lastActiveAt` dropped), so writes happen on exactly the same changes as before. The only exception is a hash collision, about 2^-53 for two texts of equal length, which would skip one write until the next change.
- The ref names are unchanged, to keep the diff small.
- Cost: the effect still builds the JSON string each time it runs (unchanged), and the hash adds one pass over it (`Math.imul` per character). I did not time it in the app. The 9.9 MB string that QA found pinned for the renderer's lifetime is now a temporary that the next GC collects.

## Item 4: tests

- `src/renderer/lib/renderer-leak-wiring.test.ts` (22 cases) pins DashboardView's source like `idle-suspend-wiring.test.ts`: the deps and bodies of the named callbacks contain no session state outside refs; no `useCallback` lists session or project state in its deps except `identifyQuitLane`; `focusTerminal` and `handleSelectSession` have `[]` deps; `roleOf`/`accentOf` come from module-level factories; the sidebar uses the cache; no `new Date()` stamp is left in the builder; the persist refs store fingerprints.
  - Against `4f330e0`'s DashboardView: 15 of the first commit's 16 cases fail. The one that passes is the sanity count of callbacks found.
  - Against the first commit's DashboardView: the 6 cases added for the second commit fail and the other 16 pass.
- `src/renderer/lib/sidebar-sessions.test.ts` (5): same entry objects when nothing changed; an untracked lane is stamped once and keeps the stamp when its tab changes; only the lane whose session changed is rebuilt; tab fields over the tracked session; gone lanes leave the cache. The first three fail on the old builder's behaviour (a new object per lane and a new stamp per call).
- `src/renderer/lib/fingerprint.test.ts` (3).
- These tests pin the wiring. They do not measure retention in the real renderer.

### Runs

```
root:      npx tsc --noEmit -p tsconfig.json          → exit 0
root:      npx vitest run                              → Test Files 132 passed (132), Tests 2145 passed (2145)
electron:  npm run typecheck                           → exit 0 (both tsconfigs)
electron:  npx vitest run                              → Test Files 57 passed (57), Tests 1002 passed (1002)
```

The root suite had 2139 tests after the first commit and 2145 after the second (the 6 added pins).

## Why a second commit

A toy component under vitest with forced GC (`renderer-leak-fix-2026-10-26-tools/chain-toy.test.ts`, how to run it is in its header). It has three memoised callbacks: one recreated on each of 200 "session events", each holding a 1,000-element array; one recreated on each of 40 "lane switches" and held by the fiber; and optionally a third recreated at other moments. After forced GC, it counts how many of the 200 arrays are still reachable:

| Case | Reachable of 200 |
|---|---|
| Old pattern, session-driven + lane-switch callbacks | 40 (one per lane switch) |
| Session-driven callback reading a ref (the brief's fix) | 2 |
| Old pattern, plus a third set recreated between lane switches | 80 |
| The brief's fix, plus that third set | 80 |

The first two rows match the pattern in QA's measurements: links grew in proportion to lane switches (about two per switch: 6/h at one switch per 20 min in the 10-25 run, 11 to 14/h at one per 10 min in the 10-26 run), not with session events. The last row is the case the brief's list did not cover. In DashboardView, `projects` changes on `setDispatchOutcome`, `logDispatch`, `markHeldRecord` and every task update, and the `roleOf` family was recreated with it, between lane switches. With coordinators dispatching, that keeps the chain growing at about one link per lane switch, each link holding that moment's sessions. The second commit removes that set.

This is a model of the mechanism, not a measurement of the app.

## What can still link renders

After both commits, the memoised callbacks that are still recreated are all driven by user actions:

- Layout: `rowWFor`, `placeFor`, `cardWFor` (window width, panel width, panel tab), `beginLayoutMove` (active session/terminal ids, reduced motion), `setPanelOpen`, `togglePanel`, `toggleSidebar` (also ⌘B).
- `handleDumpBuffer`, `patchActiveTerminal` (active lane ids), `handleToggleTheme`, `handleSelectTheme` (theme), `toggleGrid`, `toggleRedlines`, `changeGridSpec` (grid tools, active project), `continueWhereYouWere` (continue target).

These callbacks fall into a few groups that are recreated at different moments: lane switches on one side, and resizes, panel-width drags, panel-tab changes, ⌘B, theme and grid toggles on the other. When a lane switch and one of the others alternate, the chain still gains a link. The rate is how often the user does one of those other actions between lane switches. That is much lower than before, but the chain can still grow. Removing that too means making the layout callbacks read through refs as well. `placeFor` is called during render (`panelPlace`), so its refs would have to be assigned before that call. I did not do this.

## Not done / not verified

- No heap measurement of this branch. QA's live-lanes run is the check (their recommendation 2). For that run to cover the second commit, the workload needs `projects` changes between lane switches, for example a coordinator dispatching to a lane or tasks moving on a board. The 10-26 workload had none, so it would pass on the first commit alone.
- No GUI check. The changes are to callback identity and timestamps, but panel toggle, ⌘B, lane focus from the board, Send → / Start all, resume card, quit dialog and close dialog are the paths touched.
- Effects with cleanups also keep their render alive until they re-run. They are not in the render context, so they do not extend the chain. I did not change any.
- The `sessions.find` per terminal in the builder stays O(lanes × sessions), as before.

## Recommendations (the coordinator decides)

1. **QA:** re-run the 2 h live-lanes workload on `0ac83f5` with the same scripts (slot names re-derived with `srcnames.mjs`; `projectsSerRef` is no longer a useful marker, use `setPanelOpen`/`allSidebarSessions`), plus dispatch or task traffic between lane switches. Pass: the retained-context count and dominated MB at +2 h stay near the +10 min values. If possible, run it once on `61ad42d` as well, to measure what the second commit adds.
2. **Review:** the second commit (it goes beyond the brief's list); the timestamp change for untracked lanes; and whether `identifyQuitLane` should stay as it is.
3. **Code, only if QA still sees growth tied to layout actions:** route the layout callbacks (`rowWFor` through `toggleSidebar`) through refs.

## Files

- Branch `operator/95280`: `src/renderer/views/DashboardView.tsx`, `src/renderer/lib/sidebar-sessions.ts` (+ test), `src/renderer/lib/fingerprint.ts` (+ test), `src/renderer/lib/renderer-leak-wiring.test.ts`.
- This file and `renderer-leak-fix-2026-10-26-tools/chain-toy.test.ts` are in the main checkout's `dev/results/`, untracked, like the two leak reports before them. They are not committed on the branch: an untracked copy in the main checkout would block the merge.

## Follow-up: Review L1 and L2 (2026-10-26)

Commit `67b7756` on `operator/39e340`, on top of `0ac83f5` (fast-forward; `0ac83f5` is unchanged).
Review: `dev/results/renderer-leak-fix-review-2026-10-26.md`.

### L1: last activity of a lane the observer stops tracking — fixed

`src/renderer/lib/sidebar-sessions.ts`. `SidebarEntry` now has a `lastActivityAt` field: the tracked
session's `lastActivityAt` while the lane is tracked, carried over from the previous entry once it
is not, and `seenAt` only for a lane that was never tracked. The synthetic entry uses it instead of
`seenAt`. `startedAt` still reads `seenAt`.

Reuse is unchanged: an entry whose tab and tracked session are the same objects comes back as the
same object, so an ended lane is rebuilt once when it leaves `sessions` and then stays one object.

Test: `sidebar-sessions.test.ts`, "keeps a tracked lane's last activity once the observer stops
tracking it". A tracked lane last active at 16:58 exits; its entry reads `ended`, last activity
16:58, start at its first-seen time; the next call returns the same object; a later tab change
rebuilds it and keeps 16:58. The test fails on `0ac83f5` (the entry reads the first-seen time) and
passes on `67b7756`.

### L2: cost of the fingerprint pass — measured, approach not changed

Measured on this Mac (Apple M4) with the real `~/.operator/projects.json` (5.48 MB on disk, 19
projects). The projects-without-`lastActiveAt` JSON is 4.93 M characters, about 10 MB as a JS
string, which is the size the review refers to. Each figure is the median (p90) of 40 calls after
5 warm-up calls, run in the app's own V8 (Electron 43.4.1, V8 15.0, `ELECTRON_RUN_AS_NODE=1`).

| Input | `JSON.stringify` (already there) | `fingerprint` (added) |
|---|---|---|
| Real store, 4.93 M chars | 5.3 ms (5.8) | 5.0 ms (5.9) |
| Real store twice, 9.87 M chars | 11.3 ms (12.6) | 10.1 ms (10.5) |

The `===` comparison it replaced cost 0.61 ms (0.78) on two equal 4.93 M-character strings. So the
fingerprint adds about 4.4 ms per `projects` change on today's store, and the effect goes from about
6 ms to about 10 ms when nothing needs writing. Node 26.12.1 gives the same numbers within 0.5 ms.

Why the approach stays: about 5 ms is at the "few ms" line, not past it. The effect runs on
`projects` changes, which are event-driven (lane open, dispatch outcome, task update), not on a
timer or a poll. When the store did change, the same run also stringifies again for localStorage,
writes about 10 MB to localStorage and sends the array over IPC, which cost more than the
fingerprint. The cost grows with the store: if `projects.json` reaches about 10 MB on disk, it is
about 10 ms.

If that becomes a problem, the cheaper fix is not the identity check the review suggests. The
effect runs only when `projects` changes identity, so that check would never skip. The cheaper fix
is to fingerprint each project separately and cache the result per `tasks` and `dispatches` array
identity. Those two fields are about 99% of the text of each of the four largest projects, and a touch (`{ ...p, lastActiveAt }`, DashboardView `:1085`) keeps their
identity.

### Checks on `67b7756`

- Root `npx tsc --noEmit -p .`: clean.
- Root `npx vitest run`: 132 files, 2146 tests passed (one more than at `0ac83f5`).
- Electron `npm run typecheck` (main and renderer): clean.
- Electron `npx vitest run`: 57 files, 1002 passed.

Not merged. Not GUI-verified.
