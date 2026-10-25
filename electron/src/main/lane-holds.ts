// WHAT A LANE IS OWED, KEPT WHERE A RENDERER CRASH CANNOT REACH IT (review F1, 2026-10-24).
//
// A message to a lane waits in the renderer's submit queue while the person has unsent text in that
// lane's composer (src/renderer/lib/submit-queue), with no timeout. The queue and the draft flags
// are renderer memory; the ptys and the text in their composers live here, in main, and survive a
// crash or reload. Without this, a reload dropped every held message with nothing said, and the
// next delivery merged into the draft the new renderer could not know about.
//
// The renderer tells main each change (`apply`) and the next renderer takes the lot once its tabs
// are back (`take`). Memory only: an app quit ends the ptys, so their composers are gone too.

import type { LaneHoldOp, OwedSubmission } from '../../../src/shared/types'

/** More than this many owed messages means settles were lost. The oldest go first. */
export const OWED_LIMIT = 500

export class LaneHolds {
  private readonly drafts = new Set<string>()
  private readonly owed = new Map<string, OwedSubmission>()

  apply(op: LaneHoldOp): void {
    if (op.kind === 'draft') {
      if (op.on) this.drafts.add(op.terminalId)
      else this.drafts.delete(op.terminalId)
    } else if (op.kind === 'owe') {
      this.owed.set(op.entry.key, op.entry)
      while (this.owed.size > OWED_LIMIT) this.owed.delete(this.owed.keys().next().value as string)
    } else if (op.kind === 'settle') {
      this.owed.delete(op.key)
    }
  }

  /** Hand everything to a new renderer: the lanes with a draft, and the owed messages oldest first.
   *  The owed ones are cleared, since the renderer enqueues them again and they come back as new
   *  `owe`s. The drafts stay: they are the composers' state, not a handover. */
  take(): { drafts: string[]; owed: OwedSubmission[] } {
    const owed = [...this.owed.values()].sort((a, b) => a.at - b.at)
    this.owed.clear()
    return { drafts: [...this.drafts], owed }
  }
}
