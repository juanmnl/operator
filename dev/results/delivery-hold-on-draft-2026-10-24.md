# Delivery holds on the person's draft (2026-10-24)

Implements Option 1 of `dev/results/delivery-cuts-user-input-2026-10-24.md`.
Branch `operator/98a1c0`, commit `8698c31`. Not merged. Not GUI-verified.

## What changed

### Submit queue: `src/renderer/lib/submit-queue.ts`

- New deps `hasUnsentInput` and `clearUnsentInput` on `SubmitQueueDeps` (:207). The app-wide
  queue wires them to `lib/lane-keystrokes` (:662). The tests inject a fake.
- `submit` now waits before the write while the lane has a draft (:458, loop at :465). The whole
  per-terminal chain waits there, so later messages keep their order. The 350 ms gap runs from the
  moment the draft clears. The draft is checked again after the gap, so typing that starts during
  the gap holds the message again. The wait has no timeout. It ends only when the draft flag clears
  (Enter, Ctrl+C, lane exit or restart), on `deliverNow`, or when the lane is diverted to a wake by
  idle-suspend. Poll interval: `DRAFT_POLL_MS = 250` (:183).
- The nudge generation, the confirmation counter and `pending`'s `at` are all taken after the
  hold, at the write. So the confirmation window, the rescue CR and the undelivered toast are
  timed from the write, not from the enqueue. The toast's only source is the queue's
  `onUndelivered` (`DashboardView.tsx` `reportUndelivered`), so nothing else needed to move.
- New methods (:321-330): `unwritten(id)` counts submissions queued and not written yet,
  `heldForDraft(id)` gives that count while the chain is held on a draft (0 otherwise),
  `deliverNow(id)` releases every submission enqueued so far, and `onHoldChange(fn)` subscribes
  to hold changes.
- Force-deliver behaviour: the first released message is pasted into the person's text and its
  CR sends both. After that write the queue calls `clearUnsentInput` (:496), so the next
  message is not held on a draft that has already gone. A message enqueued after `deliverNow`
  is held again.
- `clearComposer` writes nothing while the lane has a draft (:404). This is checked when its turn
  in the chain comes. It covers the retry path (`DashboardView.tsx` `retryDispatch`, comment
  updated). The retry's re-delivery that follows is then held like any other message.
- `owesSubmission(q, id)` (:635) = `pending` or `unwritten > 0`.

### Draft flag: `src/renderer/lib/lane-keystrokes.ts`

- `clearUnsentInput(terminalId)` (:63). The comment on the unsent-input section now says the
  submit queue reads the flag too.

### View: `src/renderer/views/DashboardView.tsx`

- Retire `settling` (:1248), the restart candidate (:4003), `handleRestartLane` (:4076), the
  suspend re-check (:4144) and the idle-suspend input (:4354) now use `owesSubmission`. A lane
  with a held message is not retired, restarted or suspended. `pending` is still read on its own
  where it means "written, awaiting a turn": the transcript confirmation (:639) and the
  announcement outcome (:5217, :5257).
- The draft flag is cleared on terminal exit (:657, before the restart early-return), in the
  stale-exit reconcile (:742), and after the kill in `handleRestartLane` (:4088).
- `<DraftHoldNotice>` is mounted on every live pane (:6922).

### Indicator: `src/renderer/components/terminal/DraftHoldNotice.tsx` (new)

- A pill centred at the top of the pane, away from the composer: "2 messages wait until you send
  or clear what you typed", plus a **Deliver now** button. The tooltip says the first message is
  added to the typed text and sent with it. The pill uses the same tokens as `EndedOverlay`. The
  label is `--fg` with no opacity, because it is text the person must read to act. The button has
  no glyph, so it shares a glyph with no other verb. The pill reads the queue through
  `useSyncExternalStore`, so a hold change re-renders only the pill and not DashboardView.

### Docs

- `src/renderer/lib/idle-suspend.ts:42`: the `pendingSubmission` doc now includes unwritten and
  held messages.

## Tests

New tests in `src/renderer/lib/submit-queue.test.ts`:
- `held on a person's draft` (:1104): hold (nothing written, counted as unwritten/held, not
  `pending`), no hold without a draft, release on Enter, release on Ctrl+C (Shift+Enter does not
  release), release when the exit clears the flag, burst order and gaps (another lane is not
  held), re-hold when typing starts during the gap, `deliverNow` (sends everything enqueued so
  far, clears the flag), `deliverNow` does not release later messages, hold-change listener, a
  10-minute hold that is not reported undelivered and is confirmed within the window from the
  write, divert while held.
- `clearComposer never runs over a draft (retry path)` (:1276): no write with a draft, normal
  clear without one.

One new test in `src/renderer/lib/lane-keystrokes.test.ts` covers `clearUnsentInput`.

Results:
- Root `npx vitest run`: 123 files, **1957 passed**.
- Electron `npx vitest run`: 56 files, **998 passed**.
- Electron `npm run typecheck` (main + renderer): clean. Root `npx tsc --noEmit -p .`: clean.

## Deliberately left out

