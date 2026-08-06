// Serializes MESSAGE SUBMISSIONS into a session's pty, per terminal.
//
// Why this exists (measured, not guessed): Operator writes a message as a bracketed
// paste followed by CR — `ESC[200~ <text> ESC[201~ \r`. Claude Code's TUI commits a
// paste asynchronously (state update + re-render), so a CR that arrives while the
// previous paste is still being committed is SWALLOWED. Fire three dispatches
// back-to-back (which the coordinator's charter explicitly encourages — "prefer
// several precise dispatches over one vague one") and instead of three submissions
// you get one merged draft:
//
//   ❯ Reply with exactly: ALPHAReply with exactly: BRAVOReply with exactly: CIRCA
//
// i.e. the tasks pile up in the composer and never run as separate turns. Spacing the
// writes ~350ms apart made all three submit reliably in a real Claude session.
//
// Queues are PER TERMINAL: a dispatch to lane B never waits on lane A.

/** Wrap text as a bracketed paste + CR — the "submit this message" byte sequence. */
export function submitSequence(text: string): string {
  return `\x1b[200~${text}\x1b[201~\r`
}

/** Clear a lane's composer — the bytes, as a pure function so they can be asserted.
 *
 *  WHY IT EXISTS: `retryDispatch` re-delivers a whole message, and if the original paste is still
 *  sitting unsubmitted in the composer the new one APPENDS to it — the lane then reads the task
 *  twice, concatenated. Clearing first removes the duplication.
 *
 *  THE BYTES, and why these three:
 *    `\x05` Ctrl+E  move to end of line   — so the kill below is not cursor-dependent
 *    `\x15` Ctrl+U  delete to line start  — readline's kill-to-start; the line is now empty
 *    `\x7f` DEL     backspace             — at column 0 this joins to the line above
 *  repeated per line, walking a multi-line paste upward one line at a time.
 *
 *  CHOSEN TO BE HARMLESS WHEN UNBOUND, which matters more than elegance here: these go into a
 *  LIVE agent's pty. All three are no-ops on an empty composer, none submits anything, and none
 *  can interrupt a turn or end a session. That rules out the sequences a person would reach for
 *  first — `Esc` interrupts a running turn, `Ctrl+C` twice exits the lane, `Ctrl+D` exits on an
 *  empty line. A clear that occasionally fails to clear is recoverable; one that kills a lane
 *  mid-turn is not.
 *
 *  BOUNDED BY WHAT WE PASTED, not by a guess at what is there now: the caller passes the line
 *  count of the message it originally sent, so the walk covers exactly the text this app is
 *  responsible for. If a human has since typed MORE lines than that, the excess survives and the
 *  retry appends to it — strictly better than the unbounded alternative, which would eat input
 *  nobody asked us to touch.
 *
 *  ⚠ UNVERIFIED AGAINST A LIVE TUI. Claude Code's composer is Ink-based with its own key
 *  handling, and its bindings are not discoverable from the shipped binary (the keybinding table
 *  embedded there is Node's REPL, not the composer — `Ctrl+D — Exit if line empty` gives it away).
 *  These are the readline conventions and the safe-when-unbound property is what makes shipping
 *  them acceptable before that check. See the RESULT for the one-command way to settle it. */
export function clearComposerSequence(lines = 1): string {
  const n = Math.max(1, Math.min(lines, MAX_CLEAR_LINES))
  // First (deepest) line, then walk up: join, clear, join, clear…
  return '\x05\x15' + '\x7f\x05\x15'.repeat(n - 1)
}

/** Ceiling on the walk. A pasted brief can be long, but every step is a write into a live pty and
 *  an unbounded loop driven by a stored string's line count is a denial-of-service on the lane if
 *  that string is ever wrong. 200 covers every real dispatch (the longest in the store is far
 *  under it) and bounds the damage if it is not. */
export const MAX_CLEAR_LINES = 200

/** How many lines a message occupies in the composer — the argument for the walk above. */
export function composerLines(text: string): number {
  return text.split('\n').length
}

