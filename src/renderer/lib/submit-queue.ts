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

export interface SubmitQueueDeps {
  write: (id: string, data: string) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface SubmitQueue {
  /** Enqueue a message for `id`; resolves once it has been written. */
  submit(id: string, text: string): Promise<void>
}

export function createSubmitQueue(deps: SubmitQueueDeps, gapMs: number = SUBMIT_GAP_MS): SubmitQueue {
  const now = deps.now ?? (() => Date.now())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  // Per-terminal promise chain + the last write time on that terminal.
  const chains = new Map<string, Promise<void>>()
  const lastAt = new Map<string, number>()

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
          deps.write(id, submitSequence(text))
          lastAt.set(id, now())
        })
        // A failed write must not break ordering for everything queued behind it.
        .catch(() => { /* dropped submission */ })
      chains.set(id, next)
      return next
    },
  }
}

/** The app-wide queue. Terminal writes already go through an ordered per-terminal write
 *  queue in the bridge (byte ordering); this adds the SUBMISSION spacing on top. */
export const submitQueue = createSubmitQueue({
  write: (id, data) => window.operator.terminalWrite(id, data),
})
