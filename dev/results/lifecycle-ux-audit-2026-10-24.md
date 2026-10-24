# Lane and project lifecycle controls: UX audit and design (2026-10-24)

Design lane. Read-only audit of `src/renderer` at `ac4591a` (main). Nothing implemented.

## Summary

- **Close project does end its lanes.** It is not blocked and not a no-op. `closeProject`
  plans from the rail's own session list, suspended lanes included, and runs the normal lane
  close on each one in parallel (`src/renderer/views/DashboardView.tsx:1418-1470`,
  `src/renderer/lib/project-shelf.ts:67-76`). The 2026-08-13 no-op is fixed.
- The user's report that a project needs its lanes closed one by one has two causes in the
  current code, and the second one has not been reproduced in the real app:
  1. **Discoverability.** The only project-close entry points are a hover-revealed `⋯` on the
     rail group header (14×14 at the collapsed width), a right-click on that header, and the
     gallery card's `⋯`. The project home, the lane header and the command palette have no
     Close project.
  2. **Partial failure reads as success, and the only remedy is per-lane.** A lane that has not
     finished closing within 4 s is reported as "did not stop", and in the same moment a second
     toast says "Closed X — N agents ended", with N counting the lanes that did not stop
     (`DashboardView.tsx:1443`, `:1486-1509`). Those lanes stay on the rail. There is no Retry,
     so the user closes each remaining lane by hand. I reproduced the double toast in the mock
     harness. The 4 s miss there is caused by the mock (it has no `pendingReleases`), so how
     often this happens with real lanes is unknown.
- **Closing a lane has no control at the collapsed rail width.** Right-clicking an orb opens the
  accent picker (`src/renderer/components/sidebar/ProjectRail.tsx:1029-1035`). The lane header
  has no close control at any width. The routes that work at 70 px are ⌘W and the palette's
  "Close this session", and both act only on the active lane.
- Four defects turned up during the audit:
  - The roster card's `■` does nothing on a suspended lane, because it looks the session up in
    the observer list, which never contains suspended lanes (`DashboardView.tsx:6724-6727`).
  - Forget project leaves live lanes running with no project, which breaks the "block, don't
    orphan" rule (`DashboardView.tsx:1311-1340`).
  - The rail's `×` (close session) and the roster's `✕` (delete lane) are near-identical glyphs
    for two different verbs. The rail and the roster also use two different glyphs (`×` and `■`)
    for the same verb.
  - ⌘W closes a mid-turn lane on one keypress, with no confirm. Its saved session is forgotten,
    so Operator no longer offers to resume it. The mouse routes need two clicks.

"Side panel" in the user's report most likely means the left rail (the "sidebar", ⌘B). In this
app "side panel" is the right-hand Plan/Diff/Preview panel, and that panel has no lifecycle
controls.

## What I verified, and how

- **Code:** every verb traced from its control to its handler. File:line references below are
  for `ac4591a`.
