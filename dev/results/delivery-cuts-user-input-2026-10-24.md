# Delivery cuts the user's half-typed message (2026-10-24)

Research only. No code changed. "Verified" = read in source this session. "Assumed" = not checkable from the repo.

## Summary

Every message Operator delivers to a lane's pty goes through one function, `submitQueue.submit`
(`src/renderer/lib/submit-queue.ts:379`). It writes `ESC[200~ <text> ESC[201~ CR` at line 404.
It never looks at whether the user has text in the composer. The paste lands at the cursor,
after (or inside) the user's draft, and the CR in the same write submits the combined text.

Result: the user's text is **merged into the delivered message and submitted early**. It is not
deleted. The lane receives "<user's half sentence><delivered message>" as one turn. The user's
box is then empty, which reads as "it cut my message".

The code already tracks unsent input per lane (`hasUnsentInput`,
`src/renderer/lib/lane-keystrokes.ts:54`), but only idle-suspend and the retire check use it.
Delivery does not.

## Every path that writes into a lane

| Path | Call site | Reaches pty via | Checks user input? |
|---|---|---|---|
| Reply from a lane (OPERATOR-REPLY / `reply` tool) | `DashboardView.tsx:1986` `submitWhenReady` | `submitQueue.submit` | No |
| Dispatch by sentinel to a live lane | `DashboardView.tsx:2318` `submitWhenReady(tab.id, d.task)` (also 2374, 3353, 3376, 4293) | `submitQueue.submit` | No |
| Feedback notes to the dispatcher ("unknown role", "Held for approval") | `DashboardView.tsx:2300`, `2550` | `submitQueue.submit` | No |
| Finishing/retire signal to dispatchers | `DashboardView.tsx:1866` | `submitQueue.submit` | No |
| Report announcements ("report #N ready") | `DashboardView.tsx:5210`, `5250` | `submitQueue.submit` | No |
| Board "Send →" / Start all | `DashboardView.tsx:3513` | `submitQueue.submit` | No |
| Retry of a stuck dispatch | `DashboardView.tsx:2635` | `submitQueue.clearComposer` then submit | No, and it **deletes** the draft (below) |
| Slash commands (`/effort`) | `submitQueue.submitTyped`, `submit-queue.ts:366-377` | typed line + CR | No |
| Held keys typed after resume | `submitQueue.draft`, `submit-queue.ts:355-361` | paste without CR | n/a (replays the user's own text) |
| Bus dispatch (`mcp__operator__dispatch` returns an address, the lane calls native `SendMessage`) | `session-bus.ts`, `index.ts:393` | Claude Code's own bus, not Operator's pty | **Not Operator's code. Unknown** (below) |

All terminal writes end in `window.operator.terminalWrite` -> `d.terminals.write` (`submit-queue.ts:543`,
`electron/src/main/ipc.ts:471`). The per-terminal write FIFO (`write-queue.ts`) only orders bytes. It
has no notion of a human.

## Mechanism, step by step

1. User types "can you also check the" in lane B's composer. Nothing is submitted.
   `noteDraftKey` marks lane B as having an unsent draft (`TerminalPane.tsx:247`,
   `lane-keystrokes.ts:42-46`).
2. Lane A replies. `submitWhenReady` (`DashboardView.tsx:1215`) waits only for lane readiness
   (`whenLaneReady`, 1197), then calls `submitQueue.submit`.
3. `submit` waits only for the 350 ms inter-submission gap (`submit-queue.ts:388-392`), then writes
   `ESC[200~ [from A] reply text ESC[201~ \r` (line 404, `submitSequence` at line 25).
4. Claude Code inserts the paste at the cursor (assumed from the TUI behavior below), then the
   CR submits the whole composer: draft + reply in one turn.
5. Variants:
   - Cursor in the middle of the draft: the reply is spliced into the user's sentence.
   - Lane is mid-turn: Claude Code queues the combined text as one queued prompt.
     `project_queued_prompts_no_user_turn` records that 3 of the 6 real "undelivered" cases were
     deliveries "merged behind a human's composer draft".
   - Several deliveries in a burst: each is one more paste, so the draft gets all of them.

Evidence that the merge is real and not only theoretical: the memory note above (measured
2026-08-06) and the original merged-draft bug that `submit-queue.ts:11` quotes
(`ALPHAReply...BRAVOReply...`), which is the same mechanism with Operator as the "typist".

## The timing guard that exists, and why it does not help

`TerminalPane.tsx:239-247` (and `GridTerminalPane.tsx:326`) calls
`submitQueue.cancelNudge(terminalId, 'typing')` on a keydown, but only while a submission is
`pending`. Effect: a keystroke **after** Operator's write cancels the **rescue CR** at 800 ms
(`submit-queue.ts:482`). It protects against a second CR submitting a half-typed line
(the caveat at `submit-queue.ts:95-98`).

It does nothing for the case in the report, where the user typed **before** the delivery:

- The first CR is inside `submitSequence` and is unconditional.
- The user's draft is not consulted at all.
- The cancel path then marks the delivery "may be stuck in a composer" and can raise an
  undelivered toast (`submit-queue.ts:468-476`), even though the text was in fact submitted
  merged. That makes the symptom more confusing.

## Where the user's text is actually lost

- **Retry** (`DashboardView.tsx:2635` -> `clearComposer`, `submit-queue.ts:348-353`): sends
  Ctrl+E, Ctrl+U and DEL repeated per line of the original task. If the user has typed into that
  composer since, up to the original line count of their text is deleted. The comment at
  `submit-queue.ts:49-52` says the excess survives; the first N lines do not.
- **Idle-suspend** is protected (`DashboardView.tsx:4138` checks `!hasUnsentInput`). Not part of
  this bug.

Everything else merges, not loses.

## Bus path (unknown part)

`dev/results/session-bus-spike.md:95-125` shows that a bus message to a busy session is injected
by Claude Code mid-stream as a `queued_command` attachment, not through the composer. It does not
cover a session that is **idle with text in the composer**. I did not find what Claude Code does
then, and it cannot be read from this repo. If the user's lanes use `mcp__operator__dispatch`
(bus) and the cut still happens, that part is Claude Code's behavior and needs a live test (recipe
step 4). Replies and report announcements are pty-typed regardless (`DashboardView.tsx:1986`,
`5210`), so they are affected either way.

