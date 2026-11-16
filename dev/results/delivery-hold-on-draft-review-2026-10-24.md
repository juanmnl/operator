# Review: hold lane deliveries on an unsent draft (2026-10-24)

Commit reviewed: `8698c31` on `operator/98a1c0` ("Hold lane deliveries while the person has unsent
text in the composer"), diff `git diff main...8698c31`. The branch tip has since moved to `0236e4d`
(a results commit and an unrelated terminal-links commit). Those are not part of this review.
Line numbers below are at `8698c31`.

## Tests run

Run on an export of `8698c31` (git archive into a scratch directory):

- Root `npx vitest run`: 123 files, 1957 passed.
- Electron `npx vitest run`: 56 files, 998 passed.
- Electron `npm run typecheck` (main + renderer): clean.

Two findings (F2, F3) were also confirmed with scratch tests against `createSubmitQueue`. The tests
were deleted afterwards; their code is in the findings.

## Findings, most severe first

### F1. High: a held message lives only in renderer memory, so a renderer crash or reload loses it silently

`src/renderer/lib/submit-queue.ts:468` (the unbounded hold), `src/renderer/views/DashboardView.tsx:1988`,
`:2324` (`record('sent')` at enqueue).

Main holds dispatches and replies only while no renderer exists (`electron/src/main/index.ts:149`,
`routed.hold()`). Once a message is routed into the renderer's submit queue, main forgets it. Before
this commit a message sat in the queue for 350 ms plus the confirmation wait. Now it sits there
for as long as the person leaves a draft, with no timeout. The renderer has a known open leak
(~33 MB/h) and a crash-reload path; a reload or crash discards the queue and the `drafts` set.

Failure scenario: the person types half a sentence into lane B and walks away. A dispatch from the
coordinator arrives and is held. The dispatch log shows `sent`, the coordinator got "Dispatched to
B", and the task is marked running on B. Hours later the renderer crashes and reloads. The held
message is gone: nothing re-sends it, no undelivered toast fires (the toast only comes from the
queue's own watch, which died with it), and the dispatch stays `sent` forever. After the reload the
`drafts` set is empty while the pty still has the person's text in its composer, so the next
delivery merges into it, which is the original bug.

What would close it (for Code to decide): persist held messages (or at least mark the dispatch
record as held, not `sent`) so a reload can re-deliver or report them, and treat a lane re-attached
after a reload as "draft unknown".

### F2. Medium: "Deliver now" releases every queued message, so the second and later ones merge into a new draft

`src/renderer/lib/submit-queue.ts:621-622` (`forced.set(id, enqueued.get(id))`), `:458`.

`deliverNow` marks every submission enqueued so far as forced, and a forced message skips the
draft check entirely (`seq > forced` is false). Only the first write is meant to merge (the tooltip
says "the first message is added to what you typed"). After that write, the chain waits for the
first message's confirmation (or for a keystroke that cancels the rescue) before writing the next
one. A person who starts typing their next line in that window gets messages 2..N pasted into it,
and each paste's CR submits the new line.

Failure scenario: two messages are held. The person clicks Deliver now; message 1 goes with their
draft. Within a second they start typing a reply. Message 2 is written into that half-typed reply
and submits it. Confirmed with a scratch test (gap 5 ms, rescue 200 ms): message 2 was written while
`hasUnsentInput` was true.

Releasing only the head message is enough. `clearUnsentInput` after the forced write already
lets the rest through when no new draft exists, and holds them when one does.

### F3. Medium: held keys from a suspended pane can deadlock behind a message that is waiting on them

`src/renderer/lib/idle-suspend.ts:616` (`notePaste` before the write), with
`src/renderer/lib/submit-queue.ts:458-468`.

`typeHeldKeys` sets the draft flag (`notePaste`) and then queues the held text with `draft()`
behind whatever is already on the lane's chain. Any `submit` already on the chain but not yet
started now sees the flag and holds. The held text is queued behind that submit, so it is never
written. The composer is empty and the pill says "1 message waits until you send or clear what you
typed" about text the person cannot see.

Failure scenario: lane B is suspended. The person types "check the logs" at the overlay, which
resumes it. Two messages join the wake (a dispatch and a reply). After `ready`, message 1 is written
and the chain waits on its confirmation. The held-keys timer fires: the flag is set and the draft is
queued after message 2. Message 2 starts, sees a draft, and holds. "check the logs" never appears.
If the person presses Enter on the empty composer, message 2 goes and then their text appears after
it. If they press Deliver now, message 2 is written, `clearUnsentInput` runs, and then their text is
pasted into a composer the flag says is empty, so the next delivery merges into it. Confirmed with a
scratch test: after 1.5 s neither message 2 nor the held text was written and `heldForDraft` was 1.

Setting the flag at the moment `draft()` writes (inside the chain) instead of before queueing it
would remove the inversion.

### F4. Medium: Enter is read as "sent", but `\` + Enter in Claude Code adds a newline

`src/renderer/lib/lane-keystrokes.ts:37`.

`draftEffect` returns `clear` for a plain Enter. The installed Claude Code (2.1.310) documents
"You can already use backslash (\\) + return to add newlines" (string in the binary). A person
writing a multi-line message that way clears the flag at each line break while their text stays in
the composer. Before this commit the flag only guarded suspension; now it is the only thing between
a delivery and the draft.

Failure scenario: the person types `please check:\`, presses Enter (newline in the composer, flag
cleared), and a held or new message is written 250-600 ms later. It pastes onto the second line and
submits the half-written message. The same applies to an Enter that accepts an autocomplete entry
(`@` file picker, `/` command menu) instead of submitting; I did not verify that one against the
binary.

### F5. Medium: a draft cleared by double Esc keeps the hold on indefinitely, and blocks the announce pass for that coordinator

`src/renderer/lib/lane-keystrokes.ts:37-41`, `src/renderer/views/DashboardView.tsx:5234-5257`.

The installed Claude Code clears the input on a double Esc ("double tap esc to clear input", in the
2.1.310 binary). `draftEffect` does not treat Escape as a clear, so the flag stays set with an empty
composer. Backspace-to-empty is the known case; double Esc is the binary's own documented way to
clear and will be common. A stale flag holds every message to that lane until Enter, Ctrl+C or
Deliver now, and it also keeps the lane from being suspended, restarted or retired (`owesSubmission`).
The pill is the only sign, and it is visible only in that lane's pane: the rail, the dispatch log
and the dispatcher all read `sent`.

For a coordinator, `serveCoordinator` awaits `submitQueue.submit` inside the per-tab in-flight entry.
A stale flag holds that await, so no report is announced to that coordinator until someone looks at
its pane.

Failure scenario: the person types into the coordinator, changes their mind, clears it with Esc Esc,
and switches to another lane. Reports and replies to the coordinator all wait behind the flag with
no sign outside the hidden pane.

### F6. Medium-low: a held announcement is written mid-turn, after the idle check it passed

`src/renderer/views/DashboardView.tsx:5234` (`canAnnounceTo` checked before the submit) and `:5257`.

The announce loop re-checks that the coordinator is idle before each line, because a line typed
into a running coordinator is "the exact race reports exist to avoid" (comment at :5228). The check
runs before `submit`. With a draft, the submit then holds until the person presses Enter, which
starts their own turn, and the announcement is written 350 ms later into a running lane. The idle
check is not repeated after the hold. Every held announcement therefore lands mid-turn, as a queued
prompt behind the person's message.

### F7. Low: Preview annotations split images from text when the lane has a draft

`src/renderer/lib/submit-queue.ts:385` (`attachImages`, not gated), `src/renderer/views/DashboardView.tsx:6407-6408`.

The Preview's `onDispatch` pastes the screenshots with `attachImages` and then submits the text,
relying on both landing in one prompt. `attachImages` has no draft check, so with a draft the image
paths paste into the person's text right away while the text part is held. On Enter the person's
draft goes out with the screenshots attached, and the annotation text follows as a separate turn
without them.

### F8. Low: toolbar `/effort` and `/model` still type into a draft and then record the change

`src/renderer/lib/submit-queue.ts:422` (`submitTyped`, not gated),
`src/renderer/components/session/SessionToolbar.tsx:176-187`.

Left out deliberately in Code's write-up, but its consequence is worse than "the person's own
action". With a draft and no held message, `/effort high\r` is typed after the draft and the CR
submits `my draft/effort high` as a prompt. The effort is not changed, and the toolbar then
persists `high` because the write went out (`.then(() => setEffortLevel(level))`). The chip and the
saved effort now disagree with the lane. Pre-existing, not a regression.

## Checked and clean

- Gap/hold/write race: after the hold the loop sleeps the gap and re-checks `draftHolds` before
  breaking; from the final check to `deps.write` there is no `await`, so a keystroke cannot slip
  in between inside the renderer.
- Confirmation timing: `gen`, `seen` and `writtenAt` are all taken after the hold, so the rescue
  CR, the confirmation window and the undelivered toast are timed from the write. The transcript
  watcher (`DashboardView.tsx:640`) reads `pending`, which is unset while held, so a held message
  cannot be confirmed early. A forced merge with the cursor at the end of the draft is still
  confirmed by `matchSubmission`'s ends-with rule (`delivery-confirm.ts:88`).
- `owesSubmission` replaces `pending` at every consumer that decides whether a lane may be ended:
  retire `settling` (:1248), the restart candidate (:4003), `handleRestartLane` (:4076), the suspend
  re-check (:4144) and the suspend tick input (:4354). The remaining `pending` reads (:640, :5218,
  :5258, the two panes' `cancelNudge` guard) mean "written and unconfirmed" and are right as they are.
- Lane exit and restart: the flag is cleared on the exit event (before the restart early-return),
  in the stale-exit reconcile and after the restart kill. A held message on a lane that exits is
  then written to the dead id and reported like any other queued message, as before.
- Divert: `draftHolds` is false while diverted, so a suspend cannot leave a message polling against
  a dead pty. A lane with a draft is not suspended in the first place.
- `clearComposer` over a draft: skipped at its turn in the chain, so retry no longer deletes typed
  text.
- Lane switch: everything is keyed by terminal id, which does not change on a switch.
- Polling cost: one 250 ms timer per held terminal, each tick a Set lookup and two Map reads;
  `holdChanged` fires only on transitions and on enqueue/write while holding. Negligible.
- `DraftHoldNotice`: `useSyncExternalStore` with a stable subscribe and a number snapshot, so no
  render loop. Text is `--fg` with no opacity (no stacking on `--fg-muted`). "Deliver now" is a text
  button with no glyph, so no glyph is shared with another verb. The copy is one sentence with no
  full stop, so the stray-word rule does not apply. Mounted only on live, non-placeholder panes.
- `deliverNow` semantics are stated in the interface doc (`submit-queue.ts:324-327`), the component
  doc and the button's tooltip: the first message is merged into the draft by design. F2 is about
  the second and later messages, which the copy does not cover.

## Recommendation to the coordinator

F1 to F5 need Code. F1 is the one to settle before merge, because it turns a short exposure into an
unbounded one on a renderer with a known leak. F2 and F3 are small changes in `submit-queue.ts` and
`idle-suspend.ts`. F4 and F5 need `draftEffect` to handle `\` + Enter and Esc Esc, plus some sign of
a held lane outside its own pane (rail or dispatch log). The GUI recipe in Code's write-up should
add a double-Esc step and a `\` + Enter step.
