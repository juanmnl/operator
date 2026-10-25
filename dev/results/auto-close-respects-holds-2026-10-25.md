# Automatic lane close respects owed messages, drafts and held deliveries (2026-10-25)

Closes the gap named in report #2813. Branch `operator/b8ce80`, based on `operator/98a1c0` @
`26c3c0d` (main plus the delivery hold on draft). Not merged. Not GUI-verified.

## The gap

The automatic close (`planLaneCloses` → `laneCloseDecision`, on the keep-warm and went-quiet
paths) refused only on open tasks, phase, focus and the coordinator. A reply or an announcement has
no task, so `openWork` never saw it. A lane that reported done more than 10 minutes ago could be
closed while such a message waited behind the person's draft, losing the message and the draft.

## What changed

### `src/renderer/lib/lane-lifecycle.ts`

- `LaneSnapshot` has three new optional fields, named and documented as in
  `SuspendCandidate` (lib/idle-suspend):
  - `owed`: a submission not written yet (held on a draft included) or written and waiting for its
    turn (`owesSubmission`), or a message waiting for the lane to be ready (`whenLaneReady`).
  - `unsentInput`: text typed into the composer and not sent (lib/lane-keystrokes).
  - `heldDeliveries`: dispatches and replies to the lane that are queued or held
    (`heldDeliveriesFor`, last 24 hours).
- `laneCloseDecision` refuses while any is set. The checks sit right after the open-work check,
  before the suspended branch and the phase checks, so they hold both the keep-warm path and the
  went-quiet backstop, for live lanes and for lanes suspended while idle. The `why` strings are the
  ones `suspendDecision` uses for the same conditions.

### `src/renderer/views/DashboardView.tsx` (close tick)

- The tick computes the three values per tab and passes them on both snapshot shapes (live and
  suspended). The project lookup the open-work count already did is hoisted into `project` and
  reused for `heldDeliveriesFor`.

## Tests

New block in `src/renderer/lib/lane-lifecycle.test.ts`, "what is still on its way to a lane holds
its close": one refusal each for owed, unsent input and held deliveries (with its reason); the
same three on the went-quiet backstop; a suspended lane held by owed and by held deliveries; a lane
with all three set that closes as `reported-done` once they clear; and `planLaneCloses` leaving the
held lanes out until they clear.

Results:
- Root `npx vitest run`: 129 files, **2108 passed** (2101 before; 7 new).
- Electron `npx vitest run`: 57 files, **1002 passed**.
- Root `npx tsc --noEmit -p .`: clean. Electron `npm run typecheck` (main + renderer): clean.

## Deliberately left out, and notes

- `owed` also counts `awaitingReadyRef` (messages waiting at `whenLaneReady`). The brief named
  owed messages; these are owed messages that are not in the submit queue yet, and closing the
  pty loses them the same way. One `||` in the tick.
- Held deliveries hold a suspended lane too. `heldDeliveriesFor` counts records from the last 24
  hours, so an `undelivered` record nobody dismisses keeps the lane (live or suspended) up for at
  most a day past it. Idle suspension has the same bound.
- No re-check between the decision and the kill. The tick decides and calls the close in the
  same synchronous pass, as before; a message that arrives during the close itself is the lane
  gate's case, which this change does not touch.
- The person-initiated closes (⌘W, the lane menu, ProjectCloseGuard) still do not check owed
  messages. #2813 named that separately; it is out of scope here.

## GUI check for the user

Dev app on its own `OPERATOR_DIR`, keep-warm left at 10 minutes. Two lanes in one project: A =
coordinator, B = worker.

1. Have B call `operator__report`, then leave B idle and focus A.
2. In B (focus it briefly, then go back to A), type `draft` without Enter, so a delivery to it
   would hold.
3. Have A reply to B (`OPERATOR-REPLY [<B>] hi`). B's pill shows the message waiting.
4. Wait past 10 minutes. Expected: B is not closed, and no "Closed B — reported done" toast.
5. Focus B, press Enter. The draft goes, then the reply. Go back to A and wait 10 more minutes
   after B's last activity. Expected: B is closed with the "reported done" toast.
