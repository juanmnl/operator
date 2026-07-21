import { describe, it, expect } from 'vitest'
import { createSubmitQueue, submitSequence, SUBMIT_GAP_MS } from './submit-queue'

/** A deterministic clock: `sleep` advances virtual time instead of waiting. */
function fakeClock() {
  let t = 0
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms },
    advance: (ms: number) => { t += ms },
  }
}

describe('submitSequence', () => {
  it('wraps text as a bracketed paste with a trailing CR', () => {
    expect(submitSequence('hi')).toBe('\x1b[200~hi\x1b[201~\r')
  })
})

describe('createSubmitQueue', () => {
  it('spaces consecutive submissions to the SAME terminal by the gap', async () => {
    const clock = fakeClock()
    const writes: { at: number; id: string; data: string }[] = []
    const q = createSubmitQueue({ write: (id, data) => writes.push({ at: clock.now(), id, data }), ...clock })

    // The burst that used to merge into one composer draft.
    await Promise.all([q.submit('t1', 'A'), q.submit('t1', 'B'), q.submit('t1', 'C')])

    expect(writes.map((w) => w.data)).toEqual([submitSequence('A'), submitSequence('B'), submitSequence('C')])
    // First is immediate; each subsequent one waits out the gap.
    expect(writes[0].at).toBe(0)
    expect(writes[1].at - writes[0].at).toBeGreaterThanOrEqual(SUBMIT_GAP_MS)
    expect(writes[2].at - writes[1].at).toBeGreaterThanOrEqual(SUBMIT_GAP_MS)
  })

  it('does NOT make one terminal wait on another', async () => {
    const clock = fakeClock()
    const writes: { at: number; id: string }[] = []
    const q = createSubmitQueue({ write: (id) => writes.push({ at: clock.now(), id }), ...clock })

    await Promise.all([q.submit('t1', 'A'), q.submit('t2', 'B')])

    // Independent lanes both submit immediately — no cross-terminal blocking.
    expect(writes.every((w) => w.at === 0)).toBe(true)
    expect(writes.map((w) => w.id).sort()).toEqual(['t1', 't2'])
  })

  it('does not delay a submission that comes long after the previous one', async () => {
    const clock = fakeClock()
    const writes: number[] = []
    const q = createSubmitQueue({ write: () => writes.push(clock.now()), ...clock })

    await q.submit('t1', 'A')
    clock.advance(SUBMIT_GAP_MS * 3) // idle period
    await q.submit('t1', 'B')

    expect(writes[1] - writes[0]).toBe(SUBMIT_GAP_MS * 3) // no extra wait added
  })

  it('keeps ordering when a write throws', async () => {
    const clock = fakeClock()
    const seen: string[] = []
    const q = createSubmitQueue({
      write: (_id, data) => {
        if (data.includes('boom')) throw new Error('dead pty')
        seen.push(data)
      },
      ...clock,
    })

    await Promise.all([q.submit('t1', 'boom'), q.submit('t1', 'after')])
    expect(seen).toEqual([submitSequence('after')]) // the failure didn't stall the queue
  })
})