/** Minimum gap between two submissions to the SAME terminal. 350ms was the smallest
 *  spacing that reliably submitted a 3-message burst in a live session; the cost of
 *  being generous here is only latency on bursts, while being too tight silently
 *  merges tasks. */
export const SUBMIT_GAP_MS = 350

/** Delay before the follow-up bare CR sent after every submission. Even with the gap,
 *  a single CR can still be swallowed when the TUI is busy (mid-commit or redrawing a
 *  running turn) — the task then sits in the composer as a draft and the lane looks
 *  "stuck": dispatched, but no turn ever starts. A lone CR after the commit window
 *  submits a stranded draft, and is a no-op on an empty composer, so re-firing it
 *  unconditionally is safe. (Narrow caveat: a human typing into that same lane within
 *  this window could have a partial message submitted — dispatch targets are almost
 *  always unattended, and losing dispatched tasks is the worse failure.) */
export const SUBMIT_NUDGE_MS = 800

/** Extra nudge delay per 1000 characters of message.
 *
 *  The 800ms floor was measured with SHORT strings ("Reply with exactly: ALPHA") and is a
 *  guess at how long the TUI needs to commit a paste. That cost is NOT constant: committing
 *  a paste means parsing it and re-rendering a composer that now wraps over N rows, so it
 *  grows with the message. Delivery does not — measured through a real pty, `write_all` of
 *  the whole submit sequence returns in ≤0.3ms at every size from 200 to 8000 chars (the
 *  kernel takes the entire payload; it never blocks), so every length-dependent millisecond
 *  is on the TUI's side of the wire.
 *
 *  When the fixed 800ms nudge lands INSIDE that window, the CR is read as input against a
 *  half-applied paste: the prefix submits as its own (truncated) turn and the remainder
 *  lands in the freshly-cleared composer behind the newline the CR left — which is exactly
 *  the reported artifact, an empty first line with the tail of the message on the second.
 *  See submit-queue.test.ts, which reproduces it against a model of that race.
 *
 *  1.5ms/char is deliberately generous: over-waiting only delays the RESCUE CR (a no-op when
 *  the message already went through), while under-waiting splits the message. */
export const SUBMIT_NUDGE_PER_1K_MS = 1500

/** Ceiling on the scaled nudge. Past this the rescue is simply late; a message long enough
 *  to hit the cap (~3.5k chars) is better served by the closed-loop delivery confirmation
 *  below, which this constant used to be the only stand-in for. */
export const SUBMIT_NUDGE_MAX_MS = 6000

/** How often the wait re-asks whether the turn has started.
 *
 *  The tailer polls the JSONL at 1s, so that is the floor on how fast a confirmation can
 *  possibly arrive; this is finer than the floor only so the wait ENDS promptly once it does. */
export const CONFIRM_POLL_MS = 250

/** How long to wait for a turn before firing the rescue CR at all.
 *
 *  Deliberately far larger than any nudge constant above, and that is the whole trade the closed
 *  loop buys. An open-loop timer has to be small enough to rescue promptly AND large enough never
 *  to interrupt a commit — and no constant satisfies both, because commit time is set by machine
 *  load rather than by anything we can see. Once a confirmation ends the wait early, the common
 *  case stops depending on this number at all, so it can be sized for the only thing that still
 *  matters: never being early. Being late costs nothing (the CR is a no-op on an empty composer,
 *  and a stranded draft submitted thirty seconds late is still submitted); being early corrupts.
 *
 *  30s is ~27× the commit time behind the reported failure (>1.1s for 203 chars at load 4.0). It
 *  is reached in exactly one situation: nothing ever confirms — an untracked `local-` session with
 *  no transcript to watch. That degrades to the old open-loop behaviour, which is the honest
 *  floor: with no observation available there is no way to tell a slow commit from a swallowed
 *  CR, and the only choice left is how long to wait before guessing. */
export const RESCUE_AFTER_MS = 30_000

