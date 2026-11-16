# Review: lane and project lifecycle fixes (2026-10-24)

Branch `operator/95b180`, tip `2648dca`, based on main `ac4591a`. Commits `f6a740d` to `993c026`
(tasks 1-4 and 6-8 of Design's audit) plus two results commits. Spec read:
`operator/b6fe00:dev/results/lifecycle-ux-audit-2026-10-24.md`. Code's write-up:
`operator/95b180:dev/results/lifecycle-fixes-2026-10-24.md`. Line numbers are at `2648dca`.

## Tests run

On an export of `2648dca`:

- Root `npx vitest run`: 126 files, 1983 passed.
- Root `npx tsc --noEmit -p .`: clean.
- Electron `npx vitest run`: 56 files, 998 passed.
- Electron `npm run typecheck` (main + renderer): clean.

## Findings, most severe first

### R1. Medium: holding ⌘W slightly too long defeats the mid-turn guard

`src/renderer/views/DashboardView.tsx:5418-5440`, `src/renderer/lib/close-key.ts:16`.

The handler does not look at `e.repeat`, and neither does `isAppChord` (`lib/key-routing.ts:19`).
macOS sends auto-repeat keydowns for a held ⌘W. The first event arms, and the first repeat
arrives well inside the 2.5 s window, on the same lane, so it closes.

Failure scenario: Code is mid-turn. The person presses ⌘W and holds it a little longer than a tap
(past the system's initial repeat delay, a few hundred milliseconds at the default setting). The
arm toast flashes and the lane is closed in the same gesture. Its saved session is forgotten, so
the turn is lost with no resume. That is the loss task 7 exists to prevent. Ignoring
`e.repeat` for the close branch (or for every app chord) fixes it.

### R2. Medium-low: the double-close guard covers Retry only; the lane's own ■ or ⌘W starts a second close while the first is still running

`src/renderer/views/DashboardView.tsx:1445` (`lanesClosingRef`), `closeLane` at `:3845`.

`lanesClosingRef` is the only dedupe, and only `endProjectLanes` reads it. ⌘W, the rail row ■,
the Team card ■ and the palette's "Close this session" call `handleCloseSession` directly.
`closeLane` has no in-flight guard of its own.

The new toast creates exactly the window where this happens. "QA did not stop" means QA's pty is
still alive at 4 s, which means the first `closeLane` is still awaiting `terminalKill`. QA's rail
row is still there, and its ■ is the obvious thing to press instead of Retry.

Failure scenario: Close project. QA's kill is slow, so the toast says `Closed 3 of 4 agents in
web27 · QA did not stop`. The person presses QA's ■ twice on the rail, which starts a second
`closeLane(QA)`. Main answers both kills with the same result. Each close then runs its own
removal chain (`:3893`): two `worktreeStatus`/`worktreeCommit` passes race on the same folder,
then two `worktreeRemove` calls. The second removal fails and pushes `Kept the worktree folder for
<branch>` as an error for a folder that is gone. The write-up's own comment at `:1442` names
this hazard. The map belongs in `handleCloseSession` (or `closeLane`), so every caller shares it.

### R3. Medium-low: the 4 s aliveness check reads the wrong terminal id for a suspended lane that is being woken

`src/renderer/views/DashboardView.tsx:3976-3980`, `:1478`, `:1500`.

For a suspended lane, `handleCloseSession` waits for a resume already in flight and closes the
lane it brought back, which has a new terminal id (`back.id`). `endProjectLanes` judges aliveness
on the id it was given, `s.terminalId`, which is the old, dead one. That lane is therefore never
reported as stuck and is counted as ended.

Failure scenario: Research is suspended. A dispatch to it starts a resume, and the person closes
the project while the resume is running. The close waits for the wake and then for the new pty's
kill. If that runs past 4 s, the toast reads `Closed web27 — 4 agents ended` with no Retry while
the resumed CLI is still running. If its kill hangs, nothing ever reports it. The check should
read the terminal id the close actually ended. For example, `closeLane` could return it, or the
check could look the lane up by `tab.key` after the close.

### R4. Low-medium: the dialog does not keep app chords away from the app, although its comment says it does

`src/renderer/components/GuardDialog.tsx:47-63`.

The capture listener only handles Esc, ⌘. and Tab. Every other key still reaches the window
handler. The comment at `:61` ("a chord handler further down (⌘K, ⌘W, ⌘1-9) never sees a key aimed
at this") is wrong. Code's write-up lists this as an open point, but for the close guard it has
consequences beyond what the quit guard had.

Failure scenarios with the close dialog open:

- ⌘W closes the active lane with no listing. If the lane is idle, nothing confirms it at all.
- ⌘N starts a lane. End then ends it too, although the dialog never named it.
- ⌘K opens the palette under the scrim (palette z 1000, dialog 1100). The palette takes keyboard
  focus, and its Return runs palette actions while the dialog is still on screen.

Stopping propagation of every app chord (`isAppChord`) in the capture listener would fix both
guards.

### R5. Low: focus is not restored when the dialog closes

`src/renderer/components/GuardDialog.tsx:44`, `DashboardView.tsx:7241-7247`.

The dialog moves focus to Keep running on mount. On Keep, Esc or End it unmounts, and focus falls
to `body`. Typing after Esc goes nowhere until the person clicks back into the terminal. This is
the same in QuitGuard and is not new there, but Close project is opened from inside a lane far
more often than ⌘Q is pressed. Saving `document.activeElement` on mount and restoring it on
unmount would fix both guards.

### R6. Low: the dialog body says things that are not true for some lanes

`src/renderer/lib/project-close-guard.ts:81-82`.

"Its CLI stops and its worktree folder is removed. Unsaved changes are committed to its branch
first." `closeLane` does that only when `plan.rendererRemovesWorktree` and the lane has its own
worktree (`DashboardView.tsx:3893`).

- A lane in the main checkout has no worktree folder, and nothing is committed.
- A lane that called `worktree_done` is not WIP-committed. Main decides, and it keeps the
  folder if anything is unsaved.
- A suspended lane has no CLI to stop.

Failure scenario: a project whose only lane runs in the main checkout with uncommitted edits. The
dialog says those changes will be committed to its branch. They are not, and they stay in the
working tree. A person who relied on that sentence goes looking for a WIP commit that does not
exist.

### R7. Low (plausible, check in the app): a mouse click on a rail row can leave ■ showing in place of the phase word and hints

`src/renderer/components/sidebar/SessionItem.tsx:128-129`, `:90`.

The row is `tabIndex={0}`, so a mouse click focuses it. `focusWithin` is set from `onFocus`, which
fires for mouse focus too, not only for keyboard focus. When the click does not move focus into
the terminal afterwards (the active row clicked again, for example), the row keeps focus. The ■
then stays where the phase word, effort and ⌘N hint belong, after the pointer has left. Whether
lane activation always moves focus to the terminal is not visible from the diff. If it does not,
checking `:focus-visible` (`e.currentTarget.matches(':focus-visible')`) limits the reveal to the
keyboard, which is what the audit asked for.

### R8. Low: one display string misses the no-break-space rule

`src/renderer/components/session/ProjectView.tsx:169`.

The button's tooltip is "End this project’s agents and take it off the rail. Its roster, tasks and
notes stay." `Its` is not bound to `roster`, so a native tooltip can wrap with `Its` alone after
the full stop. Every other new string with a sentence break binds the word: the dialog body, the
toast details and the palette detail.

## Checked and clean

- **Wrong lanes.** `closePlan` filters by `projectId` and requires a terminal id, so other
  projects' lanes and project-less sessions are never touched. Suspended lanes are included
  (`status !== 'ended' || suspended`). On End, `closeProject` plans again from the live rail, so a
  lane started while the dialog was open is ended and counted in the toast, which is what the
  audit specifies. A project whose lanes all ended while the dialog was open closes with `Closed X`.
- **Retry.** Retry re-reads the stuck lanes from the rail and reuses an in-flight close from
  `lanesClosingRef`, so Retry itself never starts a second close. The toast's action calls
  `beginExit`, so the Retry button goes away when pressed.
- **Aliveness fallback.** When `terminalList` cannot answer after the bound, `stuckAfterClose` uses
  `!settled && !wasDead`, which is the old reading. A lane whose pty was already dead is marked
  ended and never reported stuck.
- **QuitGuard extraction.** I compared the old and new markup and handlers line by line. Scrim,
  panel, rows, overflow, the idle line, the hint, button order and styling, the focus-on-mount,
  the Esc and ⌘. handling and the Tab cycle are the same. The only change is the aria ids, which
  are now built from the `quit-guard` prefix and so produce the same strings. The close guard is
  hidden while a quit request is up (`:7241`) and returns after `Stay open`.
- **⌘W arming and other ⌘W uses.** The only ⌘W handler in the renderer is this one; the palette's
  "Close this session" is a separate, unguarded entry, as Code noted. Arming on lane A and then
  pressing ⌘W on lane B re-arms B and takes down A's toast. An idle, waiting or ended lane closes
  on the first press, as before.
- **Forget.** The gallery card, the Previous row and `forgetProject` all count lanes with
  `lanesToEnd` over the same `projectActivities` (from `allSidebarSessions`). Lanes that have
  exited (`status: 'ended'`, not suspended) do not count, so Forget is enabled again once every
  lane has ended. The disabled item drops the danger tone, so it is `--fg` at 0.4, not faded red.
- **Glyphs.** `■` is now used only for close session (rail row and Team card). `✕` stays delete
  lane. No other verb uses `■`.
- **Opacity.** Every `--fg-muted` use in the new code (dialog body, state words, overflow, note,
  hint, Close project button) has no opacity on it.
- **Stray words.** The dialog body and mid-turn lines use literal U+00A0 after `Unsaved`,
  `Branches,`, `That` and `The`. The success toast detail and the palette detail use ` `.
  The other new strings are single sentences. The one miss is R8.
- **Dialog keys.** Esc and ⌘. answer Keep, Tab and Shift+Tab cycle only the two buttons, and
  Keep has focus on open.

## Recommendation to the coordinator

R1 and R2 are for Code before merge. R1 is a one-line `e.repeat` check, and R2 means moving
`lanesClosingRef` into `handleCloseSession`. R3 and R4 are small, also for Code. R5, R6 and R8 are
copy and focus fixes. R7 needs QA's in-app check first (step 6 of Code's list: click the active
row and look at its right side).
