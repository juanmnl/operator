# Lane and project lifecycle fixes (2026-10-24)

Code lane, branch `operator/95b180`, on main `ac4591a`. Not merged, not checked in the app.
This implements tasks 1, 2, 3, 4, 6, 7 and 8 from section (c) of Design's audit
(`dev/results/lifecycle-ux-audit-2026-10-24.md` on `operator/b6fe00`), one commit each.
Tasks 5 (lane ⋯ menu, right-click change) and 9 (Suspend items) are not done; they wait on
the user's decision.

| Task | Commit |
|---|---|
| 1. Roster ■ closes suspended lanes | `f6a740d` |
| 2. Project close: one true toast, Retry | `eba9738` |
| 3. ProjectCloseGuard dialog | `7178d5a` |
| 4. Close project in project home and palette | `5151f12` |
| 6. Rail row ■, focus reveal, armed look | `8e8ba22` |
| 7. ⌘W arms on mid-turn lanes | `f8e22e4` |
| 8. Forget blocked while lanes are open | `993c026` |

Line numbers below are at the branch tip, `993c026`.

## What changed

### Task 1: the Team card ■ closes suspended lanes

- `src/renderer/views/DashboardView.tsx:6808`: `onCloseTerminal` looks the lane up in
  `allSidebarSessions`, not `sessions`. The observer list never holds a suspended lane, so
  the click did nothing on one.

### Task 2: project close reports the truth and offers Retry

- `src/renderer/lib/project-shelf.ts:79` `isMidTurn`: running, compacting or asking.
  `closePlan().running` now uses it, so an asking lane counts as mid-turn. Before, only
  running and compacting counted.
- `project-shelf.ts:99` `stuckAfterClose`: a lane "did not stop" if its pty is still alive in
  a second `terminalList` read after the 4 s bound. When the backend cannot list its
  terminals, the old reading applies: the close did not finish in time and the pty was alive
  when it began.
- `project-shelf.ts:128` `closeToast`: chooses the one toast.
  - All ended: `Closed web27 — 4 agents ended`.
  - Some stuck: `Closed 3 of 4 agents in web27`, with detail `QA did not stop.`
  - All stuck: `Could not close web27`, with the same detail.
  - Nothing to end: `Closed web27`.
  - Retry is offered whenever a lane is stuck.
- `DashboardView.tsx:1427` `closeProject` now only plans and hands the lanes to
  `endProjectLanes` (`:1449`), which Retry also calls.
  - Each lane's close is raced against the bound.
  - Aliveness is read again at `:1500`.
  - One toast is pushed, with Retry at `:1529`. Retry re-reads each stuck lane from the rail
    and runs the close on those lanes only.
- `DashboardView.tsx:1445` `lanesClosingRef`: if a lane's close is still in flight when Retry
  is pressed, Retry waits on that close and does not start a second one. Two closes of one
  lane would commit and remove its worktree twice.
- `DashboardView.tsx:1515`: the `closing…` chip now stays until every close has settled,
  including closes that were still running when the toast was pushed. There is no upper time
  limit, so a close that never settles leaves the chip up.

### Task 3: the ProjectCloseGuard dialog

- `src/renderer/components/GuardDialog.tsx:25`: QuitGuard's scrim, panel, rows, focus trap
  and button pair, moved into a shared component. `QuitGuard.tsx` now renders through it and
  behaves as before. The aria ids take a prefix.
- `src/renderer/components/ProjectCloseGuard.tsx`: the close dialog, built on GuardDialog.
- `src/renderer/lib/project-close-guard.ts`:
  - `closeGuardRows` (`:43`): orders asking, running, compacting, waiting, idle, then
    suspended, most recent first within each group. It reuses the quit guard's rank, now
    exported as `phaseRank` (`quit-guard.ts:73`), and its `ROW_CAP`.
  - `closeGuardCopy` (`:75`): title `Close web27 and end 4 agents?` (one lane: `…and end its
    agent?`), the body from B2, the mid-turn line (hidden at 0), `and N more`,
    `Keep running`, `End N and close` (one lane: `End it and close`), and the hint
    `Esc to keep`. In every sentence after the first, the first word is bound to the next
    with `\u00a0`.