- **Rendered UI:** I could not use the Electron renderer in a browser because it requires the
  native bridge (`native.onTerminalExit is not a function`). I used the repo's browser mock
  instead (`dev/mock.html` via the root Vite config on :1424) under Playwright WebKit and
  Chromium. The mock's own fixtures were used: OPERATOR with 3 live lanes, EL-ENCANTO with 1.
  - Themes: mission-control-dark for every state below; mission-control-light for the expanded
    row hover and the project menu.
  - States checked: collapsed rest; collapsed orb right-click; collapsed header hover; collapsed
    `⋯` menu open, armed, and fired; expanded rest; expanded row hover; expanded row keyboard
    focus; expanded `⋯` menu open, armed, and fired.
  - Measured: the collapsed rail has 0 close/end/stop controls at rest, on hover and on orb
    right-click. On the expanded rail, the `×` appears on mouse hover only. Focusing the row
    from the keyboard does not show it (`xVisible: false`).
  - In Chromium, Close project arms ("— click again") and fires. In WebKit the menu closed on
    the arming click. That is a WebKit focus behaviour (it does not focus buttons on click, so
    `useDismiss`'s focus-out check sees `body`), and it does not apply to Electron. I am noting
    it so nobody treats it as a finding.
  - Screenshots and scripts: `/tmp/operator-shots/lifecycle-audit-2026-10-24/`.
- **Not checked:** the real app with real lanes (close timings, the stuck path); the gallery
  card and roster card rendered; a project with zero lanes; overflow (20+ lanes). None of the
  proposed changes is checked visually, because none is built.

## (a) Audit table

Status key: **OK** = reachable and guarded in proportion to the damage. **HIDDEN** = exists but
only on hover, right-click or a shortcut. **EXTRA** = takes more steps than it should.
**MISSING** = no control. **BROKEN** = a control exists and does the wrong thing.

### Close a lane's session

What it does: kills the pty, finishes the lane's running tasks, commits unsaved worktree changes
as WIP, removes the worktree folder (the branch is kept), and forgets the saved session.
`DashboardView.tsx:3816-3932`, forget at `:3919`.

| Surface | Expanded rail (264) | Collapsed rail (70) | Status | Reference |
|---|---|---|---|---|
| Rail lane row | `×` revealed on mouse hover, click again (`×?` on a solid `--color-error` fill). Keyboard focus does not reveal it. | n/a | HIDDEN | `components/sidebar/SessionItem.tsx:338-357`; hover gate `:80`, `:292`, `:311`, `:326` |
| Rail lane orb | n/a | Nothing. Right-click opens the accent picker. The hover card is `pointerEvents: none`. | **MISSING** | `ProjectRail.tsx:1029-1035`, `:1087` |
| Rail row right-click | Accent picker, on the orb only | — | MISSING (no lane menu) | `SessionItem.tsx:173-179` |
| Lane header (toolbar) | Nothing | Nothing | **MISSING** | `components/session/SessionToolbar.tsx` (controls `:260-:560`; none closes) |
| Project home → Team roster card | `■` → "stop?" click again | same | **BROKEN** for suspended lanes: the lookup uses `sessions` (the observer list, `:219`), which never contains a suspended lane, so the click is a silent no-op | `components/session/RosterPanel.tsx:801-829`; wiring `DashboardView.tsx:6724-6727` |
| Keyboard ⌘W | Closes the active lane | same | Works at every width. Unguarded: one press ends a mid-turn lane. | `DashboardView.tsx:5359-5368` |
| Command palette | "Close this session ⌘W", active lane only | same | OK, unguarded | `DashboardView.tsx:6156` |
| Ended overlay (pty exited) | Close | same | OK | `DashboardView.tsx:6927-6936`, `:7166` |
| Suspended overlay | Resume only | same | Header would cover it | `components/terminal/SuspendedOverlay.tsx:20-51` |
| Agents hub (all projects) | Focus only | — | MISSING, low priority | `components/agents/AgentsHubView.tsx:181` |

Glyphs: the rail uses `×` and the roster uses `■` for this verb. The roster's `✕` deletes the
lane (`RosterPanel.tsx:846-877`). `×` and `✕` look the same at 10–12 px, so two verbs share a
glyph across surfaces (feedback_two_verbs_one_glyph).

### Delete a lane (remove the role from the roster)

| Surface | Status | Reference |
|---|---|---|
| Roster card, idle lanes only, `✕` then confirm | OK. Correctly absent while the lane is live. | `RosterPanel.tsx:830-877` |

### Suspend and resume

| Verb | Surface | Status | Reference |
|---|---|---|---|
| Suspend one lane | No manual control anywhere. Suspension is automatic (Tuning) or "suspend every idle lane" from the memory banner. | **MISSING.** The only stop verb a user has also forgets the conversation (`:3919`), so "stop this lane but keep its thread" cannot be done by hand. | `components/tuning/TuningView.tsx:185`; `components/MemoryBanner.tsx:48-62` |
| Resume one lane | Click or type in the suspended overlay. Opening the dimmed row or orb resumes it. | OK at both widths | `SuspendedOverlay.tsx:20-51`; `ProjectRail.tsx:306-311` |
| Resume a project | Project home "Resume" button, palette "Resume X — N agents", overview resume card | OK | `components/session/ProjectView.tsx:144-146`; `DashboardView.tsx:6211`; `components/dashboard/ResumeCard.tsx:51` |

### Close a project

What it does: ends every live and suspended lane of the project through the lane close above.
The project stays on Active with its roster, tasks, notes and branches. `DashboardView.tsx:1418-1510`.

| Surface | Expanded rail (264) | Collapsed rail (70) | Status | Reference |
|---|---|---|---|---|
| Rail group header `⋯` | Revealed on hover or focus, 18×16 → menu → "Close project · end N agents" → click again | Same, 14×14, covers the last letters of the name | HIDDEN, EXTRA (hover to find, 3 clicks) | `ProjectRail.tsx:784-822`; menu `DashboardView.tsx:6319-6346` |
| Rail group header right-click | Same menu | Same menu | HIDDEN | `ProjectRail.tsx:741-752` |
| Gallery card `⋯` | Same item, shown when the project is on the rail | — | OK | `components/dashboard/ProjectGallery.tsx:557`, `:720-731`, gate `:313` |
| Project home header | Nothing (All projects, tabs, Resume) | same | **MISSING** | `ProjectView.tsx:106-150` |
| Lane header | Nothing | same | **MISSING** | `SessionToolbar.tsx` |
| Command palette | Open / Restore / Resume / Start tasks / Launch per project, no Close | same | **MISSING** | `DashboardView.tsx:6176-6270` |
| Confirm content | The label carries a count. It does not name the lanes or say how many are mid-turn. `closePlan().running` is computed and never used. | same | EXTRA (guard cannot say what is lost) | `project-shelf.ts:74`; `components/CardMenu.tsx:130-154` |
| Outcome | Any lane past 4 s → "N did not stop" **and** "Closed X — N agents ended", with N including the stuck lanes. The stuck lanes stay on the rail. No Retry. | same | **BROKEN** (contradictory report; per-lane cleanup) | `DashboardView.tsx:1443-1470`, `:1486-1509` |

### Forget a project, a saved session, or a worktree

| Verb | Surface | Status | Reference |
|---|---|---|---|
| Forget project | Gallery card `⋯` and Previous row `⋯`, danger colour, confirm. Deliberately not on the rail. | **BROKEN with live lanes**: their ptys keep running with the project id removed, and the confirm does not say so. | `ProjectGallery.tsx:744`, `:1095`; `DashboardView.tsx:1311-1340`, rationale `:6293` |
| Forget saved session | Overview recent list | OK | `components/dashboard/RecentLists.tsx:97` |
| Rescue worktree | Settings → Worktrees row (copies unsaved work, removes nothing); the overview links there | OK. It is a worktree verb, not a lane verb, so no lane entry is needed. | `components/preferences/WorktreesSection.tsx:642-650`; `components/dashboard/WorktreeOverview.tsx:219` |
| Shelve / Restore project | Gallery card `⋯` | OK | `ProjectGallery.tsx:737-738` |

## (b) Proposed design

### B1. Lane close reachable at every width: one lane menu, three ways in

**The lane menu.** A `CardMenu` titled with the lane's name, holding:

1. `Close session` with a `⌘W` hint. It arms (click again) when the lane is live, which is the
   existing CardMenu `confirm`.
2. `Restart on Claude Code X`, only when that lane is out of date. The data and handler already
   exist for the rail menu (`DashboardView.tsx:6314-6327`).
3. `Lane colour…`, which opens the existing AccentPicker at the same anchor.

The menu does not include Rename (double-click on the row stays) or Delete lane (roster only,
idle only, as today).

**Entry 1: a `⋯` in the lane header.** `SessionToolbar`, right cluster, just before the
side-panel toggle. Same `CHIP_H` square and `chipBase` as its neighbours, `--fg-muted` ink that
moves to `--fg` on hover with no opacity, `data-popmenu-trigger`, and title "Lane actions". It is
always visible: the toolbar has room, and it sits in the main pane, so it is there whether the
rail is at 264, at 70, or hidden. This is the fix for complaint 1. `⋯` is already the app's
"menu of actions" mark for projects, and it is not a verb, so it cannot be confused with `■`.

**Entry 2: right-click on a lane, at both widths.** Right-clicking the collapsed orb, the
expanded orb or the expanded row opens the lane menu at the coordinates the accent picker uses
now (`ProjectRail.tsx:1033`, `SessionItem.tsx:177`). Recolouring goes from one right-click to
right-click plus one click. Lanes are recoloured rarely and closed every day, so I think the
trade is right. **This changes an existing gesture, so the user should approve it.**

**Entry 3: the expanded row's hover control (exists today).**

- The glyph changes from `×` to `■`, so close session has one glyph across the rail and the
  roster, and it no longer looks like the roster's `✕` (delete lane).
- It is revealed on hover **or** `:focus-within` on the row, so the keyboard can reach it.
- The armed state uses the roster's treatment: "stop?" in `--fg` on `--overlay-medium`,
  uppercase 9 px mono. The solid `--color-error` fill goes, so one verb has one look everywhere.
- Title: "Close session (⌘W)".

**Rejected:** a `■` overlaid on the collapsed orb on hover. The disc is 24 px in a 36 px pitch,
and it is already the click target and the drag handle. A third target on it would be a 12 px
mis-click next to a destructive verb. Entries 1 and 2 cover the collapsed width without it.

**⌘W guard.** When the active lane is mid-turn (running, compacting or asking), the first ⌘W
arms: a toast reads "Press ⌘W again to close Code — it is mid-turn" for 2.5 s (`CONFIRM_MS`).
An idle or waiting lane closes on the first press, as today. This is the same graduated rule the
project close already follows: confirm only when something irreversible would be lost.

### B2. One-action project close with one confirm that names the lanes

**Entry points.**

- Keep the rail `⋯`, the rail right-click and the gallery `⋯`.
- Add a quiet text button, `Close project`, to the project home header, right-aligned next to
  Resume. Body font, 11.5 px, `--fg-muted` → `--fg` on hover, no fill. Shown when the project is
  on the rail (`isOnRail`).
- Add `Close <name> · end N agents` to the palette for each project on the rail. Group
  "Project", next to the existing Resume entries.

**The confirm: a `ProjectCloseGuard` dialog, opened only when N > 0.** It uses the QuitGuard
skeleton, which is the app's one precedent for a dialog that names lanes
(`components/QuitGuard.tsx`): scrim, a 420 px panel on `--bg-sidebar`, `--border`,
`--radius-lg`, `--shadow-panel`, and lane rows of 13 px StatusWave + name + state.

```
┌──────────────────────────────────────────────┐
│ Close web27 and end 4 agents?                │
│ Each agent's CLI stops and its worktree      │
│ folder is removed. Unsaved changes are       │
│ committed to its branch first. Branches,     │
│ roster, tasks and notes stay.                │
│ ──────────────────────────────────────────── │
│ ◍ Code                             working   │
│ ◍ QA                               working   │
│ ◍ Coordinator               waiting on you   │
│ ◍ Research                       suspended   │
│                                              │
│ 2 are mid-turn. That turn's work is lost.    │
│                                              │
│ Esc to keep    End 4 and close  [Keep running]│
└──────────────────────────────────────────────┘
```

- Rows are ordered mid-turn first, then by recency (reuse the rank in `quitGuardRows`). The cap
  and "+N more" follow `ROW_CAP`. State words: working / waiting on you / idle / suspended.
- The mid-turn line comes from `closePlan().running`, which finally gets used. It is hidden when
  the count is 0.
- Same asymmetry as QuitGuard. `Keep running` is the bordered button, takes focus on open, and
  answers Return, Esc and ⌘.. `End N and close` is borderless in `--color-error`, sits to the
  left, and has no shortcut.
- The menu items stop arming: `confirm: false` when the dialog will open, because the dialog is
  the confirm. The path is menu → item → dialog → End, or ⌘K → item → dialog → End.
- N = 0: the project closes immediately with no dialog, as today.
- Rows are frozen when the dialog opens (QuitGuard's rule against rows moving under the
  pointer). On End, `closeProject` plans again as it does today, so a lane started while the
  dialog was open is ended too, and the toast reports the real count.
- Copy check against the global typography rule: the title is one sentence. In the body, wrap
  points must not leave a sentence's first word ("Unsaved", "Branches") alone at a line end.
  Bind the first two words of each sentence with a non-breaking space (`\u00a0` in JSX strings).

**Outcome: one toast that is true.**

- Every lane ended: `Closed web27 — 4 agents ended` (as today).
- Some did not: `Closed 3 of 4 agents in web27`, detail `QA did not stop`, action `Retry`. Retry
  runs `handleCloseSession` on the stuck lanes only. The project stays on the rail with only
  those lanes, and the closing chip stays until they settle. The success toast is not also
  pushed.
- "Did not stop" should mean the pty is still alive after the bound, checked with `terminalList`
  again. A lane whose close is still running at 4 s is "still stopping", not stuck. Today
  `Promise.race` reports it as stuck while its close carries on in the background
  (`DashboardView.tsx:1456-1470`).

### B3. Forget project while lanes are live

When `lanesToEnd > 0`, the item is disabled and reads `Forget project — close it first (N
agents running)`. This blocks the action instead of leaving orphans, as the delete-lane control
already does. Disabled CardMenu items render with `opacity: 0.4` on `--fg` (`CardMenu.tsx:147`).
That is not the `--fg-muted` stack the house rule forbids, but it should be checked against the
light palettes when it is built.

## (c) Code-ready tasks, in order

All for **Code**. QA should verify tasks 2–6 in the app with real lanes, in both themes, at both
rail widths.

1. **Roster `■` closes suspended lanes.** In `DashboardView.tsx:6724-6727`, look the session up
   in `allSidebarSessions` (the list ⌘W and the ended overlay use), not `sessions`. Test: closing
   a suspended lane from its Team card ends it and removes its row.
2. **Project close reports the truth and offers Retry.** In `DashboardView.tsx:1439-1509`: decide
   "did not stop" by aliveness after the bound; push one toast, never both; count only the lanes
   that ended; add a `Retry` action for the stuck ones. Put the toast choice in a pure helper next
   to `closePlan` and unit-test it (all ended, some stuck, all stuck).
3. **`ProjectCloseGuard` dialog.** Extract QuitGuard's scrim, panel and row layout into a shared
   piece, or parameterise it. Build the dialog from `closePlan` plus lane identity. Wire it into
   the rail menu and the gallery menu (`confirm: false` when it opens), with `running` in the
   copy. Test the copy with a unit test like `quit-guard`'s (1, N, all waiting, mid-turn > 0,
   over `ROW_CAP`).
