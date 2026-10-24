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