- `DashboardView.tsx:4917` `requestCloseProject`: every entry point calls it. With no lanes to
  end, the project closes at once. Otherwise it freezes the rows and copy and opens the dialog
  (rendered at `:7242`). End calls `closeProject`, which plans again.
- The rail menu item (`DashboardView.tsx:6422`) and the gallery item
  (`ProjectGallery.tsx:720`) no longer arm. The dialog is the confirm.

### Task 4: more ways in to Close project

- `src/renderer/components/session/ProjectView.tsx:167`: a quiet `Close project` text button
  at the right of the header, after Resume. It uses the body font at 11.5 px, `--fg-muted`
  changing to `--fg` on hover or focus, no fill and no opacity. Wired at
  `DashboardView.tsx:6833`. The project home is always the active project, so this project is
  always on the rail there.
- `DashboardView.tsx:6295`: a palette entry `Close <name> · end N agents` (or `Close <name>`
  when N is 0) in the Project group, for each project that is on the rail (`isOnRail`).

### Task 6: the rail row control

- `src/renderer/components/sidebar/SessionItem.tsx:90`, `:128`: the control shows on hover or
  when anything in the row has keyboard focus (`focusWithin`).
- `SessionItem.tsx:342-371`: the glyph changed from `×` to `■`. The armed state is `stop?` in
  `--fg` on `--overlay-medium`, uppercase 9 px mono, the same as the Team card. The solid
  `--color-error` fill is gone. The title is `Close session (⌘W)`.
  - The focused button gets an accent inset ring.
  - Enter and Space on the button stop at the button. The row's own Enter/Space handler would
    otherwise have opened the lane.

### Task 7: ⌘W arms on mid-turn lanes

- `src/renderer/lib/close-key.ts:11` `closeKeyAction`: a lane that is mid-turn and not ended
  arms on the first press. A second press on the same lane within the window closes it.
  Idle, waiting and ended lanes close on the first press.
- `DashboardView.tsx:5431`: on arm, the toast `Press ⌘W again to close Code — it is mid-turn`
  is shown. It is taken down after `CONFIRM_MS` (2.5 s), or when the second press closes the
  lane. `pushToast` (`:582`) now returns the toast id so the toast can be removed early.

### Task 8: Forget blocked while lanes are open

- `src/renderer/lib/project-status.ts:54` `forgetProjectItem`: while lanes are open the item
  is disabled and reads `Forget project — close it first (N agents open)`. When disabled it
  drops the danger tone, so it renders as `--fg` at 0.4 opacity, not faded red.
- Used by the gallery card (`ProjectGallery.tsx:744`) and the Previous row (`:1098`), which
  now receives `liveCount` (`:339`).
- `DashboardView.tsx:1322`: `forgetProject` also refuses a project with open lanes, which
  covers any other caller.

## Where this differs from the audit

- **Mid-turn includes asking.** B1 defines mid-turn as running, compacting or asking, and I
  used that definition for `closePlan().running` too. The dialog's mid-turn count therefore
  includes lanes with a question open.
- **State words.** B2 lists working, waiting on you, idle and suspended. I added
  `compacting` and `asking you`, the words the rail row already uses, so that those two
  states are not shown as one of the four.
- **Forget label.** B3's copy is `(N agents running)`. I used `(N agents open)` because the
  count includes suspended lanes, which are not running.
- **All lanes stuck.** The audit's tests name this case but give no copy. I used
  `Could not close <name>`, because `Closed 0 of N` reads as a success.
- **Retry while a close is in flight** waits on that close rather than starting another (see
  task 2).

## Tests

Most of the wiring lives in DashboardView, which has no component tests. As in
`idle-suspend-wiring.test.ts`, the wiring is pinned against the source in
`src/renderer/lib/lifecycle-wiring.test.ts`: one block per task (1, 2, 3, 4, 6, 7, 8). The
pure parts have their own unit tests:

- `project-shelf.test.ts`: `isMidTurn`, `stuckAfterClose` (alive after the bound; a close
  still running whose pty is gone; the fallback when the backend cannot list terminals), and
  `closeToast` (all ended, some stuck, all stuck, nothing to end, and the no-stranded-word
  check). The `closePlan` test now includes an asking lane.
- `project-close-guard.test.ts`: copy for 1 lane, N lanes, all waiting, mid-turn > 0, and
  over `ROW_CAP`; row order, state words and wave status; the cap keeps a mid-turn lane
  visible.