4. **More ways in to Close project.** Add the project home header button (`ProjectView.tsx`,
   header row `:106-150`) and the palette entries (`DashboardView.tsx`, project block
   `:6195-6235`). Both open the same dialog.
5. **Lane menu.** Add a lane-actions `⋯` to `SessionToolbar`. Make right-click on the orb and
   row open the lane menu at both widths, with the accent picker as an item. One menu component,
   one item list built in `DashboardView` next to `railMenuItems`. **Needs the user's OK on
   changing right-click (step B1, entry 2) before it ships.**
6. **Rail row control.** In `SessionItem.tsx:338-357`: `×` → `■`, reveal on `:focus-within`,
   roster armed treatment ("stop?", `--overlay-medium`), title with ⌘W.
7. **⌘W arms on mid-turn lanes.** `DashboardView.tsx:5359-5368`, 2.5 s window, toast copy as in
   B1.
8. **Forget blocked while lanes are live.** `ProjectGallery.tsx:744`, `:1095`. The disabled item
   names the reason.
9. **Decision for the coordinator and the user, not yet a task:** a per-lane `Suspend — keep the
   conversation` item in the lane menu, using the existing `suspendLane`. Today the only manual
   stop also forgets the thread. The same question applies to project close: whether the dialog
   should offer "Suspend all" next to "End all".

Open question for QA, to confirm the cause of complaint 2 in the real app: with 3 or more live
lanes, including one suspended and one mid-turn, close the project from the rail `⋯`, and record
the toasts, which lanes remain, and how long each took.
