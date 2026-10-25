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

## Fix round 2 (Review r2: `dev/results/delivery-hold-on-draft-review-r2-2026-10-25.md`)

2026-10-25. Branch `operator/ced0c0`, fast-forwarded from `operator/98a1c0` @ 88c0332;
`operator/98a1c0` moved to the same tip. Not merged. Not GUI-verified.

### S1. Double Esc with a suggestion list open keeps the draft

`lib/lane-keystrokes` keeps a per-lane "a suggestion list may be open" flag. It is set by a typed
`@` or `/`, a paste that contains either, Tab, and a draft restored after a reload. While it is
set, the next Esc returns `null` and starts no pair, as `disableEscapeDoublePress` does in the
2.1.310 binary (`U_=Uf.length>0`; the input's escape case returns before the double-press hook).
That Esc unsets the flag, so the next two Escapes inside `DOUBLE_ESC_MS` clear. Enter and Ctrl+C
unset it too.

The picker's real state cannot be read, so the flag stays set after an `@` or `/` even when the
list has closed on its own: after a space, or when nothing matched. In that case a double Esc
clears the composer and the flag stays on. Deliveries then wait until the person types and sends,
or presses Deliver now. This is the safe direction the brief asked for.

Not handled: an Enter that accepts a suggestion instead of sending. That Enter still reads as a
send and clears the flag. It is the F4 gap that round 1 noted, and it is outside S1.

### S2. `\` + Enter reads the character before the cursor

`draftEffect(e, state, now)` now takes `{ prev, before, picker }`. `before` is the last character
of a per-lane tail made of the typed characters and the pasted text since the composer was last
known empty. Backspace removes one character. After `\` + Enter the tail ends in a newline, because
the binary does `b.backspace().insert(newline)` (checked in 2.1.310). Cursor moves, history, Tab and
Ctrl/Meta chords make the tail unknown. An unknown character is never `\`, so Enter clears, which is
the old behaviour. `notePaste(id, text?)` takes the pasted text: TerminalPane passes the
clipboard's `text/plain`, and the held-keys write passes its text. The tail is capped at 256
characters.

### S3. Owed announcements after a reload

`SubmitOptions.reports` carries the ids an announce-pass line announces. The queue hands it to the
ledger only, and DashboardView stores it on the `OwedSubmission`. The restore re-submits such a line
with the pass's check (`!held && canAnnounceTo(...)`). Once the line is written and confirmed, it
marks those reports delivered and refreshes the reports. The coordinator is in `announceInFlightRef`
until then, so the pass does not type the same reports beside it. If a pass is already serving that
coordinator, the line is not re-submitted: the pass announces those reports itself. An announcement
owed to a terminal that is gone is dropped and not reported. Its reports are still undelivered in
artifacts.db.

### S4. Images on the owed record

`OwedSubmission.images`, from `SubmitOptions.images` through the ledger's `owe(id, key, text,
opts)`. The restore passes them back to `submit`. A wake still carries only the text, the same as
the live renderer's divert.

### S5. A held record goes back to `sent`

A new `LaneHoldOp` `{ kind: 'held', key, on }` tells main when the draft holds an owed message.
`OwedSubmission.held` keeps it. The restore re-submits with `SubmitOptions.held`, which starts the
queue entry as held. Its settle then sends `held(off)` and flips the record back to `sent`, whether
or not the new queue holds it again, and it is never marked held twice.

### S6. A lane suspended across the reload is woken, not reported ended

`OwedSubmission.laneKey` carries the tab's key. `splitOwed` (lib/dispatch-outcome) sorts the owed
messages: a running terminal is re-submitted; a gone terminal with a key waits in `owedToWake`; a
gone terminal with no key is reported ended. Once the suspended tabs are restored
(`suspendedRestored`), `wakeOrEnded` finds a suspended tab with that key. That lane is woken with the
message, the same way the divert does it, including the `resume`/`waited` reports when the wake
fails. Any other lane is reported ended. Messages waiting for a wake count as given back for
`settleUnreturnedHeld`.

### Tests

- `lane-keystrokes.test.ts`: S1 `@` picker double Esc, then a third Esc clears; `/` and a pasted
  `@` path; no picker key still clears; Ctrl+C unsets the picker; a restored draft takes a picker to
  be open. S2: paste ending in `\` then Enter; `\`, `x`, Backspace, Enter; a cursor move and a paste
  with no text are read as unknown.
- `submit-queue.test.ts`: the ledger gets images and reports; `held: true` sends `unheld` once at
  the settle, whether or not the submission is held again.
- `dispatch-outcome.test.ts`: `splitOwed` and `wakeOrEnded`.
- `electron/src/main/lane-holds.test.ts`: the `held` op, images and reports kept on the owed entry.

Results:
- Root `npx vitest run`: 123 files, **1998 passed**. Root `npx tsc --noEmit -p .`: clean.
- Electron `npx vitest run`: 57 files, **1002 passed**.
- Electron `npm run typecheck` (main + renderer): clean.

### GUI check, added steps

12. Picker: in B type `look at @src/`, press Esc twice quickly. The picker closes and the text
    stays. Cause a message to B. Expected: it waits with the pill. Press Esc twice more: the composer
    clears and the message is delivered within a second.
13. Pasted backslash: paste `C:\Users\` into B and press Enter. Expected: a new line in the composer.
    Cause a message to B. Expected: it waits.
14. Held then delivered across a reload: type a draft in B, cause a message (record reads `held`),
    press Enter, and press Cmd+R within a second. Expected after the reload: the record reads
    `sent` or `delivered`, not `held`.

## Follow-up: review r3 N1 (2026-10-25), commit `da26ae4`

Review: `dev/results/delivery-hold-on-draft-review-r3-2026-10-25.md`, N1.

### What changed

Before, any `@` or `/` typed or pasted set `pickerMaybe`, and it stayed set until Esc, Enter or
Ctrl+C. A draft holding a path, a URL or an email address that was cleared with Esc Esc kept the
hold flag. Now `pickerMaybe` is judged again after every typed character, Backspace and paste with
known text, from `tail` (the text before the cursor), by `listMayBeOpen`
(`src/renderer/lib/lane-keystrokes.ts`). Tab and a restored draft still set it, and Esc, Enter
and Ctrl+C still clear it.

The triggers come from the 2.1.310 binary (`~/.local/share/claude/versions/2.1.310`, the
suggestion hook `pce` and its helpers):

| List | Binary | Rule here |
|---|---|---|
| Command menu | `rA`: the draft starts with `/` and the name matches `[a-zA-Z0-9.:\-_]`; `q$e` closes it once text follows the space | `^\/[a-zA-Z0-9.:_-]* ?$` on the whole draft |
| Mid-draft command list | `nA`: `/` after `[\s。、？！]`, then `[a-zA-Z0-9._:-]*` to the cursor. It shows as a list only when `Bn` is set (`_i()`, which I could not resolve; a fullscreen-mode check is the likely one) | Same regex, always counted |
| File picker | `ii = text.match(G1t)`, `G1t = (^\|L7)@([\p{L}\p{N}\p{M}_\-./\\()[\]~:]*\|"[^"]*"?)$`, `L7 = [\s。、？！]` | Same, with U+200C/U+200D added for the agent list's `CU` |

So the brief's rule ("`/` only at the start of the draft") is widened by one case found in the
binary: `/name` after whitespace may show the mid-draft command list. `see /usr/bin` does not match
(the second `/` ends the name), nor does `https://…`, `src/main.ts` or `me@example.com`. A mention
that has ended with a space (`@src/main.ts now`) no longer holds, and Backspace back into it opens
it again, as in the TUI.

Text these keys cannot follow (after an arrow, Home/End, history, Tab, or a restore) is the one
case kept conservative. A new set, `triggerSeen`, records that the draft has held an `@` or `/`, a
Tab, or was restored. It is cleared when the draft is sent or cleared. When it is set and the tail
holds unseen text, the unseen text is taken to possibly end in the start of a command or mention,
and what was typed since is tested as its continuation. Without `triggerSeen`, an arrow key
followed by typing does not hold, as before.

One line changed in Backspace: a tail that ends in unseen text stays unseen. Before, only a tail
that was exactly `UNSEEN` stayed; `ab` + unseen + Backspace became `ab`, which read `b` as the
character before the cursor.

Left out: Enter while a list is open selects the suggestion in the TUI rather than sending. That is
modelled as before (Enter sends or adds a newline) and is outside N1.

### Tests

`lane-keystrokes.test.ts`, new block "which / and @ open a suggestion list (review N1)": the
command menu rule, the mid-draft rule, the `@` rule with CJK punctuation and quoted paths, a double
Esc clearing drafts that hold a path, URL or email (typed and pasted), an ended mention and
Backspace into it, a cursor move with and without `triggerSeen`, and a sent draft forgetting its
`@`. The earlier S1 tests pass unchanged.

Results on `da26ae4`:
- Root `npx vitest run`: 123 files, **2013 passed**. Root `npx tsc --noEmit -p .`: clean.
- Electron `npx vitest run`: **1002 passed**.
- Electron `npm run typecheck` (main + renderer): clean.

### GUI check, added step

15. Path then double Esc: in B type `see /usr/bin and https://example.com`, press Esc twice
    quickly. Expected: the composer clears. Cause a message to B. Expected: it is delivered
    without the pill. Repeat with `then /rev` and confirm whether the mid-draft command list
    appears in this mode; if it does, the double Esc should only close it and the message waits.

## Follow-up: pre-merge review P1-P2 (2026-10-25), commit `58f4101`

Review: `dev/results/delivery-hold-premerge-review-2026-10-25.md` (in the main checkout). Branch
`operator/b8ce80`, on top of `80f5987` (automatic close respects holds). Not merged. Not
GUI-verified.

Both findings are lists the first Esc closes, so a double Esc there does not clear the input, while
`listMayBeOpen` read no list and the flag cleared. Both fixes only widen the hold.

### P1: a draft that starts with `/`

`COMMAND_MENU` (`/` and a command name, at most a space after it) is replaced by `SLASH_DRAFT =
/^\//`: any draft that starts with `/` may have a list open, whatever follows. The 2.1.310 binary
opens argument lists there: `directory` for the commands in `n2`, `custom-title` for `/resume`,
and `command` for any command with `getArgumentCompletions`. Which commands complete arguments
changes between versions, so the rule does not try to name them. `/usr/bin` and `/review 12` now
hold too.

### P2: emoji and Slack channel lists

Rules added, copied from the binary next to `G1t` (checked in the installed 2.1.310: both are
matched against `Wn.substring(0,Ts)`, the text before the cursor, case-sensitive):
- `EMOJI = /(^|\s):[a-z0-9_+-]{2,}$/` (`rce`). The list is gated on `emojiCompletionEnabled`, on
  unless set false, and opens only when `A$e` finds a name. That cannot be known here, so every
  match counts as open.
- `CHANNEL = /(^|\s)#[a-z0-9][a-z0-9_-]*$/` (`oce`). Opens only while a Slack MCP client is
  connected, which is not known here either, so every match counts.

`10:30`, `issue#12`, a closed `:house:` and a channel name followed by a space do not match.

### Unseen text

`:` and `#` join `/` and `@` as triggers for `triggerSeen` (`TRIGGERS = /[/@:#]/`). With P1, a
draft that has held a trigger and whose tail holds unseen text may start with `/`, which holds
whatever follows. So the fallback in `listMayBeOpen` is now simply `triggerSeen && text includes
UNSEEN`; the old continuation checks (`'/' + since`, `' @' + since`, …) were all subsumed by it.
One existing expectation flips for that reason: `listMayBeOpen('\u0000x" y', true)` is now true.
A draft with no trigger is unchanged: after an arrow key, typing does not hold.

This also covers a long `/` draft cut to its last 256 characters: the cut adds `UNSEEN`, and the
leading `/` set `triggerSeen`.

Cost of the wider hold: a double Esc does not clear the flag on these drafts. Enter, Ctrl+C and
Deliver now still do, and the pill says the message is waiting.

### Tests

`lane-keystrokes.test.ts`, new block "the lists the N1 rule missed": P1 rule cases
(`/add-dir src/`, `/resume my-sess`, multi-line), the review's failure scenario (`/add-dir src/`
then double Esc keeps the draft), a 300-character `/review` draft; emoji and channel rule cases
with their non-matches; double Esc on each list keeps the draft; and a cursor move after `:` or `#`
keeps the hold. The N1 command-menu test lost its two "closed" cases, which are P1 cases now.

Results on `58f4101`:
- Root `npx vitest run`: 129 files, **2115 passed**. Root `npx tsc --noEmit -p .`: clean.
- Electron `npx vitest run`: 57 files, **1002 passed**.
- Electron `npm run typecheck` (main + renderer): clean.

### GUI check, added step

16. In B type `/add-dir src/` and wait for the directory list. Press Esc twice quickly. Expected:
    the list closes, the text stays, and a message caused to B waits with the pill. Repeat with
    `looks good :ho` (emoji list). Then type `see /usr/bin`, press Esc twice: the composer
    clears and a message is delivered without the pill.