- `close-key.test.ts`: first press, the arm window, its expiry, another lane, ended lanes.
- `project-status.test.ts`: `forgetProjectItem`.

Results at `993c026`:

```
root      npx vitest run             Test Files 126 passed (126)   Tests 1983 passed (1983)
electron  npx vitest run             Test Files  56 passed (56)    Tests  998 passed (998)
electron  npm run typecheck          tsc -p tsconfig.json --noEmit && tsc -p tsconfig.renderer.json --noEmit: no errors
root      npx tsc --noEmit -p .      no errors
```

The baseline on `ac4591a` was root 1942 tests, electron typecheck clean.

## In-app checks for QA

None of this has been run in the app. Use real lanes, both themes, and both rail widths
(264 and 70).

1. **Roster ■ on a suspended lane.** Suspend a lane (Tuning, or the memory banner's "Suspend
   idle lanes"). Open project home → Team, press ■ and then `stop?`. The lane should end and
   its rail row should disappear.
2. **Close project, all lanes stop.** Start 3 or more lanes, one of them mid-turn and one
   suspended. Close the project from the rail ⋯. Check:
   - the dialog opens and lists every lane, mid-turn lanes first, the suspended lane last as
     `suspended`;
   - the line "N are mid-turn" is shown;
   - `Keep running` has focus, and Return, Esc and ⌘. each close the dialog without ending
     anything;
   - Tab moves only between the two buttons.

   Then press `End N and close`. Exactly one toast should appear, `Closed X — N agents
   ended`, and the `closing…` chip should stay until the lanes are gone.
3. **Close project, a lane that does not stop.** This is the audit's open question. If a lane
   can be made to outlive the 4 s bound, there should be one toast,
   `Closed k of N agents in X`, naming that lane, with a Retry button. Press Retry, which
   should end it. Record how long each lane took to close.
4. **Idle project.** Open a project and launch nothing. Close it from the rail ⋯, the gallery
   ⋯, the project home button, and ⌘K. It should close at once with no dialog, and the toast
   should be `Closed X`.
5. **Entry points.** With lanes running, all four entry points above should open the same
   dialog. The palette label should read `Close X · end N agents`. Check the project home
   button in both themes: it should be `--fg-muted` at rest and `--fg` on hover, with no fill.
6. **Rail row ■.** On the expanded rail:
   - Hover a row: ■ replaces the phase word.
   - Tab to a row: ■ appears without the mouse. Tab again to reach it; Enter arms it
     (`stop?` on the grey overlay), a second Enter closes the lane.
   - Check that the armed state reads clearly in the light themes.
   - Check that the row's Enter still opens the lane when the row itself has focus.
7. **⌘W.**
   - On a running lane, the first ⌘W shows `Press ⌘W again to close <lane> — it is
     mid-turn`, and the lane stays.
   - A second ⌘W within 2.5 s closes it.
   - After the toast is gone, the next ⌘W arms again.
   - On an idle or waiting lane, the first ⌘W closes it.
8. **Forget.** With lanes running, open the gallery card ⋯. Forget should be disabled and
   read `Forget project — close it first (N agents open)`. Check its contrast in the light
   palettes; B3 asks for this. After closing the project, Forget should be enabled and red
   again, and still need two clicks. Repeat on a Previous row that holds a suspended lane.
9. **Quit while the dialog is open.** With the close dialog open, press ⌘Q. Only the quit
   guard should show, and pressing `Stay open` should bring back the close dialog.

## Not done, and open points

- Task 5 (lane ⋯ menu in the toolbar, right-click opens the lane menu) and task 9 (Suspend
  items) need the user's decision first.
- The palette's "Close this session" is still unguarded. The audit only asked for ⌘W to be
  guarded.
- The `closing…` chip has no upper time limit. A close that hangs forever keeps the chip up,
  and Retry waits on that same close. Main's kill dedupes a second kill call, so starting a
  new close would also wait on the same kill.
- While the close dialog is open, chords other than Esc, ⌘. and Tab still reach the app (⌘W,
  ⌘K). The quit guard behaves the same way.

## Round 2: Review fixes (R1-R8) and the lane menu (tasks 5 and 9)

Review: `dev/results/lifecycle-fixes-review-2026-10-24.md`. Branch `operator/95b180`, on top of
2648dca. Not merged. Not GUI-verified.

### Part A: R1-R8

- **R1, held ⌘W.** `closeKeyAction(lane, armed, now, repeat)` returns `ignore` for an auto-repeat,
  and the ⌘W branch passes `e.repeat` and returns on `ignore` before anything arms or closes. That
  also stops a repeat from closing the lane that becomes active after a close.
- **R2, one close per lane.** New `LaneCloses` (lib/close-key) keyed by terminal id. Every caller
  goes through `handleCloseSession`, which runs the close through it: the rail ■, ⌘W, the Team
  card, the palette, the project close and its Retry. A second ask gets the running close, with
  the first one's reason (a lane being suspended is not also forgotten). `endProjectLanes` no
  longer has its own map.
- **R3, woken suspended lane.** When the close of a suspended lane waits on a resume in flight,
  it files itself under the new terminal id too (`alias`), and `closedAs(old)` returns that id
  for 60 s. `endProjectLanes` judges each lane by every id it had: the original, `closedAs`, and
  the id its tab carries now (looked up by tab key). `stuckAfterClose` takes those ids
  (`CloseAttempt.ids`) and returns a stuck lane under the id that is alive, so Retry finds the
  resumed lane.
- **R4, dialog keys.** New `guardKeyAction` (lib/guard-keys): Esc and ⌘. answer the safe verb, Tab
  cycles, and every `isAppChord` chord plus ⌘E is blocked with preventDefault and
  stopPropagation. preventDefault matters because the native File menu closes the window on ⌘W
  when nothing takes it. ⌘Q and ⌘C go through. This applies to both guards.
- **R5, focus.** `keepFocus()` (lib/guard-keys) saves `document.activeElement` on mount and
  restores it on unmount if it is still in the document. Both guards.
- **R6, dialog copy.** `CloseGuardLane.folder` (`worktree` | `checkout` | `released`), set in
  `requestCloseProject` from the tab: released per the release cache, own worktree when
  `worktreeBranch && sourceCwd && cwd !== sourceCwd`, else checkout. `closeGuardCopy` takes the
  lanes and says, per kind: no CLI for suspended lanes, nothing removed or committed in the
  project folder, a released folder removed only if clean. With mixed kinds it counts each. Every
  sentence after the first binds its first word with U+00A0. A project whose lanes all run in
  their own worktree reads exactly as before.
- **R7, rail row ■ after a click.** Confirmed by reading the code. The terminal is focused on
  mount and on window activation, and selecting the row that is already active moves no focus, so
  the row kept focus and the ■ stayed. The row now sets `focusWithin` only for keyboard focus
  (`isKeyboardFocus`, lib/keyboard-focus, `:focus-visible`; an engine that cannot parse it reads
  as keyboard, which keeps the reveal reachable).
- **R8.** The project home's Close tooltip is now a JS string with `Its roster`. A JSX
  attribute string does not process the escape.

### Part B: the lane menu (task 5) and Suspend (task 9)

- `laneActionItems` (lib/lane-actions, pure) builds the list: **Close session** (arms when the lane
  is running or suspended; `⌘W` hint only on the active lane, the one ⌘W closes; disabled with no
  terminal), **Restart on Claude Code X** (only when out of date; disabled while busy),
  **Suspend — keep the conversation** (only when the rules allow it now), and **Lane colour…**
  under a hairline, which opens the AccentPicker at the menu's coordinates. DashboardView maps each
  action to its handler (`laneActionMenu`) and renders one `CardMenu` titled with the lane's label.
- `CardMenuItem.hint`: a right-aligned mono shortcut in `--fg-muted`, not drawn on a disabled item,
  so the 0.4 opacity never stacks on `--fg-muted`.
- **Entry 1:** a `⋯` in `SessionToolbar`, right cluster, before the side-panel toggle: `chipBase`,
  `CHIP_H` square, `--fg-muted` ink that goes to `--fg` on hover and while open, no opacity, title
  "Lane actions", `data-popmenu-trigger`. A second click closes the menu.
- **Entry 2:** right-click on the collapsed orb (`RailOrb`), the expanded orb, or anywhere on the
  expanded row (`SessionItem`; skipped while renaming) opens the lane menu at the coordinates the
  accent picker used. The row's right-click anchors under its orb, so both routes open in one
  place. `ProjectRail`'s `onPickAccent` is renamed `onLaneMenu` down to `SessionItem`. The Team
  cards' recolour right-click is unchanged.
- **Suspend by hand:** `suspendByHand` runs `suspendPlanned` for the one lane at threshold `now`,
  with `focused: false`. The person asked, so the quiet time and "you are looking at it" are
  dropped; every other rule holds. It reads the transcript first when that is unknown.
  `suspendLane` takes `{ byHand: true }` to allow the active lane. A refusal pushes
  `<lane> keeps running` with `Not suspended: <reason>.` The item shows only when
  `canSuspendByHand` passes with the transcript and dev-server reads taken as passing, so a
  coordinator, a mid-turn lane, one with unsent text or background work never offers it.
- Not added: "Suspend all" in the project close dialog (declined by the user).
- `dev/drive-accent-picker.mjs`: the rail right-clicks now click `Lane colour…` before looking for
  swatches. Not run (needs the app).

### Tests

- `close-key.test.ts`: repeat ignored (armed, unarmed, idle lane); `LaneCloses` joins a running
  close, starts a new one after it settles, files a woken lane under its new id and remembers it.
- `project-shelf.test.ts`: `stuckAfterClose` judges a woken lane by its new id and returns it under
  that id; not stuck once the new CLI stopped.
- `guard-keys.test.ts` (new): safe, cycle, block for app chords and ⌘E, pass for ⌘Q, ⌘C and plain
  keys; `keepFocus` restores, and does nothing for a removed element.
- `keyboard-focus.test.ts` (new): follows `:focus-visible`, fallback on a parse error, null target.
- `project-close-guard.test.ts`: body per kind (checkout, released, suspended, a four-kind mix, all
  suspended in the checkout) with the no-break spaces, and the all-worktree text unchanged.
- `lane-actions.test.ts` (new): order, arming, ⌘W only on the active lane, Restart and Suspend
  only when they apply, distinct labels with no ■ or ✕, Close disabled with no terminal.
- `lifecycle-wiring.test.ts`: pins updated for R1, R2, R3, R6 and R7; new pins for the dialog's key
  block and focus restore, the toolbar ⋯ toggle, the rail and row right-click, Colour in the menu,
  and the suspend-by-hand rules.

Results:
- Root `npx vitest run`: 129 files, **2018 passed**. Root `npx tsc --noEmit -p .`: clean.
- Electron `npx vitest run`: 56 files, **998 passed**.
- Electron `npm run typecheck` (main + renderer): clean.

### In-app checks for QA (added)

10. **Held ⌘W.** On a running lane, hold ⌘W for about a second. Expected: the arm toast, and the
    lane stays. Release and press once more within 2.5 s: it closes.
11. **Close while closing.** Close a project whose QA lane is slow to stop. While the toast
    reads `QA did not stop`, press QA's ■ twice on the rail. Expected: no second `Kept the
    worktree folder…` error, and QA ends once.
12. **Dialog keys.** With the close dialog open, press ⌘W, ⌘N and ⌘K. Expected: nothing happens
    behind the scrim. Press Esc: the dialog closes and keys typed next go into the lane you were
    in.
13. **Dialog copy.** Close a project with one lane in the main checkout (worktrees off), and one
    with a suspended lane. Expected: the body says nothing is committed for the first, and that
    no CLI is running for the second.
14. **Row ■ after a click.** Click the active row on the expanded rail and move the pointer away.
    Expected: the phase word comes back. Tab to the row: ■ shows.
15. **Lane menu.** At 264 and at 70 and with the rail hidden: open the toolbar ⋯, right-click an
    orb, right-click an expanded row. Expected: one menu titled with the lane, in the same place
    for the orb and its row. Close session arms on a live lane. Lane colour… opens the picker.
    On an idle worker lane that has had a turn, Suspend — keep the conversation suspends it (the
    pane shows the suspended overlay) and a click resumes it. The coordinator's menu and a running
    lane's menu have no Suspend item. Check both themes.

### Open points

- The palette's "Close this session" is still not guarded for a mid-turn lane (unchanged).
- The `closing…` chip still has no upper time limit (unchanged).
