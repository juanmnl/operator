# Review round 2: lifecycle fixes and the lane menu (2026-10-25)

Branch `operator/95b180`, commits `494d255` (Part A, round-1 R1-R8) and `85e0e80` (Part B: lane menu,
Suspend by hand), diff `git diff 2648dca 85e0e80`. Round 1:
`dev/results/lifecycle-fixes-review-2026-10-24.md`. Design reference:
`operator/b6fe00:dev/results/lifecycle-ux-audit-2026-10-24.md`, B1 and B2. Line numbers are at
`85e0e80`.

## Tests run

On an export of `85e0e80`:

- Root `npx vitest run`: 129 files, 2018 passed.
- Root `npx tsc --noEmit -p .`: clean.
- Electron `npx vitest run`: 56 files, 998 passed.
- Electron `npm run typecheck` (main + renderer): clean.

## Round-1 findings: status

| Finding | Status |
|---|---|
| R1 held ⌘W closed a mid-turn lane | Closed. `closeKeyAction(..., e.repeat)` returns `ignore` before arming or closing. |
| R2 second close of one lane | Closed. Every caller goes through `handleCloseSession` → `LaneCloses.run`. `closeLane` has no other caller. T3 covers a side effect of the dedupe. |
| R3 woken suspended lane judged by its dead id | Closed. The check uses `[original, closedAs, current id by tab key]`, and a stuck lane is returned under the live id. |
| R4 app chords reached the app behind the dialog | Closed. `guardKeyAction` blocks `isAppChord` and ⌘E with preventDefault and stopPropagation, in capture. |
| R5 focus not restored | Only partly closed; see T2. |
| R6 dialog copy wrong for some lanes | Closed. The body is built per lane kind, and every sentence after the first binds its first word. |
| R7 ■ left showing after a mouse click | Closed. The reveal follows `:focus-visible`. |
| R8 tooltip `Its` unbound | Closed. It is a JS string with ` `. |

## New findings, most severe first

### T1. Medium: "Suspend — keep the conversation" on the active lane resumes it straight away

`src/renderer/views/DashboardView.tsx:4187` (`byHand` lets the active lane through),
`:4225-4226` (`markSuspended` writes `idleSuspendedAt` into `terminals`), `:4597-4603`
("FOCUS RESUMES").

The FOCUS RESUMES effect runs on `[activeTerminalId, terminals, reattachDone]`. When the active
tab has `idleSuspendedAt` and its key is not in `wakeFailedRef`, it calls `wakeLaneRef.current(tab)`.
A by-hand suspend of the active lane does the following:

1. `markSuspended` sets `idleSuspendedAt` on the tab that `activeTerminalId` still points at.
2. The effect fires and asks for a wake.
3. The wake waits on the lane's gate, which `suspendLane` holds until the kill settles.
4. The lane is then resumed with `--resume`.

The automatic suspend never hit this, because it refuses the active lane. Part B is the first path
that suspends the lane on screen.

Failure scenario: the person opens the toolbar ⋯ and picks Suspend. The toolbar ⋯ always targets
the active lane, so the toolbar route always hits this. The pane shows "Suspended", then
"Resuming…", and a new CLI starts on the same conversation. Nothing was saved. The lane cost a
kill and a cold start, and it is running again. The same happens from a right-click on the active
lane's orb or row. QA step 15 ("the pane shows the suspended overlay and a click resumes it") will
fail. This needs a GUI check. The effect and its deps are as quoted, so I expect the check to
confirm it.

Possible fixes, for Code to choose:
- Mark the key so the focus effect skips it until the next deliberate open. For example, add it
  to a set the effect checks, and clear the set on the next `activeTerminalId` change or overlay
  click.
- Move the view off the lane before suspending it.

### T2. Low: focus still falls to `body` when the close dialog is opened from a menu or the palette

`src/renderer/components/GuardDialog.tsx:47`, `src/renderer/lib/guard-keys.ts` (`keepFocus`).

`keepFocus` saves `document.activeElement` when the dialog mounts. Three of the four entry points
are a CardMenu item (the rail ⋯ and the gallery ⋯) or the palette. The item click closes the menu,
or the palette, in the same commit that opens the dialog, so by the time the dialog's effect runs,
the focused element is gone and `activeElement` is `body`. `restore()` then has nothing to put
back. Only the project home's Close button survives, and it is not the terminal either.

Failure scenario: in a lane, open the rail tile's ⋯, pick Close project, press Esc. Typing goes
nowhere until the person clicks the terminal. This is the R5 case through the most common route.
The quit guard (⌘Q, focus in the xterm) is fixed. Capturing the focused element when the menu or
palette opens, or falling back to the active terminal, would cover it.

### T3. Low: a close joined while the automatic retire close runs can be silently dropped

`src/renderer/views/DashboardView.tsx:3993-3994`, the retire path at `:2450` and the lifecycle path
at `:4695`, both of which pass `{ auto: true }`.