- Bus delivery (Option 3): out of scope.
- `submitTyped` (toolbar `/model`, `/effort`), `attachImages` and `draft` are not gated. The person
  starts each of them from their own lane. Because they share the chain, a chip pressed while a
  message is held waits behind that message and goes out after it.
- Known false positive, as the report says: a draft deleted with Backspace still reads as a draft.
  Messages are held until Enter or Ctrl+C. The pill shows they are waiting, and Deliver now is
  harmless on an empty composer.
- Known false negatives, unchanged: IME/dictation text and drag-dropped text are not flagged.
  The grid pane flags keys but not pastes.
- An announcement to a coordinator with a draft holds that coordinator's announce pass until the
  draft clears. The per-tab in-flight entry keeps it to that one tab, and other coordinators are
  still served.

## GUI check for the user

Run the dev app on its own `OPERATOR_DIR` (see `reference_dev_launch`), with two live lanes in one
project: A = coordinator, B = worker. The steps follow the report's recipe.

1. In lane B, type `Please also check the`. Do not press Enter.
2. From lane A, cause a message to B (tell A "dispatch to B: say hi", or wait for a reply or a report
   announcement).
3. Expected now: B's draft stays as typed, nothing is submitted, and the pill at the top of B's pane
   reads "1 message waits until you send or clear what you typed". Press Enter. Your line goes as
   its own turn, then the message arrives as a separate turn about half a second later. Check with
   `grep -n "Please also check" ~/.claude/projects/<B-project-dir>/<session>.jsonl`: one turn with
   only your text, with no `[from A]` or `[Operator]` text after it. Repeat with Ctrl+C instead of
   Enter: the draft is cleared and the message arrives. Repeat once more and press **Deliver now**:
   the message is added to your text and both are sent as one turn. That is the intended result
   of forcing it.
5. Mid-turn variant: start a long turn in B, type a draft, deliver from A. Expected: no queued
   prompt appears until you press Enter. Then the transcript shows two separate
   `queue-operation: enqueue` entries, one for your draft and one for the message.
6. Retry variant: let a dispatch to B sit undelivered (`sent · never started`), type two lines in
   B, press Retry. Expected: your two lines stay. The re-delivery waits behind them and the pill
   shows it. Press Enter. Your lines go, then the dispatch goes. Known limit: if the original
   paste is still in B's composer, it goes out with your lines on Enter. The clear is skipped
   while you have a draft, and Operator cannot remove only its own text from the composer.

Also check that the pill disappears once the message is written, and that it does not cover the
composer.

## Fix round 1 (Review: `dev/results/delivery-hold-on-draft-review-2026-10-24.md`)

Branch `operator/17f40`, fast-forwarded from `operator/98a1c0` @ ac7a75b; `operator/98a1c0` moved to
the same tip. Not merged. Not GUI-verified.

### F1. Held messages survive a renderer crash or reload

- Main keeps what the renderer's queue owes each lane, and a copy of the draft flags:
  `electron/src/main/lane-holds.ts` (new, memory only, capped at 500 owed entries). IPC:
  `laneHoldNote(op)` (send) and `laneHoldsTake()` (invoke), in `env.d.ts`, `operator-api.ts`,
  `ipc.ts`. Types `OwedSubmission` and `LaneHoldOp` in `src/shared/types.ts`.
- The submit queue reports every submission to a `SubmissionLedger` dep: `owe` at the enqueue,
  `settle` when it is written, diverted, refused or dropped, and `held` on/off around a draft hold.
  DashboardView installs it (`onSubmissionLedger`) and sends `owe`/`settle` to main. Every change of
  the draft set goes to main too (`onDraftChange` in `lib/lane-keystrokes`).