/** When to give up waiting and send the rescue.
 *
 *  Two regimes, and the difference is whether an observation is even available:
 *
 *  · `observable` — something is tailing this terminal's transcript, so a turn WILL be seen
 *    whenever it happens. The wait can be long because it almost never runs to completion:
 *    confirmation ends it, usually within the tailer's 1s poll.
 *  · not observable — no transcript to watch (a pty whose JSONL does not exist yet). There is
 *    nothing to wait FOR, so waiting 30s would just stall the lane for half a minute per
 *    message. Falls back to exactly today's open-loop timing: no better, but no worse either,
 *    and the honest answer when the loop cannot be closed.
 *
 *  Either way a very long paste keeps the extra grace `nudgeDelayFor` computes — the length term
 *  was never WRONG, it was just never the dominant one. */
export function rescueDelayFor(text: string, floorMs: number = SUBMIT_NUDGE_MS, observable = true): number {
  const open = nudgeDelayFor(text, floorMs)
  return observable ? Math.max(RESCUE_AFTER_MS, open) : open
}

/** How long to keep watching after the rescue CR before declaring a submission undelivered.
 *  Generous: this is the last word on a dispatch, and calling one lost when it merely started
 *  slowly would be worse than saying nothing — the whole point is that the report is true. */
export const CONFIRM_WINDOW_MS = 4000

/** How often the verdict re-asks whether the target lane is still mid-turn. Matched to the
 *  tailer's 1s poll: asking faster cannot learn anything sooner. */
export const BUSY_RECHECK_MS = 1000

/** How long to wait before the watchdog CR for a message of this length. */
export function nudgeDelayFor(text: string, floorMs: number = SUBMIT_NUDGE_MS): number {
  return Math.min(SUBMIT_NUDGE_MAX_MS, floorMs + Math.round((text.length / 1000) * SUBMIT_NUDGE_PER_1K_MS))
}

export interface SubmitQueueDeps {
  write: (id: string, data: string) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** The loop's last step: this submission was never seen to become a turn, even after the
   *  rescue CR. Fires ONCE per submission and never retries on its own — a dispatch that
   *  re-sends itself unattended is how you get the same work done twice. The caller's job is to
   *  make it visible; see DashboardView, which marks the DispatchRecord `undelivered`. */
  onUndelivered?: (id: string, text: string) => void
}

