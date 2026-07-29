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
 *  this constant is a stand-in for. */
export const SUBMIT_NUDGE_MAX_MS = 6000

/** How long to wait before the watchdog CR for a message of this length. */
export function nudgeDelayFor(text: string, floorMs: number = SUBMIT_NUDGE_MS): number {
  return Math.min(SUBMIT_NUDGE_MAX_MS, floorMs + Math.round((text.length / 1000) * SUBMIT_NUDGE_PER_1K_MS))
}

export interface SubmitQueueDeps {
  write: (id: string, data: string) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface SubmitQueue {
  /** Enqueue a message for `id`; resolves once it has been written. */
  submit(id: string, text: string): Promise<void>
  /** Disarm any watchdog CR still pending for THIS terminal.
   *
   *  Interrupting has to call this. Claude Code restores the draft text into the composer
   *  when it is interrupted, so a nudge that fires afterwards submits that restored draft and
   *  the agent starts the same work again — indistinguishable from "stop did nothing". The
   *  window used to be a fixed 800ms; length scaling widened it to as much as 6s, so the
   *  race went from narrow to routine on exactly the long prompts dispatch sends.
   *
   *  Per terminal, like the queues themselves: stopping lane A must not disarm lane B. */
  cancelNudge(id: string): void
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

  return {
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
          deps.write(id, submitSequence(text))
          // Watchdog nudge (see SUBMIT_NUDGE_MS): re-fire the CR once the TUI's commit
          // window has passed, so a swallowed submit doesn't strand the task as a draft.
          // Inside the chain, so the next submission's gap counts from the nudge.
          //
          // The wait SCALES WITH LENGTH (see nudgeDelayFor). A fixed delay is only ever a
          // guess at the TUI's commit time, and that guess was calibrated on short strings;
          // firing it while a long paste is still being applied is what split one dispatch
          // into a truncated turn plus a stranded tail.
          await sleep(nudgeDelayFor(text, nudgeMs))
          // Disarmed mid-wait (the user hit stop) — the CR must NOT go out.
          if ((nudgeGen.get(id) ?? 0) !== gen) { lastAt.set(id, now()); return }
          deps.write(id, '\r')
          lastAt.set(id, now())
        })
        // A failed write must not break ordering for everything queued behind it.
        .catch(() => { /* dropped submission */ })
      chains.set(id, next)
      return next
    },
    cancelNudge(id) {
      nudgeGen.set(id, (nudgeGen.get(id) ?? 0) + 1)
    },
  }
}

/** The app-wide queue. Terminal writes already go through an ordered per-terminal write
 *  queue in the bridge (byte ordering); this adds the SUBMISSION spacing on top. */
export const submitQueue = createSubmitQueue({
  write: (id, data) => window.operator.terminalWrite(id, data),
})