- After the re-attach and before `rendererReady`, DashboardView takes the holds from main. Drafts on
  live lanes are flagged again and marked unknown (`restoreDrafts`). Owed messages for a live lane
  are submitted again, so they hold on that draft as before and go ahead of anything main releases
  next. Owed messages for a lane that is gone are reported undelivered ("The lane ended before it was
  typed.").
- New dispatch outcome `held`: a record goes `sent` → `held` when the draft holds its message and
  back to `sent` at the write (`flipHeld`, matched by text and role like `reportUndelivered`). Chip:
  "held · waiting on unsent text in the lane". This is the sign outside the pane that F5 asked for:
  the Comms log and the board show it. A `held` record that no message came back for at the next
  launch (the app quit with it held, so main started empty) becomes `undelivered` with a note
  (`settleUnreturnedHeld`). `reportUndelivered` now also matches `held`.
- **Deviation from the brief, deliberately.** The brief says to treat every lane re-attached after a
  reload as "draft unknown". I treat only the lanes main's mirror had a draft on. Main sees every
  draft change, so a lane with no flag in main had no draft when the renderer died (the only gap is a
  keystroke in the last IPC hop before a crash). Flagging every lane would hold every delivery and
  every announcement, and refuse idle suspension, on every lane after each reload until the person
  visits each one. That is the wrong cost while the renderer leak makes reloads the likely trigger
  for memory pressure. If you want the literal version, it is one line in the restore effect
  (`restoreDrafts(live)`).
- The pill's copy for an unknown draft: "1 message waits: after the reload, Operator can't tell if
  you left text here". Enter, Ctrl+C, double Esc, a typed key or Deliver now settles it.

### F2. Deliver now releases only the head

`deliverNow` forces only the submission at the hold (`headSeq`). After its write the flag clears,
so message 2 goes when no draft is left and holds again if the person starts typing. With nothing at
the hold it releases nothing. Tooltip: "the next message is added to what you typed".

### F3. Held keys no longer deadlock behind a message waiting on them

`submitQueue.draft(id, text, onWrite)` runs `onWrite` at the write, inside the chain.
`typeHeldKeys` passes `notePaste` through it instead of calling it before queueing. The messages
queued ahead of the text no longer see a draft that is not there yet.

### F4. `\` + Enter is a newline

`draftEffect(e, prev, now)` reads the previous key: Enter after `\` is `draft`. Modifier-only
keydowns are not recorded as the previous key. Not handled: an Enter that accepts an autocomplete
entry (`@` picker, `/` menu); not verified against the binary.

### F5. Double Esc clears the draft; the announce pass skips a coordinator with a draft

- Two Escapes within `DOUBLE_ESC_MS = 800` (from the 2.1.310 binary: `var a=800`, the double-press
  window used for "Esc again to clear", inclusive) clear the flag. A key between them, or a longer
  gap, does not.
- `announceSkip` / `coordinatorsToAnnounce` take `hasDraft`; a coordinator with a draft is skipped
  with "unsent text in the composer" in the announce log. Reports are durable, so they wait
  unannounced instead of holding the coordinator's in-flight entry.

### F6. No announcement after a hold

`submit` takes `opts.onlyIf(held)`, asked right before the write. The announce pass passes
`!held && canAnnounceTo(session)`: a held line is not written (the person's Enter has just started
a turn the session does not show yet), `submit` resolves false, and the report stays undelivered for
the next pass (5 s tick). `submit` now resolves to a boolean: true when written or diverted.

### F7. Preview images ride the same step

`submit(id, text, { images })` writes the image paste right before the text, after the hold. The
Preview's `onDispatch` uses it instead of `attachImages` + `submit`.

### F8. Toolbar slash commands are not typed into a draft

`submitTyped` resolves false and writes nothing when the lane has a draft at its turn. The toolbar
records the effort or model only when it resolves true. There is no message saying why the chip did
nothing; left out.

### Tests

- `submit-queue.test.ts` "held on a draft: review fixes": F2 head only and re-hold, F2 nothing at the
  hold, F6 `onlyIf` after the hold, F7 images after the hold, F8 `submitTyped`, F3 `onWrite` at the
  write, F1 ledger events and settles for divert and refusal.
- `idle-suspend.test.ts`: held keys mark the draft only through `onWrite`; F3 scenario against the
  real queue (two messages and the held text all written, nothing held).
- `lane-keystrokes.test.ts`: `\` + Enter, deleted `\`, double Esc inside and outside the window and
  with a key between, `restoreDrafts`/`draftUnknown`, listener fires once per change.
- `dispatch-outcome.test.ts`: `held` chip, `flipHeld`, `settleUnreturnedHeld`.
- `comms.test.ts`: coordinator with a draft skipped.
- `electron/src/main/lane-holds.test.ts` (new): owed handed over once and oldest first, drafts kept,
  cap.

Results:
- Root `npx vitest run`: 123 files, **1986 passed**. Root `npx tsc --noEmit -p .`: clean.
- Electron `npx vitest run`: 57 files, **1001 passed**.
- Electron `npm run typecheck` (main + renderer): clean.

### GUI check, added steps

Same setup as above (A = coordinator, B = worker).

7. `\` + Enter: in B type `please check:\`, press Enter (a new line appears in the composer), type
   `the logs`. Cause a message to B from A. Expected: nothing is submitted, and the pill shows
   "1 message waits…". Press Enter: your two-line message goes as one turn, then the message arrives.
8. Double Esc: in B type `half a thought`, press Esc twice quickly (the composer clears; the TUI
   shows "Esc again to clear" after the first). Cause a message to B. Expected: it is delivered at
   once, with no pill. Repeat with the two Escapes more than a second apart. Expected: the text
   stays in the composer, and a message to B waits with the pill.
9. Deliver now with two messages: type a draft in B, cause two messages to B, press Deliver now,
   and start typing right away. Expected: message 1 goes with your draft; message 2 waits on your new
   line and the pill shows "1 message waits".
10. Reload: type a draft in B, cause a message to B (pill shows), check Team → Dispatches reads
    "held · waiting on unsent text in the lane", then press Cmd+R. Expected: after the reload B's pill
    reads "1 message waits: after the reload, Operator can't tell if you left text here". Press
    Enter in B: your text goes, then the message; the record reads "delivered".
11. Coordinator draft: type into A and leave it. Have B call `report`. Expected: nothing is typed
    into A, and `$OPERATOR_DIR/logs/announce.log` has a line with
    `skip=unsent text in the composer`. Press Enter or clear it with Esc Esc; within about 5 s of A
    going idle the announcement arrives.