export interface SubmitQueue {
  /** Enqueue a message for `id`; resolves once it has been written. */
  submit(id: string, text: string): Promise<void>
  /** Clear a lane's composer, in the SAME per-terminal chain as `submit`. Chained rather than
   *  written directly so a clear can never overtake — or be overtaken by — a submission already
   *  queued for that lane, which would clear the wrong text. */
  clearComposer(id: string, lines?: number): Promise<void>
  /** Disarm any watchdog CR still pending for THIS terminal.
   *
   *  Interrupting has to call this. Claude Code restores the draft text into the composer
   *  when it is interrupted, so a nudge that fires afterwards submits that restored draft and
   *  the agent starts the same work again — indistinguishable from "stop did nothing". The
   *  window used to be a fixed 800ms; length scaling widened it to as much as 6s, so the
   *  race went from narrow to routine on exactly the long prompts dispatch sends.
   *
   *  A HUMAN TYPING INTO THE LANE has to call it too, and that is the worse failure of the
   *  two: their half-written line is sitting in the same TUI composer the rescue CR submits,
   *  and the CR cannot tell a stranded dispatch from a person mid-sentence. It submits what
   *  is there — the agent then acts on a truncated instruction, which is worse than losing
   *  the text. The window is the full `RESCUE_AFTER_MS` on any observed terminal, so every
   *  dispatch used to open 30 seconds in which anything typed could be sent.
   *
   *  `reason` decides whether the disarmed submission is REPORTED. Stopping is deliberate, so
   *  there is nothing to report; typing is not a decision about the dispatch at all, and
   *  suppressing its CR may leave it stranded as a draft forever — that has to surface
   *  through `onUndelivered` rather than vanish.
   *
   *  Per terminal, like the queues themselves: stopping lane A must not disarm lane B. */
  cancelNudge(id: string, reason?: 'interrupt' | 'typing'): void
  /** CLOSE THE LOOP: the transcript has recorded a real user turn on this terminal, so whatever
   *  we last wrote there actually committed.
   *
   *  This is what turns the watchdog from a guess into a check. Everything before it was
   *  open-loop — wait N milliseconds and fire a CR at a TUI whose pace we can only estimate —
   *  and the estimate being wrong in either direction has its own bug: too early splits a long
   *  paste in half, too late leaves the task sitting in the composer. With a confirmation the
   *  timer stops being the decision and becomes only a deadline.
   *
   *  Called by whoever watches the transcript (DashboardView); the queue stays free of session
   *  shapes so it remains testable without one. */
  confirm(id: string): void
  /** What this terminal is currently waiting to have confirmed, and when we wrote it.
   *
   *  Exists so the watcher needs no cooperation from the fourteen call sites that submit: the
   *  queue already knows what it sent, and asking it beats threading a registry through every
   *  dispatch path. `at` is the write time, which is what lets the watcher ignore turns older
   *  than the submission — otherwise re-dispatching the same sentence would confirm itself
   *  against the previous send's turn. */
  /** Mark this terminal's turns as OBSERVABLE — its transcript is being tailed, so a
   *  confirmation will arrive whenever the turn does.
   *
   *  Sticky, and set by the same watcher that calls `confirm`. Without it the queue cannot tell
   *  "no turn yet" from "no way to ever see a turn", and would spend the full rescue horizon
   *  waiting on a terminal nobody is watching — half a minute of dead air per message on a pty
   *  whose transcript does not exist yet. */
  observable(id: string): void
  /** Whether this lane is MID-TURN right now — told by the same watcher that calls `confirm`,
   *  from the session's phase.
   *
   *  It is not a confirmation and must never be read as one: a lane is routinely already
   *  running when a dispatch is typed into it, so "busy" says nothing about whether OUR message
   *  landed. What it settles is the opposite question — whether the absence of a confirmation
   *  means anything yet. A working lane has not reached the boundary at which a queued prompt
   *  becomes visible, so declaring the message lost there is a guess, and it was a wrong one:
   *  every stacked "never started the task it was sent" toast in the 2026-08-06 report came
   *  from a lane that was working at the time and did the work afterwards.
   *
   *  Reporting is therefore deferred while this is true — and only while it is true. A lane that
   *  goes idle with no turn and nothing queued still gets named; see the verdict window. */
  busy(id: string, busy: boolean): void
  pending(id: string): { text: string; at: number } | undefined
  /** Await every outstanding delivery VERDICT (not the writes — `submit` already resolves on
   *  those). The confirmation window runs detached so it can't hold up the next dispatch, which
   *  leaves tests with nothing to await; this is that handle. */
  idle(): Promise<void>
}