## Can the existing tracking be reused?

Yes, and cheaply. Already in the renderer, same process as the queue:

- `hasUnsentInput(terminalId)` (`lane-keystrokes.ts:54`): printable key or paste sets it; Enter or
  Ctrl+C clears it. Backspace-to-empty still reads as a draft (errs toward "has input").
- `typedWithin(terminalId, ms)` and `lastKeystrokeAt(terminalId)` (`lane-keystrokes.ts:16-24`).

Not reusable: the "typing never resets the send budget" logic. That is `laneSends`
(`agent-delivery.ts`, 24 sends, `deliveryStateRef`), a loop brake keyed by role. It does not
observe keystrokes and is unrelated. It is not a delivery-timing mechanism.

Gaps in `hasUnsentInput` to know about:
- Only `keydown` and `paste` in the pane set it. Operator's own writes (`submitQueue.draft`,
  held-keys replay) call `notePaste` explicitly only in `idle-suspend.ts:615`.
- Text left in the composer by an earlier Operator delivery that never submitted is not a "draft".
- Dictation/IME composition commits arrive via `onData` and `compositionend`; the key handler
  returns early while composing (`TerminalPane.tsx:244`), so IME text is not flagged until the
  next key. Minor.
- A lane in an unfocused/hidden pane gets no keydowns, which is correct (no typing).

## Reproduction recipe

Needs two live lanes (A = coordinator, B = worker) in one project, dev app on its own
`OPERATOR_DIR` (see `reference_dev_launch`).

1. In lane B's terminal, type `Please also check the` and do not press Enter.
2. From lane A, cause a reply to B. Fastest: tell A "dispatch to B: say hi" or make B's
   `OPERATOR-REPLY` come from A; alternatively wait for a report announcement.
3. Expected (bug): B's composer empties; B's transcript shows one user turn
   `Please also check the[Operator] ...` (or the reply text appended to the draft). Check with
   `grep -n "Please also check" ~/.claude/projects/<B-project-dir>/<session>.jsonl`.
4. Bus check: repeat step 2 using a dispatch that goes over the bus (`mcp__operator__dispatch`).
   If the draft is intact and the message arrives as a separate turn or attachment, the bus is
   safe and only the pty path needs the fix.
