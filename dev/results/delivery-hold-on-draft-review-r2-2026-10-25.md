# Review round 2: delivery hold on draft (2026-10-25)

Commit reviewed: `7336073` on `operator/98a1c0` ("Keep held deliveries across a renderer reload and
fix the draft-hold review findings"), diff `git diff ac7a75b 7336073`. The branch tip `88c0332`
(also `operator/17f40`) adds only Code's notes to `dev/results/delivery-hold-on-draft-2026-10-24.md`.
Round 1: `dev/results/delivery-hold-on-draft-review-2026-10-24.md`. Line numbers are at `7336073`.

## Tests run

On an export of `7336073`:

- Root `npx vitest run`: 123 files, 1986 passed.
- Root `npx tsc --noEmit -p .`: clean.
- Electron `npx vitest run`: 57 files, 1001 passed.
- Electron `npm run typecheck` (main + renderer): clean.

## Round-1 findings: status

| Finding | Status |
|---|---|
| F1 held messages lost on reload | Closed for a reload. A relaunch marks the record `undelivered` with a note. Residual cases: S3, S4, S5. |
| F2 Deliver now released every message | Closed. `deliverNow` forces only `headSeq`, and only while `holding`. |
| F3 held keys deadlocked behind a held message | Closed. `draft(id, text, onWrite)` marks the draft at the write, inside the chain. |
| F4 `\` + Enter read as a send | Closed for typed input. S2 covers a case that still differs from the binary. |
| F5 double Esc kept the hold; announce pass blocked | Closed for the plain composer. S1 covers a case the binary handles differently. The announce pass now skips a coordinator with a draft. |
| F6 held announcement written mid-turn | Closed in the live renderer (`onlyIf`, `DashboardView.tsx:5280`). S3 covers the reload path. |
| F7 Preview images split from text | Closed. The images are written in the same step, after the hold. S4 covers the reload path. |
| F8 toolbar command typed into a draft | Closed. `submitTyped` resolves false and the toolbar records nothing. |

## New findings, most severe first

### S1. Medium-low: double Esc is read as "cleared" while Claude Code's suggestion list is open, but the TUI does not clear then

`src/renderer/lib/lane-keystrokes.ts:60-62`.

In the 2.1.310 binary the prompt input is rendered with `disableEscapeDoublePress:U_`, where
`U_=Uf.length>0`. The same list drives `disableCursorMovementForUpDownKeys` (`ZDe=Uf.length>0||go`),
so it is the suggestion list: the `@` file picker and the `/` command menu. While that list is
showing, the input's escape handler returns before the double-press hook runs
(`case"escape":if(Z)return;return qt(),b`). The first Esc closes the list. The second Esc is then
the first press of a new pair and only shows "Esc again to clear". The text stays.

`draftEffect` sees two Escapes within 800 ms and returns `clear`. The flag goes off with the text
still in the composer, and the next delivery merges into it. That is the original bug.

Failure scenario: the person types `look at @src/ren`, and the file picker opens. They double-tap
Esc to dismiss it, a common reflex. The picker closes, and the text stays. A dispatch arrives and is
pasted after `@src/ren`, and its CR sends both as one turn.

A fix could require the pair to start after a key that cannot open a suggestion list. More
precisely, it could reset `prevKey` when the key before the first Esc was `@` or `/`, or any
character typed after them in the same word. Either way it needs a GUI check. The 800 ms window
itself matches the binary: `J5(e,o,r,t=a)` uses `d-i.current<=t`, inclusive, as the comment says.

### S2. Low: `\` + Enter is read from the previous key, but the binary reads the character before the cursor

`src/renderer/lib/lane-keystrokes.ts:59`, `:89`.

In the binary, Enter inserts a newline when `b.text[b.offset-1]==="\\"`, the character before
the cursor, whatever key put it there. `draftEffect` only checks whether the previous keydown was
`\`. The two disagree in these cases, and in each one the flag clears while the text stays:

- A paste that ends in `\`, then Enter. `notePaste` deletes `prevKey`, so Enter reads `clear`.
- `\`, then another character, then Backspace, then Enter. The previous key is Backspace.

Failure scenario: the person pastes a Windows path ending in `\` and presses Enter to start a new
line. Claude Code inserts a newline. The flag clears, and the next delivery merges into the
two-line draft. This is rare, but it is the same merge.

### S3. Low: after a reload, an owed announcement is re-submitted without `onlyIf` and is never marked delivered

`src/renderer/views/DashboardView.tsx:3059`.

The restore re-submits every owed text with a plain `submitQueue.submit(o.terminalId, o.text)`.
For an announcement line that loses two things:

- the `onlyIf` idle check, which was F6's fix;
- the `artifactMarkDelivered` call, which `serveCoordinator` made after the write and which died
  with the old renderer.

Failure scenario:
1. The announce pass enqueues `report #N ready` for an idle coordinator.
2. The person starts typing in that coordinator before the write, so the line is held.
3. The renderer reloads. The coordinator's draft is restored (unknown), and the line is
   re-submitted and held again.
4. The person presses Enter, which starts their turn. 350 ms later the line is written into the
   running turn (the F6 case).
5. The report is still undelivered, so after the turn the announce pass types the same line again.

The window for step 2 is small: the pass skips a coordinator with a draft, so typing must begin
during the pass's two IPC reads or the gap. When it happens, the result is a mid-turn line and a
duplicate. Recording an `onlyIf` kind on `OwedSubmission`, or not re-submitting announcement lines
at all (they are durable in `artifacts.db`), would close it.

### S4. Low: a re-submitted Preview annotation loses its images

`src/shared/types.ts` (`OwedSubmission`), `src/renderer/lib/submit-queue.ts:566`.

`OwedSubmission` has no `images` field, and the ledger's `owe` is given only the text. After a
reload, a held annotation is re-submitted as text alone. The lane gets "the button is misaligned
here" with no `[Image #N]`.

### S5. Low: a `held` record can stay `held` after its message is delivered

`src/renderer/lib/submit-queue.ts:511`, `src/renderer/views/DashboardView.tsx:3067`.

The record goes back to `sent` only through `ledger.held(..., false)`, which fires only when
`entry.held` is true, meaning the new queue held this submission. After a reload, a re-submitted
message whose record already reads `held` but that is not held again is written with no
`held(off)`. `settleUnreturnedHeld` keeps the record as `held` because the text came back. Nothing
then moves it.

Failure scenario: the person presses Enter on their draft. The flag clears in the renderer and in
main. The message is still in the 250 ms poll and 350 ms gap when the renderer crashes. After the
reload there is no draft to restore, and the owed message is re-submitted and written at once. The
lane got it, but the record reads "held · waiting on unsent text in the lane" for good. The window
is under a second.

### S6. Low: an owed message for a lane that was suspended across the reload is reported as "The lane ended before it was typed"

`src/renderer/views/DashboardView.tsx:3055`, `:3060`.

`live` excludes every `ended` tab, and a suspended tab is `ended: true`. An owed entry for a
suspended lane reaches `reportUndelivered(..., 'ended')` instead of the wake path that a divert would
have taken. This needs the renderer to die between a message's enqueue and the suspend's divert,
so it is rare. The record then reads `undelivered` for a lane a wake could still have reached.

## Code's deviation: only lanes main had a draft on are "draft unknown"

I agree with it. It does not leave a merge window that treating every re-attached lane as unknown
would close for an ordinary draft:

- Main hears every change of the draft set (`setDraft` → `onDraftChange` → `laneHoldNote`). The
  listener is installed in an effect at mount, before any pane can take a key. `restoreDrafts`
  re-sends `on`, which is harmless.
- While no renderer exists, there is no xterm to type into, so no new draft can appear during the
  gap.
- The only lost update is a keystroke whose `send` was posted in the same instant the renderer
  died.

What "every lane unknown" would additionally cover is text the flag never saw in the first place:
IME and dictation commits, drag-dropped text, pastes in the grid pane, and S1 and S2. Those merge in
a live renderer today too, so the reload adds nothing new for them. Holding every lane after every
reload, as Code says, would hold every announcement and block idle suspension until each lane was
visited. That cost is real, and the gain is only those pre-existing cases.

## Checked and clean

- **Ordering against `rendererReady`.** The restore awaits `laneHoldsTake`, restores the drafts,
  enqueues the owed messages, then calls `rendererReady` in `finally` (`DashboardView.tsx:3053-3076`).
  Main's held dispatches and replies are released after that, so they queue behind the owed ones.
  A failed `laneHoldsTake` still calls `rendererReady`. The 30 s ready fallback is far longer than
  this in-memory call. Projects are loaded before the re-attach starts (`savedHydrated` gates it),
  so `settleUnreturnedHeld` runs on the full list.
- **Double delivery after a reload.** The write and its `settle` are posted in the same
  synchronous step (`deps.write` then `written()`), both as ordered `send` IPC. A message written
  before the crash is settled in main and not handed back. `take()` clears the owed list, and the
  re-submissions come back as new `owe`s with a fresh `instance` key.
- **Main's memory.** `LaneHolds` is created once (`registerIpc` is called once, `index.ts:469`).
  The owed map is capped at 500, with the oldest dropped first. Draft flags for lanes that ended
  while no renderer existed stay in the set, but `take` is filtered by live tabs on the renderer
  side, and terminal ids are not reused within a run. Growth is a few strings per ended lane.
- **`held` transitions.** `record('sent')` runs synchronously after `void submitWhenReady(...)`.
  The queue reaches the hold only after `await whenLaneReady`, so the `sent` record exists before
  `flipHeld` looks for it. `reportUndelivered` now matches `held`. A relaunch turns every `held`
  record into `undelivered` with `HELD_LOST_NOTE`. A failed take does the same, which is accurate,
  because those messages are gone.
- **Announce pass.** `announceSkip` skips a coordinator with a draft. `onlyIf` refuses a held line
  and re-checks idle for an unheld one at the write. `submit` resolves false on a refusal and the
  report stays undelivered. `written()` settles a refused submission in the ledger.
- **Polling and listeners.** `DraftHoldNotice` uses one subscribe function for both stores, with
  stable snapshots (a number and a boolean). Every listener call is wrapped so a throwing listener
  cannot break the queue.
- **UI copy.** "1 message waits: after the reload, Operator can’t tell if you left text here" is one
  sentence, `--fg`, with no opacity. The button has no glyph.

## Recommendation to the coordinator

Nothing here blocks the merge as hard as round 1's F1 did. S1 is the one worth fixing before the
GUI check, because it brings back the exact merge for a common gesture; it is for Code. S2-S6 are
small and also for Code. Add a step to the GUI recipe: type `@src/`, double-tap Esc to close the
picker, then cause a message to that lane. Today it will merge.
