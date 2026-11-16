# Review: renderer leak fix (2026-10-26)

Branch `operator/95280`: commits `61ad42d` and `0ac83f5` on main `4f330e0`. Code's write-up:
`dev/results/renderer-leak-fix-2026-10-26.md`. Background: `dev/results/renderer-leak-live-lanes-2026-10-26.md`.
Line numbers are at `0ac83f5`, in `src/renderer/views/DashboardView.tsx` unless noted.

## Verdict

**Mergeable. No defect blocks it.**

- The ref conversions read current values at call time.
- No hook or child lost a re-run it needed.
- `identifyQuitLane` is right to stay as it is.
- The fingerprint is sound.

Two low findings are below: a timestamp regression in the sidebar builder, and an unmeasured CPU
cost from the fingerprint. As Code says, the real check is still a heap measurement on the app with
dispatch or task traffic between lane switches. This review confirms the wiring, not the retention.

## Tests run

On an export of `0ac83f5`:

- Root `npx vitest run`: 132 files, 2145 passed.
- Root `npx tsc --noEmit -p .`: clean.
- Electron `npx vitest run`: 57 files, 1002 passed.
- Electron `npm run typecheck` (main + renderer): clean.

## Findings, by severity

### L1. Low: a lane the observer stops tracking gets its launch time as its last activity

`src/renderer/lib/sidebar-sessions.ts:47` (`const seenAt = last?.seenAt ?? now()`).

`seenAt` is set when a lane first gets an entry and is kept for as long as the tab exists, including
while the lane is tracked. When a tracked lane's session leaves `sessions` (the observer only
returns sessions it still considers active, so an exited lane drops out), the entry is rebuilt as a
synthetic one with `startedAt = lastActivityAt = seenAt`. That is the time the lane appeared, usually
its launch.

Failure scenario: a lane runs for five hours, last active 2 minutes ago, then exits. Its tab stays
(ended). The sidebar entry now says its last activity was five hours ago:
- ActivityDashboard's `relativeTime` shows "5 h";
- the lane sorts last in `lib/session-groups.ts`.

Before the fix it read "now", which was also wrong, but in the other direction.

Decisions are not affected. Idle suspension, retire, the close tick and the "ready for review"
toast all read the observer's `sessions`, not these entries (checked at `:1283`, `:4338`, `:4539`,
`:4820`, `:5562`). Only display and order change.

A better stamp: when the previous entry was tracked, use its `tracked.lastActivityAt`, and fall back
to `seenAt` only for a lane that was never tracked. That is a small change in `sidebarSessions`, for
Code.

### L2. Low (not measured): the fingerprint adds a full pass over the projects JSON on every `projects` change

`:5259` and `:5243`.

The persist effects still build the JSON every time they run, as before. They now also hash it
character by character (two `Math.imul` per character). The write-up puts the projects text near
10 MB of string, and `projects` changes on every dispatch outcome, held-record flip and task
update. This roughly doubles the per-change CPU cost of that effect, which was already as large as
the `JSON.stringify` before it. The memory saving is real and the design is right. The cost should
be timed in the QA run (a performance mark around the effect) before anyone treats it as free. If
it shows, the cheap fix is to skip the stringify when the `projects` array identity has not changed.

## The six questions

### 1. Do the ref-reading callbacks read current values, with no stale ref?

Yes.
- **Assignment order.** `projectsRef`, `terminalsRef`, `savedSessionsRef` and `sessionsRef` are
  assigned in the render body (`:1139-1153`). `sessionLayoutsRef` and `panelOpenRef` are assigned
  right after their state (`:349-358`). `roleOfRef`, `accentOfRef`, `customNamesRef` and
  `resumeOfferRef` are assigned right after their values. None of the converted callbacks runs
  during render. They are called from events, effects, toasts and IPC handlers, all of which run
  after the render that assigned the refs.
- **No concurrent features.** The renderer uses no `startTransition`, `useTransition`,
  `useDeferredValue` or Suspense, so a discarded render cannot leave a ref ahead of committed state.
  Render-phase assignment was already the pattern for these refs before this branch.
- **Ahead-of-state writes.** `closeLane` and `forgetSavedSession` write `terminalsRef` and
  `savedSessionsRef` directly before the state commits. The converted callbacks now see those
  writes. For example, `focusTerminal` on a lane that is being closed returns early instead of
  focusing a tab about to vanish. That is more correct than the old closure.
- **Same-event staleness.** Two calls in one event read the same value, before and after. Nothing
  changed there.

### 2. Do children and effects that depended on identity still re-run?

Yes.
- **Children.** No component under `src/renderer/components` or `lib` lists `onSelectSession`,
  `onFocusTerminal`, `onOpenLaneTerminal`, `onTogglePanel`, `onSendTask`, `onStartAll`,
  `onResumeProject`, `onCloseProject`, `accentOf` or `roleOf` in a hook's deps (grep of every
  `}, [ … ]`).
- **DashboardView's own hooks** that list the converted callbacks also list state that still
  changes:
  - the "ready for review" effect lists `sessions, terminals` (`:5577`);
  - the keydown effect lists `allSidebarSessions`, a new array every render (`:5686`);
  - the palette memo lists `allSidebarSessions` (`:6604`);
  - `railMenuItems` lists `terminals, sessions` (`:6674`).