export function createSubmitQueue(deps: SubmitQueueDeps, gapMs: number = SUBMIT_GAP_MS, nudgeMs: number = SUBMIT_NUDGE_MS): SubmitQueue {
  const now = deps.now ?? (() => Date.now())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  // Per-terminal promise chain + the last write time on that terminal.
  const chains = new Map<string, Promise<void>>()
  const lastAt = new Map<string, number>()
  // Bumped by cancelNudge. A nudge captures the value before its wait and only fires if it
  // still matches — so a cancel during the wait disarms it without needing a timer handle.
  const nudgeGen = new Map<string, number>()
  // Why the last cancel happened. Read only on the cancelled branch, to decide between
  // "deliberate, say nothing" and "a human walked in, so this dispatch is now in limbo".
  const cancelReason = new Map<string, 'interrupt' | 'typing'>()
  // Bumped by confirm(), read the same way: a submission captures it before writing and
  // compares afterwards, so "was this confirmed?" is a counter comparison rather than a
  // subscription the queue would have to own and tear down.
  const confirmGen = new Map<string, number>()
  // What each terminal is waiting on. Set at the write, cleared the moment the submission is
  // settled either way — a stale entry here would have the watcher confirming a message whose
  // window closed long ago.
  const awaiting = new Map<string, { text: string; at: number }>()
  // Terminals whose transcript is being tailed — see `observable`.
  const watched = new Set<string>()
  // Terminals currently mid-turn — see `busy`. Read only by the verdict window.
  const working = new Set<string>()
  // Detached confirmation windows still in flight — see `idle`.
  const watches = new Set<Promise<void>>()

  return {
    clearComposer(id, lines = 1) {
      const prev = chains.get(id) ?? Promise.resolve()
      // No gap wait and no confirmation window: this writes no CR, so there is no turn to wait
      // for and nothing to rescue. It only has to be ORDERED with respect to the submissions
      // around it.
      const next = prev.then(async () => { deps.write(id, clearComposerSequence(lines)) })
      chains.set(id, next.catch(() => {}))
      return next
    },
    submit(id, text) {
      const prev = chains.get(id) ?? Promise.resolve()
      const next = prev
        .then(async () => {
          const last = lastAt.get(id)
          if (last !== undefined) {
            const since = now() - last
            if (since < gapMs) await sleep(gapMs - since)
          }
          const gen = nudgeGen.get(id) ?? 0
          // Captured BEFORE the write: a turn that started earlier (the lane was already busy
          // when we arrived) must not be read as confirmation of a message we hadn't sent yet.
          const seen = confirmGen.get(id) ?? 0
          const cancelled = () => (nudgeGen.get(id) ?? 0) !== gen
          const confirmed = () => (confirmGen.get(id) ?? 0) !== seen

          deps.write(id, submitSequence(text))
          const writtenAt = now()
          awaiting.set(id, { text, at: writtenAt })
          // THE CLOSED LOOP. Wait for the turn to START — re-asking, not sleeping a guessed
          // interval and then firing blind. Three things fall out of polling rather than
          // sleeping, and all three were bugs:
          //
          //  · a message that commits SLOWLY is still delivered whole, because the wait ends on
          //    the turn rather than on a deadline. The deadline model was falsified by a 203-char
          //    dispatch splitting on a loaded machine: commit time tracks CPU contention, not
          //    length, so no constant could have been right;
          //  · a message that commits QUICKLY unblocks the queue immediately, so a burst is
          //    spaced by what actually happened rather than by SUBMIT_GAP_MS — which is a
          //    stronger guarantee against the original merge bug than the gap ever was;
          //  · and the rescue CR, which is itself a keystroke and the thing that halves a
          //    half-applied paste, is only ever sent once we know no turn started.
          const deadline = writtenAt + rescueDelayFor(text, nudgeMs, watched.has(id))
          while (!confirmed() && !cancelled() && now() < deadline) {
            await sleep(Math.min(CONFIRM_POLL_MS, deadline - now()))
          }
          // DETACHED, deliberately. Waiting for the verdict inside the chain would make every
          // submission hold its terminal for the whole confirmation window, so a burst of
          // dispatches to one lane — the exact thing the coordinator's charter encourages —
          // would crawl out four seconds apart. The chain ends at the write, as it always did;
          // only the reporting outlives it.
          //
          // `ignoreCancel` is for the typing case: the cancel is what STARTED this watch, so
          // the usual "a cancel means the user settled it deliberately" reading is wrong here.
          // Only a real turn clears it.
          const watchDelivery = (ignoreCancel = false) => {
            const watch = (async () => {
              await sleep(CONFIRM_WINDOW_MS)
              // BUSY IS NOT LOST. The window above is sized for a lane that is free to answer;
              // a lane that is MID-TURN cannot produce the boundary at which a queued prompt
              // becomes a turn, so the same silence means nothing about it. Keep watching —
              // `confirm` still ends this the moment the transcript shows the message, and
              // that is now also true while the lane works, since an enqueue is recorded on
              // arrival. Unbounded on purpose: a lane working for an hour on the message we
              // sent is not a failure, and there is no length of that hour at which saying
              // "it never started" becomes true.
              let held = false
              while (!confirmed() && working.has(id)) {
                held = true
                await sleep(BUSY_RECHECK_MS)
              }
              // Going idle is not instant proof either — the turn still has to reach us through
              // the tailer's poll. Give a lane that just stopped working the same window as one
              // that was never busy, so the verdict is made on the same evidence.
              if (held && !confirmed()) await sleep(CONFIRM_WINDOW_MS)
              const lost = (ignoreCancel || !cancelled()) && !confirmed()
              // Only clear if this submission is still the one being awaited: a newer send on
              // the same terminal owns the slot now, and dropping its entry would blind the
              // watcher.
              if (awaiting.get(id)?.at === writtenAt) awaiting.delete(id)
              if (lost) deps.onUndelivered?.(id, text)
            })().catch(() => { /* reporting must never break the queue */ })
            watches.add(watch)
            void watch.finally(() => watches.delete(watch))
          }

          // CONFIRMED FIRST. Both can be true — a turn started and then the user typed — and
          // delivered beats disarmed: the message is on the record, so there is nothing to
          // rescue and nothing to report.
          if (confirmed()) { awaiting.delete(id); lastAt.set(id, now()); return }
          // Disarmed mid-wait — the CR must NOT go out.
          if (cancelled()) {
            lastAt.set(id, now())
            // Stop is deliberate: the user settled this submission themselves.
            if (cancelReason.get(id) !== 'typing' || !deps.onUndelivered) { awaiting.delete(id); return }
            // Typing is not. We suppressed the only thing that would have submitted a stranded
            // draft, so this dispatch may now sit in that composer forever — and silence would
            // make it look delivered. Give it the same window (no CR) and then say so if no
            // turn ever appears. The entry stays in `awaiting` on purpose: the transcript
            // watcher can still confirm it, which is what keeps the report honest when the
            // paste committed on its own a moment after the keystroke.
            watchDelivery(true)
            return
          }
          deps.write(id, '\r')
          lastAt.set(id, now())
          // Still open-loop past this point unless someone is watching, so give the rescue its
          // own window and then say so. No second CR: if a bare CR did not commit it, another
          // one will not either, and each extra keystroke is another chance to split something.
          if (!deps.onUndelivered) { awaiting.delete(id); return }
          watchDelivery()
        })
        // A failed write must not break ordering for everything queued behind it.
        .catch(() => { awaiting.delete(id) /* dropped submission */ })
      chains.set(id, next)
      return next
    },
    idle() {
      return Promise.all([...watches]).then(() => { /* verdicts only, not the writes */ })
    },
    cancelNudge(id, reason = 'interrupt') {
      nudgeGen.set(id, (nudgeGen.get(id) ?? 0) + 1)
      cancelReason.set(id, reason)
      // Stop is deliberate, so nothing about this submission is a failure worth reporting.
      // Typing keeps the entry: the submission is now in limbo rather than settled, and the
      // transcript watcher needs it to be able to confirm a paste that lands anyway.
      if (reason !== 'typing') awaiting.delete(id)
    },
    confirm(id) {
      confirmGen.set(id, (confirmGen.get(id) ?? 0) + 1)
      awaiting.delete(id)
    },
    observable(id) {
      watched.add(id)
    },
    busy(id, busy) {
      if (busy) working.add(id)
      else working.delete(id)
    },
    pending(id) {
      return awaiting.get(id)
    },
  }
}

/** Where the app-wide queue reports a lost submission. Installed by the view that owns the
 *  dispatch log (DashboardView) rather than imported by this module, which must not learn what a
 *  project or a dispatch record is — the queue's whole value is that it can be tested against a
 *  fake pty and nothing else. Absent until then, and absent is fine: the loop's first two steps
 *  (skip the CR when confirmed, fire it when not) work without anyone listening. */
let undeliveredHandler: ((id: string, text: string) => void) | undefined
export function onUndeliveredSubmission(fn: (id: string, text: string) => void) {
  undeliveredHandler = fn
}

/** The app-wide queue. Terminal writes already go through an ordered per-terminal write
 *  queue in the bridge (byte ordering); this adds the SUBMISSION spacing on top. */
export const submitQueue = createSubmitQueue({
  write: (id, data) => window.operator.terminalWrite(id, data),
  onUndelivered: (id, text) => undeliveredHandler?.(id, text),
})
