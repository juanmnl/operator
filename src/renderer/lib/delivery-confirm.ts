// Did the message we submitted actually become a turn?
//
// The submit queue's watchdog was open-loop: wait a while, fire a bare CR, hope. Both ways of
// being wrong have already shipped as bugs — too early splits a long paste into a truncated turn
// plus a stranded draft, too late leaves the task sitting in the composer — because a timer can
// only ever estimate the TUI's pace. This is the observation that ends the guessing.
//
// The signal is the transcript's own USER turns. `transcript.rs` `apply_user` pushes every real
// human prompt into the session as `NarrationEntry { kind: 'user' }`, so the frontend can simply
// look for the message it sent. That beats every indirect proxy considered:
//
//   - "the lane became busy" — false on arrival, since a dispatch is routinely typed into a lane
//     that is ALREADY running, and it would confirm a message that never left the composer;
//   - "lastActivityAt advanced" — same defect, continuously true for a working lane;
//   - "the composer emptied" — not observable; Operator reads a transcript, not a TUI.
//
// Matching the CONTENT also gets the split for free: a turn holding a strict prefix of what we
// sent is not delivery, it is precisely the reported failure, and it is worth naming separately
// from silence because the two have different causes and different fixes.

/** The tailer truncates a recorded prompt at this many characters and appends an ellipsis
 *  (transcript.rs `apply_user`). A long dispatch therefore CANNOT come back verbatim, and a
 *  matcher that demanded equality would call every long delivery a failure. */
export const TURN_TEXT_CAP = 4000

/** Compare-shape for a turn: whitespace collapsed and trimmed.
 *
 *  Necessary because the two strings travel different roads. What we submit is one line inside a
 *  bracketed paste; what comes back has been through the TUI's composer and the tailer's JSON,
 *  and differs in line breaks and runs of spaces without differing in any way a human would call
 *  a difference. Nothing else is normalised — case and punctuation are content. */
export function normalizeTurn(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

export type DeliveryMatch =
  /** A turn carries what we sent (allowing for the tailer's truncation). */
  | 'delivered'
  /** A turn carries only the FRONT of it — the split. The rest is stranded in the composer. */
  | 'split'
  /** Nothing resembling it has been recorded. */
  | 'none'

/** Did the tailer truncate this turn? Its marker is the appended ellipsis, but the length test
 *  is what makes it safe: a user really can end a sentence with "…", and calling that truncation
 *  would let a genuinely split short message pass as delivered. */
function looksTruncated(turn: string, sent: string): boolean {
  if (!turn.endsWith('…')) return false
  // Normalisation can only ever shorten, so compare against the cap with slack rather than for
  // equality — an exact `=== TURN_TEXT_CAP` would fail on any prompt containing a double space.
  return sent.length > TURN_TEXT_CAP && turn.length > TURN_TEXT_CAP / 2
}

/** Match one submitted message against the user turns a session has recorded since.
 *
 *  `turns` is the raw text of every `kind: 'user'` narration entry the caller cares about —
 *  ideally only those recorded AFTER the submission, since an identical earlier prompt would
 *  otherwise confirm a message that never landed. The caller owns that window; this stays pure.
 *
 *  Strongest match wins: one turn matching exactly settles it even if another looks like a
 *  prefix, because a repeated dispatch legitimately produces both. */
export function matchSubmission(text: string, turns: readonly string[]): DeliveryMatch {
  const want = normalizeTurn(text)
  if (!want) return 'none'
  let best: DeliveryMatch = 'none'
  for (const raw of turns) {
    const got = normalizeTurn(raw)
    if (!got) continue
    if (got === want) return 'delivered'
    if (looksTruncated(got, want) && want.startsWith(got.slice(0, -1))) return 'delivered'
    // A PROPER prefix — shorter than what we sent, and the front of it. Guarded by a minimum so
    // a one-word turn ("yes", "go") that happens to open our message isn't read as our message
    // arriving broken; that is a different prompt, and calling it a split would be a lie in the
    // more alarming direction.
    if (got.length >= 24 && got.length < want.length && want.startsWith(got)) best = 'split'
  }
  return best
}

/** Clock slack when deciding which turns are "since" a submission. The transcript's timestamps
 *  and our write time come from the same machine, so this absorbs ordinary jitter rather than
 *  real skew — wide enough not to miss our own turn, far narrower than the gap between two
 *  dispatches of the same text. */
export const SINCE_SLACK_MS = 2_000

/** The human prompts the transcript recorded AT OR AFTER `sinceMs`, oldest first.
 *
 *  The window is the point. Dispatching the same sentence twice is ordinary — a retry, a task
 *  re-run — and matching against the whole recent tail would confirm the second send the instant
 *  it was written, using the FIRST one's turn as proof. An entry whose timestamp won't parse is
 *  kept: dropping it could only ever lose our own delivery, and the failure modes are not
 *  symmetric (a missed confirmation cries wolf; a stale one hides a real loss).
 *
 *  Kept here so the shape of a session is read in one place and the matcher never learns it. */
export function userTurnsSince(
  messages: ReadonlyArray<{ kind?: string; text?: string; timestamp?: string }> | undefined,
  sinceMs: number,
): string[] {
  const floor = sinceMs - SINCE_SLACK_MS
  return (messages ?? [])
    .filter((m) => m.kind === 'user' && !!m.text)
    .filter((m) => {
      const t = m.timestamp ? Date.parse(m.timestamp) : NaN
      return Number.isNaN(t) || t >= floor
    })
    .map((m) => m.text as string)
}