- **`identifyQuitLane`.** The reasoning holds. Its only reference is `identify={identifyQuitLane}`
  in the component's top-level JSX (`:7529`), not inside an inline function or IIFE, so no inner
  closure captures it. It is therefore not in the render context and links no renders. Its own
  closure holds the render it was made in. That is the latest session event, since it is recreated
  on every one, held by the fiber's hook state. Keeping it live is what QuitGuard's
  `useMemo([request, identify])` needs to show current state words while the dialog is open.

### 3. The second commit on its own

It is correct.
- `roleLookup` and `accentLookup` are module-level, so their closures hold only `projects`, and
  `roleOf` and `sessionAccents`. `useMemo` keeps their identity changing exactly when it did, so the
  props to ProjectRail, ProjectView and ProjectGallery behave as before.
- `setAccentForSession` builds a fresh lookup from `projectsRef`.
- `requestCloseProject` reads `roleOfRef`, `accentOfRef` and `customNamesRef` when it is called. Its
  rows were frozen at open already.
- `openProjectOrFolder` reads `projectsRef`.
- `toggleSidebar` reads `panelOpenRef`.

I found no `useCallback` left with `projects`, `sessions`, `terminals`, `savedSessions`,
`sessionLayouts`, `customNames`, `sessionAccents` or a value derived from them in its deps, except
`identifyQuitLane`. I scanned all 112. The remaining non-callback deps are:
- `sidebarCollapsed`, `activeSessionId`, `activeTerminalId`, `activeSession?.terminalId`,
  `activeSessionKey`, `activeSessionTerminalId`, `reducedMotion`;
- `winW`, `panelW`, `effPanelTab`, `minConsoleW`;
- `currentTheme`, `gridOn`, `gridProjectId`, `redlinesOn`, `continueTarget`.

All of these are user-driven, as the write-up says.

### 4. `sidebar-sessions`: staleness and growth

- **Staleness.** An entry is reused only when both its tab object and its tracked-session object
  are identical, so any change to either rebuilds it. The one stale value is the timestamp in L1.
- **Growth.** The cache is rebuilt from `terminals` on each call, so a lane that leaves `terminals`
  leaves the cache. An ended tab that stays in `terminals` keeps one entry, as it should. The ref
  holds only the latest map. `sidebarBuilt` is used only in the render body, so it is not
  context-allocated and old maps are not retained.
- **Concurrent rendering.** None, so the render-phase write to `sidebarEntriesRef` cannot advance
  past a discarded render.
- **Limit of the cache.** If the observer replaces every session object on each poll, tracked lanes
  are rebuilt on every poll anyway, and the cache mostly helps untracked lanes and renders that
  were not caused by a poll. That is not a defect. It means the per-render retention win is smaller
  than "one object per lane" suggests.

### 5. Can two different stores share a fingerprint and skip a save?

Only by accident: cyrb53 gives 53 bits, and the length is prefixed, so a collision needs equal
lengths and is near 2^-53 per comparison. The comparison is only against the last text written, and
the inputs are not adversarial. The consequence of a collision is one skipped write, made good at
the next change. The JSON being compared is unchanged (still without `lastActiveAt`), so writes
happen on exactly the same changes as before. Clean.

### 6. Is there a second chain left?

The write-up's own account is right:
- The callbacks still recreated after mount are all driven by user actions: the layout set
  (`rowWFor`, `placeFor`, `cardWFor`, `beginLayoutMove`, `setPanelOpen`, `togglePanel`,
  `toggleSidebar`), the active lane ids (`handleDumpBuffer`, `patchActiveTerminal`), theme, grid
  and `continueWhereYouWere`. Alternating lane switches with resizes, panel-tab changes, ⌘B or a
  theme or grid toggle still adds links, at the rate of those actions.
- I also checked the other way a chain can form: a `useMemo` whose value holds closures and is
  recomputed on session events, and is referenced from inside another closure. The candidates are
  `railMenuItems`, `laneActionMenu` and `laneMenuItems`. All three are used only in top-level JSX
  (`items={…}`, `:6830-6846`), so they are not context-allocated. The memos that are referenced
  from closures (`projectActivities`, `backLanes`, `pageBack`, the palette's actions) depend on
  `allSidebarSessions`, which is new every render, so they always belong to the current render.
- Effects that register long-lived closures (IPC subscriptions) hold the context of the render
  they ran in. That pins a fixed set; it does not grow.
- I found no chain driven by timers or background traffic: `reports`, `pressure`, `toasts` and
  `wakingKeys` are in no callback's deps.

## Recommendations (the coordinator decides)

1. **QA:** the 2-hour live-lanes heap run on `0ac83f5`, with dispatch or task traffic between lane
   switches (Code's recommendation 1). Add a performance mark around the projects persist effect
   for L2.
2. **Code, small:** L1. Carry the last tracked `lastActivityAt` into the synthetic entry.
3. **Code, only if QA still sees growth tied to layout actions:** route the layout callbacks through
   refs. `placeFor` is called during render, so its refs must be assigned before that call.
