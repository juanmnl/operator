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

export type ChipTone = 'accent' | 'warn' | 'muted' | 'progress'

export interface OutcomeChip {
  label: string
  tone: ChipTone
  /** Only a held dispatch is actionable, and only through the EXISTING approval handlers. */
  actionable?: boolean
}

/** `outcome` → chip. One row per outcome, no invented states. `pending-approval` is the only
 *  actionable one, and it routes to the approval handlers that already exist. */
export function chipForOutcome(outcome: DispatchRecord['outcome']): OutcomeChip {
  switch (outcome) {
    case 'sent':
    case 'launched':
      return { label: 'delivered', tone: 'accent' }
    case 'queued':
      return { label: 'queued · behind current task', tone: 'progress' }
    case 'pending-approval':
      return { label: 'held · needs your approval', tone: 'warn', actionable: true }
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
