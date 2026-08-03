import type { DispatchRecord } from '../../shared/types'

// WHAT A DISPATCH OUTCOME SAYS TO A HUMAN. One vocabulary, for every surface that shows one.
//
// This lived in `lib/project-channel.ts` and moved out whole when the channel was deleted — the
// mapping was never channel-specific, it just happened to be born there. `TaskBoard` already
// imported it across that boundary, and `DispatchLog` had its own six-entry copy that was missing
// the four outcomes that matter most (`hop-limit`, `pair-brake`, `paused`, `undelivered`), so it
// printed raw enum strings for exactly the records the channel's death made it the sole surface
// for. Two half-vocabularies for one concept is how a `pair-brake` ends up rendering as
// "pair-brake" on the only screen that will ever show it.

/** `progress` currently has NO user — `queued` moved to `warn` (see below). It is kept because
 *  `DispatchLog` renders every member of this union explicitly, and a tone with a branch and no
 *  user is harmless where a tone with a user and no branch is not: that is the defect that put
 *  `queued` in the same ink as `declined` for a whole release. */
export type ChipTone = 'accent' | 'warn' | 'muted' | 'progress'

export interface OutcomeChip {
  label: string
  tone: ChipTone
}
// There was an `actionable?: boolean` here, set only on `pending-approval`. Nothing read it: its
// one reader (`isActionableChip`) died with the channel, and both surviving surfaces test
// `outcome === 'pending-approval'` directly — which is right, because whether a row gets an
// Approve button depends on the approval GATE, not on how the row is inked.

/** `outcome` → chip. One row per outcome, no invented states. */
export function chipForOutcome(outcome: DispatchRecord['outcome']): OutcomeChip {
  switch (outcome) {
    case 'sent':
    case 'launched':
      return { label: 'delivered', tone: 'accent' }
    case 'queued':
      // NOT "queued · behind current task", which is what this said and what nothing does.
      // The only writer is the reply path, when `evaluateDelivery` blocks with reason `queued`:
      // `"X" isn't running, and a message never starts a lane. Nothing was sent.` Nothing is
      // queued, nothing is behind anything, and nothing retries — so the agent was being told
      // (by REPLY_PROTOCOL) that its message was DROPPED while the human was shown that it was
      // waiting its turn, for the same event. The legacy dispatch records that also carry this
      // outcome ("lane idle, pre-auto-launch, or a failed launch") were equally undelivered, so
      // one honest label covers both. `warn`, with the other outcomes that never arrived.
      return { label: 'not delivered · lane wasn’t running', tone: 'warn' }
    case 'pending-approval':
      return { label: 'held · needs your approval', tone: 'warn' }
    case 'rejected':
      return { label: 'declined', tone: 'muted' }
    case 'unassigned':
      return { label: 'no matching lane', tone: 'muted' }
    // The agent→agent brakes. All three mean nothing was typed anywhere, and none retries on its
    // own — so each one names WHY, because "not delivered" alone would send you reading code.
    case 'hop-limit':
      return { label: 'held · chain limit reached', tone: 'warn' }
    case 'pair-brake':
      return { label: 'held · pair sending too fast', tone: 'warn' }
    case 'paused':
      // `warn`, like the two brakes above it. It used to be `muted` — the same tone as `declined`
      // and `no matching lane`, i.e. the quietest ink in the feed — which drew a message that
      // reached NOBODY more faintly than one that landed. All three of these mean the same thing
      // (nothing was typed anywhere, and nothing retries on its own), so they read the same.
      return { label: 'held · agent↔agent paused', tone: 'warn' }
    // Not "held": this one was SENT and then observed not to arrive, which is a different and
    // worse thing than never leaving. It says so, because the recovery is manual either way and
    // a user who reads "delivered" while the lane sits idle has no way to find out otherwise.
    case 'undelivered':
      return { label: 'sent · never started', tone: 'warn' }
    default:
      // An outcome from a future version: show it verbatim rather than mislabelling it.
      return { label: String(outcome), tone: 'muted' }
  }
}
