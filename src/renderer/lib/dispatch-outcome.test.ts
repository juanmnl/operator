import { describe, it, expect } from 'vitest'
import type { DispatchRecord } from '../../shared/types'
import { chipForOutcome, type ChipTone } from './dispatch-outcome'

// Ported from `project-channel.test.ts`, which was deleted whole with the channel. The claim at
// the time — "every describe tests a function that no longer exists" — was wrong about this one
// block: `chipForOutcome` moved to `lib/dispatch-outcome.ts` and survived, and its tests did not
// go with it. That matters more now than it did then, because this module is the single outcome
// vocabulary for the single surface where a `hop-limit` or a `pair-brake` is ever visible.

describe('chipForOutcome — derived, never invented', () => {
  it('maps each outcome to exactly one chip', () => {
    expect(chipForOutcome('sent')).toEqual({ label: 'delivered', tone: 'accent' })
    expect(chipForOutcome('launched')).toEqual({ label: 'delivered', tone: 'accent' })
    expect(chipForOutcome('rejected')).toEqual({ label: 'declined', tone: 'muted' })
    expect(chipForOutcome('unassigned')).toEqual({ label: 'no matching lane', tone: 'muted' })
  })

  it('names each agent↔agent brake, rather than saying only "not delivered"', () => {
    // These are the outcomes the dispatch log is now the ONLY surface for: a `replyId` record is
    // chat about work rather than work, so the board excludes every one of them by rule.
    expect(chipForOutcome('hop-limit')).toEqual({ label: 'held · chain limit reached', tone: 'warn' })
    expect(chipForOutcome('pair-brake')).toEqual({ label: 'held · pair sending too fast', tone: 'warn' })
    expect(chipForOutcome('paused')).toEqual({ label: 'held · agent↔agent paused', tone: 'warn' })
    expect(chipForOutcome('undelivered')).toEqual({ label: 'sent · never started', tone: 'warn' })
  })

  it('does NOT tell the human a dropped message is queued behind something', () => {
    // The label was `queued · behind current task`, which nothing does: the only writer is the
    // reply path when the target lane isn't running, where nothing was sent and nothing retries.
    // REPLY_PROTOCOL tells the agent the message is dropped — the two contradicted each other
    // about the same event.
    const chip = chipForOutcome('queued')
    expect(chip.label).not.toMatch(/behind current task/)
    expect(chip.label).toMatch(/not delivered/)
    expect(chip.tone).toBe('warn') // with the others that never arrived, not with `declined`
  })

  it('says which outcome is the one a human can resolve, and says it once', () => {
    // The original asserted an `actionable` flag on the chip. That flag is gone: nothing read it
    // (its reader died with the channel) and both surfaces key on `outcome === 'pending-approval'`
    // directly, which is correct — whether a row gets an Approve button is the approval gate's
    // business, not the ink's. What survives is the invariant that matters: exactly one outcome
    // reads as waiting on the human, and it names the human.
    expect(chipForOutcome('pending-approval').label).toMatch(/needs your approval/)
    const every: DispatchRecord['outcome'][] = [
      'sent', 'launched', 'queued', 'rejected', 'unassigned', 'hop-limit', 'pair-brake', 'paused', 'undelivered',
    ]
    for (const o of every) expect(chipForOutcome(o).label, o).not.toMatch(/your approval/)
  })

  it('shows an unknown future outcome verbatim rather than mislabelling it', () => {
    expect(chipForOutcome('something-new' as DispatchRecord['outcome']))
      .toEqual({ label: 'something-new', tone: 'muted' })
  })

  it('never returns an empty label, and only ever a tone the renderer handles', () => {
    // `DispatchLog` renders one branch per tone. A tone outside this set renders as muted, which
    // is how `queued` spent a release drawn identically to `declined`.
    const TONES: ChipTone[] = ['accent', 'warn', 'muted', 'progress']
    const every: DispatchRecord['outcome'][] = [
      'sent', 'launched', 'queued', 'pending-approval', 'rejected', 'unassigned',
      'hop-limit', 'pair-brake', 'paused', 'undelivered',
    ]
    for (const o of every) {
      const chip = chipForOutcome(o)
      expect(chip.label.length, o).toBeGreaterThan(0)
      expect(TONES, o).toContain(chip.tone)
      // …and nothing prints its own enum name, which is what the log did for four of these
      // before the vocabulary was shared.
      expect(chip.label, o).not.toBe(o)
    }
  })
})