`LaneCloses.run` hands a second caller the first close, with the first caller's arguments. The
automatic close of a released lane (`opts.auto`) finishes its tasks first and then re-reads the
release. If the lane took work, it returns `took-work` and leaves the lane running on purpose.

Failure scenario: a dispatch is retiring a released lane, and during those seconds the person
presses that lane's ■ twice on the rail. Their close joins the auto close. If the lane took work,
nothing closes, and the person's explicit close produced no feedback. The reverse order (person
first, auto joins) is fine. A joiner whose intent is stronger (a person's close over an auto one)
could wait for the first close and run its own if the first returned anything but `closed`.

## Answers to the specific questions

- **A stuck close blocking later closes (`LaneCloses`).** Yes: while a close of a lane never
  settles, every later ask for that lane (■, ⌘W, the Team card, the palette, Retry) gets the same
  promise. That is not a regression. Before this change, a new close called `terminalKill` again,
  and main answers a second kill with the first, so it hung the same way. For a suspended lane,
  the hang sits in `closeUnderGate` or the wake, which a second close also waited on. The entry is
  dropped on settle or rejection, so a close that fails fast does not block the next one.
- **The multi-id check (R3).** It is correct. `closedAs` is filed only by the close that started
  (joiners share it), is kept for 60 s after settle, and is read after the 4 s bound. The id by
  tab key finds the resumed lane, because a resume keeps the key. A fresh launch gets a new random
  key and the closed lane's saved row is forgotten, so an unrelated new lane cannot be picked up as
  "alive". `wasDead` still uses only the original id, which only marks an old tab ended that no
  longer exists. That is harmless.
- **guard-keys.** It blocks what it should: ⌘/Ctrl + K, N, B, W, J, ', ", 1-9, ⌘⇧O and ⌘⇧P, and ⌘E.
  It lets through Esc and ⌘. (which answer the safe verb), Tab (which cycles), Enter and Space on
  the focused button, ⌘Q (the quit guard takes over, and the close guard hides behind it) and ⌘C.
  The dialog has no text field, so no typing is swallowed. Menu accelerators such as ⌘R and ⌘'
  are not keydown chords and still fire, which is acceptable.
- **`laneActionItems`.** The rules match B1:
  - Close is first, arms when the lane is running or suspended, shows ⌘W only on the active lane,
    and is disabled with no terminal.
  - Restart appears only when the lane is out of date, disabled while busy.
  - Suspend appears only when `canSuspendByHand` passes.
  - Colour is last, under a hairline.
  - No item uses ■ or ✕.
  - The menu rebuilds on `sessions`, so a lane that turns mid-turn loses Suspend while the menu is
    open.
- **By-hand suspend on the active lane.** The terminal view is not torn down: the tab stays, the
  pane stays mounted, and `SuspendedOverlay` takes focus (`active` is true), so keys go to it and
  not to the dead xterm. Resuming by click works too. The problem is that it resumes without a
  click (T1).
- **The right-click change.** The accent picker is still reachable through "Lane colour…", which
  opens it at the menu's coordinates. The picker dismisses on `mousedown`, so the click that chose
  the item cannot close it. The collapsed orb, the expanded orb and the row all open one menu,
  anchored under the orb. `RosterPanel` is not in the diff, so the Team cards are unchanged.
- **Palette "Close this session" without the mid-turn guard.** I would not call it a defect of
  the same kind as R1. ⌘W can fire by reflex. The palette needs ⌘K, a search and Enter, which is a
  choice. Two things make it worth one small change, for Code:
  - the item carries the `⌘W` hint, which says it is the same command, but it skips the arm;
  - a fuzzy query like `co` can rank it first, so Enter closes a mid-turn lane in one keystroke.

  Arming it (run `closeKeyAction` and show the same toast) would make the two consistent. Low
  priority.

## Checked and clean

- **House rules.** The toolbar `⋯` is `--fg-muted` with no opacity, and `--fg` on hover and while
  open. `⋯` is the menu mark used elsewhere, not a verb, and `■` stays close session only. The
  CardMenu `hint` is `--fg-muted` and not drawn on a disabled item, so the 0.4 opacity never stacks
  on it. Every multi-sentence dialog body goes through `sentences()`, which binds the first word of
  each later sentence with U+00A0. The suspend refusal toast is one sentence.
- **Toolbar ⋯ toggle.** It works: a second click closes the menu, because the trigger carries
  `data-popmenu-trigger`, and the open state colours the button.
- **R6 copy.** `folder` matches `closeLane`'s own test:
  - `released` from the release cache;
  - `worktree` when `worktreeBranch && sourceCwd && cwd !== sourceCwd`;
  - `checkout` otherwise.

  A project whose lanes all run in their own worktree reads exactly as before.

## Recommendation to the coordinator

T1 is for Code before merge: as built, the toolbar's Suspend never leaves a lane suspended. T2 and
T3 are small and also for Code. The palette arm is optional. QA's step 15 should be run after the
T1 fix, from both the toolbar ⋯ and a right-click on a lane that is not active.