5. Mid-turn variant: start a long turn in B, type a draft, deliver from A. Expect a single queued
   prompt containing both (`queue-operation: enqueue`, content = draft + message).
6. Retry variant: let a dispatch to B sit undelivered, type two lines in B, press Retry. Expect
   the two lines deleted.

Not run by me: I did not launch the app (project rule on unasked launches).

## Fix options

### Option 1: hold delivery while the user has unsent input (recommended)

In `submitQueue.submit` (or in `submitWhenReady`, which is the single choke point for the
reply/dispatch paths), before the `deps.write` at `submit-queue.ts:404`, wait while
`hasUnsentInput(id)` is true and the user typed within the last N seconds. Flush when:

- the draft clears (Enter or Ctrl+C, already tracked), or
- the user has been idle N seconds (suggest 8-10 s; there is a precedent constant
  `RETIRE_TYPING_QUIET_MS = 10_000` in `dispatch.ts:210`).

Hold the whole per-terminal chain, not one message, so order and the 350 ms gap are preserved.
Inject `hasUnsent`/`lastKeystrokeAt` through `SubmitQueueDeps` so the queue stays testable against
a fake pty (the module's stated rule, `submit-queue.ts` bottom comment).

Behaviours to specify:
- Flush after idle without Enter: the draft is still there. Pasting then would still merge. So
  after the idle timeout either (a) keep holding until Enter (user's text is sacred, delivery can
  be late) or (b) clear-and-restore: not possible safely, see Option 2. Recommend (a) with a
  visible "N messages waiting for B" indicator and a force-deliver action. Without the indicator
  the lane looks dead (the same trust problem the delivery-confirm work was built to fix).
- `pending`/`settling` consumers: a held message must count as pending so retire/suspend do not
  act on the lane (`DashboardView.tsx:1245` already reads `submitQueue.pending`; `awaitingReadyRef`
  at 1213 is the existing counter pattern).
- Delivery confirmation window and undelivered toast must start at the write, not at the enqueue,
  or held messages will report "never started".
- Mid-turn lanes: the draft rule applies equally.

Cost: small (queue gate + one dep + indicator + tests). Trade-off: delivery latency is unbounded
for a lane the user leaves with a draft and walks away from. Risk: `hasUnsentInput` false
positives (Backspace-emptied draft, a stale flag after a lane restart) hold messages forever.
Mitigate by clearing the flag on terminal exit/restart and by the force-deliver action. False
negatives (flag unset but text present, e.g. text pasted by drag/drop or typed during IME) still
merge, same as today.

### Option 2: stash and restore the draft around delivery

Write Ctrl+E Ctrl+U to take the draft out, deliver, then re-paste the draft. Rejected as primary:
the draft content is not readable from the TUI (we only know keystrokes, not text), so it cannot be
restored. Mirroring all typed keys in the renderer to reconstruct it breaks on cursor moves,
history recall and autocomplete. This is the same unverified-keybinding risk that
`submit-queue.ts:49-52` warns about for `clearComposerSequence`.

### Option 3: deliver without touching the input line

Only the bus achieves this (Claude Code injects it as a peer message / attachment, spike
sections above). Operator cannot do it on its own: it does not speak the socket protocol, and
`session-bus.ts:3-8` says it must not. Moving replies and announcements to a bus-based delivery
needs the lane's native `SendMessage` (a lane-to-lane call, not something Operator can trigger
for a reply it routes). Larger change; only worth it if step 4 of the recipe shows the bus is
safe with a draft present. Treat as a follow-up, not the fix.

### Also fix regardless of option

- `clearComposer` in retry: skip it (or bound it to 0 lines) when `hasUnsentInput` is true. Its
  premise is that the composer holds only our paste.
- The suppressed-CR "undelivered" toast (`submit-queue.ts:468-476`) fires when the user types
  after a delivery. Once Option 1 holds deliveries, that case mostly disappears.

## Recommendation

Option 1 with "hold until Enter/Ctrl+C", an on-screen waiting indicator with a force-deliver, and
the `clearComposer` guard. Run recipe step 4 first, since it tells you whether bus dispatches
need any change at all. Needs Code (queue + view) and a GUI check by the user; I cannot verify
TUI paste placement from this checkout (assumed from the merged-draft evidence above, not
re-measured today).
