import { describe, it, expect } from 'vitest'
import { createSubmitQueue, submitSequence, SUBMIT_GAP_MS, SUBMIT_NUDGE_MS } from './submit-queue'

/** A deterministic clock: `sleep` advances virtual time instead of waiting. */
function fakeClock() {
  let t = 0
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms },
    advance: (ms: number) => { t += ms },
  }
}

/** The paste submissions from a write log (excluding the bare-CR watchdog nudges). */
const pastes = <T extends { data: string }>(writes: T[]) => writes.filter((w) => w.data !== '\r')

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

    const subs = pastes(writes)
    expect(subs.map((w) => w.data)).toEqual([submitSequence('A'), submitSequence('B'), submitSequence('C')])
    // First is immediate; each subsequent one waits out the gap (measured from the
    // previous submission's nudge, which is what last touched the terminal).
    expect(subs[0].at).toBe(0)
    expect(subs[1].at - subs[0].at).toBeGreaterThanOrEqual(SUBMIT_GAP_MS)
    expect(subs[2].at - subs[1].at).toBeGreaterThanOrEqual(SUBMIT_GAP_MS)
  })

  it('follows every submission with a bare-CR nudge after the commit window', async () => {
    const clock = fakeClock()
    const writes: { at: number; data: string }[] = []
    const q = createSubmitQueue({ write: (_id, data) => writes.push({ at: clock.now(), data }), ...clock })

    await q.submit('t1', 'A')

    // The stranded-draft rescue: paste+CR, then a lone CR once the TUI has had time
    // to commit — submits a draft whose original CR was swallowed, no-op otherwise.
    expect(writes.map((w) => w.data)).toEqual([submitSequence('A'), '\r'])
    expect(writes[1].at - writes[0].at).toBe(SUBMIT_NUDGE_MS)
  })

  it('does NOT make one terminal wait on another', async () => {
    const clock = fakeClock()
    const writes: { id: string; data: string }[] = []
    const q = createSubmitQueue({ write: (id, data) => writes.push({ id, data }), ...clock })

    await Promise.all([q.submit('t1', 'A'), q.submit('t2', 'B')])

    // Independent lanes interleave: t2's paste goes out BEFORE t1's nudge completes.
    // (A shared chain would serialize the full t1 task — paste + nudge — first. The
    // shared fake clock advances during sleeps, so wall-time assertions can't be used.)
    const kinds = writes.map((w) => `${w.id}:${w.data === '\r' ? 'nudge' : 'paste'}`)
    expect(kinds).toEqual(['t1:paste', 't2:paste', 't1:nudge', 't2:nudge'])
  })

  it('does not delay a submission that comes long after the previous one', async () => {
    const clock = fakeClock()
    const writes: { at: number; data: string }[] = []
    const q = createSubmitQueue({ write: (_id, data) => writes.push({ at: clock.now(), data }), ...clock })

    await q.submit('t1', 'A')
    clock.advance(SUBMIT_GAP_MS * 3) // idle period
    await q.submit('t1', 'B')

    const subs = pastes(writes)
    // B goes out as soon as it's queued — the idle period already exceeds the gap.
    expect(subs[1].at).toBe(SUBMIT_NUDGE_MS + SUBMIT_GAP_MS * 3)
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
    expect(pastes(seen.map((data) => ({ data }))).map((w) => w.data)).toEqual([submitSequence('after')]) // the failure didn't stall the queue
  })

  it('nudges land between submissions, never reordered across them', async () => {
    const clock = fakeClock()
    const writes: string[] = []
    const q = createSubmitQueue({ write: (_id, data) => writes.push(data), ...clock })

    await Promise.all([q.submit('t1', 'A'), q.submit('t1', 'B')])
    expect(writes).toEqual([submitSequence('A'), '\r', submitSequence('B'), '\r'])
  })
})
