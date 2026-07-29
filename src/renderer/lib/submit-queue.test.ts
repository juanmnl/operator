import { describe, it, expect } from 'vitest'
import { createSubmitQueue, submitSequence, nudgeDelayFor, SUBMIT_GAP_MS, SUBMIT_NUDGE_MS, SUBMIT_NUDGE_MAX_MS, type SubmitQueue } from './submit-queue'

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
    // A 1-char message: the floor, unchanged.
    expect(writes[1].at - writes[0].at).toBe(nudgeDelayFor('A'))
    expect(writes[1].at - writes[0].at).toBeGreaterThanOrEqual(SUBMIT_NUDGE_MS)
  })

  it('waits LONGER before nudging a long message', async () => {
    const clock = fakeClock()
    const writes: { at: number; data: string }[] = []
    const q = createSubmitQueue({ write: (_id, data) => writes.push({ at: clock.now(), data }), ...clock })

    await q.submit('t1', 'x'.repeat(2000))

    const delay = writes[1].at - writes[0].at
    expect(delay).toBe(nudgeDelayFor('x'.repeat(2000)))
    // Strictly more than the short-message floor — the whole point of the fix.
    expect(delay).toBeGreaterThan(SUBMIT_NUDGE_MS)
    expect(delay).toBeLessThanOrEqual(SUBMIT_NUDGE_MAX_MS)
  })

  it('caps the scaled nudge so a huge paste cannot stall the queue', () => {
    expect(nudgeDelayFor('x'.repeat(100_000))).toBe(SUBMIT_NUDGE_MAX_MS)
    // Monotonic up to the cap — never shorter for a longer message.
    const lens = [0, 200, 500, 1000, 2000, 4000, 8000]
    const delays = lens.map((n) => nudgeDelayFor('x'.repeat(n)))
    expect(delays).toEqual([...delays].sort((a, b) => a - b))
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
    // (A's nudge is scaled off its own length, hence nudgeDelayFor rather than the floor.)
    expect(subs[1].at).toBe(nudgeDelayFor('A') + SUBMIT_GAP_MS * 3)
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

// --- the reported failure, reproduced --------------------------------------------------
// A MODEL of Claude Code's TUI, calibrated to the artifact in the bug report (a ~900-char
// dispatch that arrived as one truncated turn plus a stranded tail, with an empty first line
// above it). It is not a model of their source — it is the smallest consumer that exhibits
// the race the report describes: a paste is applied to the composer over a window that grows
// with its length, and a CR arriving mid-apply submits the prefix, leaves a newline in the
// cleared composer, and lets the remainder land behind it.
//
// Delivery itself is NOT modelled as slow, because it measurably isn't: write_all of the
// whole sequence through a real pty returns in ≤0.3ms at every length up to 8000 chars.
class FakeTui {
  composer = ''
  turns: string[] = []
  /** When the in-flight paste finishes being applied; 0 when idle. */
  private applyUntil = 0
  private pending = ''
  private startedAt = 0
  /** ~1ms/char + 300ms fixed: the slowest rate consistent with the report (a 900-char
   *  message still committing at 800ms). */
  private commitMs = (n: number) => 300 + n

  feed(now: number, data: string) {
    this.settle(now)
    const paste = data.match(/^\x1b\[200~([\s\S]*)\x1b\[201~\r?$/)
    if (paste) {
      this.pending = paste[1]
      this.startedAt = now
      this.applyUntil = now + this.commitMs(this.pending.length)
      return
    }
    if (data === '\r') {
      if (now < this.applyUntil) {
        // Mid-apply: the CR submits WHAT HAS BEEN APPLIED SO FAR and leaves a newline
        // behind in the cleared composer — the empty first line in the screenshot.
        const frac = (now - this.startedAt) / (this.applyUntil - this.startedAt)
        const cut = Math.floor(this.pending.length * frac)
        this.turns.push(this.composer + this.pending.slice(0, cut))
        this.pending = this.pending.slice(cut)
        this.composer = '\n'
        return
      }
      if (this.composer) { this.turns.push(this.composer); this.composer = '' }
    }
  }

  /** Advance to `now`, applying any paste whose window has elapsed. */
  settle(now: number) {
    if (this.applyUntil && now >= this.applyUntil) {
      this.composer += this.pending
      this.pending = ''
      this.applyUntil = 0
      // The submit sequence's own trailing CR commits it once the apply lands.
      this.turns.push(this.composer)
      this.composer = ''
    }
  }
}

/** Run one dispatch of `n` chars through the queue into the TUI model. */
async function dispatch(n: number, nudgeMs?: number) {
  const clock = fakeClock()
  const tui = new FakeTui()
  const text = 'T'.repeat(n)
  const q = createSubmitQueue(
    { write: (_id, data) => tui.feed(clock.now(), data), ...clock },
    SUBMIT_GAP_MS,
    nudgeMs,
  )
  await q.submit('t1', text)
  tui.settle(clock.now() + SUBMIT_NUDGE_MAX_MS * 2) // let any in-flight apply land
  return { turns: tui.turns, composer: tui.composer, text }
}

describe('long-message dispatch (the reported P0)', () => {
  it('REPRODUCES the split with the old fixed 800ms nudge', async () => {
    // Pin the delay to the pre-fix constant by passing a floor and… no: the fix scales off
    // the floor, so reproduce by driving the model with a plain fixed-delay queue instead.
    const clock = fakeClock()
    const tui = new FakeTui()
    const text = 'T'.repeat(900)
    // The old behaviour, inlined: paste, then a bare CR at a FIXED 800ms.
    tui.feed(clock.now(), submitSequence(text))
    clock.advance(SUBMIT_NUDGE_MS)
    tui.feed(clock.now(), '\r')
    tui.settle(clock.now() + 10_000)

    // One dispatch became two pieces: a truncated turn…
    expect(tui.turns.length).toBe(2)
    expect(tui.turns[0].length).toBeGreaterThan(0)
    expect(tui.turns[0].length).toBeLessThan(text.length)
    // …and the tail, behind a newline — the empty first line in the screenshot.
    expect(tui.turns[1].startsWith('\n')).toBe(true)
    expect(tui.turns[0] + tui.turns[1].slice(1)).toBe(text)
  })

  it('delivers each length as exactly ONE whole turn with the scaled nudge', async () => {
    for (const n of [200, 500, 1000, 2000, 3000]) {
      const { turns, composer, text } = await dispatch(n)
      expect(turns, `${n} chars → ${turns.length} turn(s)`).toEqual([text])
      expect(composer, `${n} chars left a draft`).toBe('')
    }
  })
})

// --- stop vs. the pending nudge (dev/briefs/stop-vs-pending-nudge-race.md) ---------------
// Claude Code restores the draft into the composer when interrupted, so a watchdog CR that
// lands after the ESC re-submits that draft and the same work starts again. To the user that
// is "stop did nothing". The nudge must be disarmable, per terminal.
describe('cancelNudge', () => {
  /** A queue whose `sleep` fires `during` once, mid-wait — the only way to express "the user
   *  clicked stop while the nudge was armed" against a fake clock that resolves instantly. */
  const queueWithHook = (during?: (q: SubmitQueue) => void) => {
    let t = 0
    const writes: { at: number; id: string; data: string }[] = []
    let fired = false
    let q: SubmitQueue
    q = createSubmitQueue({
      write: (id, data) => writes.push({ at: t, id, data }),
      now: () => t,
      sleep: async (ms: number) => {
        t += ms
        if (during && !fired) { fired = true; during(q) }
      },
    })
    return { q, writes }
  }

  it('does NOT fire the watchdog CR when the terminal was interrupted mid-wait', async () => {
    for (const text of ['x'.repeat(80), 'x'.repeat(4000)]) { // both ends: 800ms … 6000ms
      const { q, writes } = queueWithHook((qq) => qq.cancelNudge('t1'))
      await q.submit('t1', text)
      expect(writes.map((w) => w.data), `${text.length} chars`).toEqual([submitSequence(text)])
    }
  })

  it('still fires it when nothing interrupted', async () => {
    const { q, writes } = queueWithHook()
    await q.submit('t1', 'x'.repeat(80))
    expect(writes.map((w) => w.data)).toEqual([submitSequence('x'.repeat(80)), '\r'])
  })

  it('is PER TERMINAL — stopping one lane must not disarm another', async () => {
    const { q, writes } = queueWithHook((qq) => qq.cancelNudge('t1'))
    await Promise.all([q.submit('t1', 'A'), q.submit('t2', 'B')])
    expect(writes.filter((w) => w.id === 't1').map((w) => w.data)).toEqual([submitSequence('A')])
    expect(writes.filter((w) => w.id === 't2').map((w) => w.data)).toEqual([submitSequence('B'), '\r'])
  })

  it('only disarms the nudge in flight — a LATER send is a new intent', async () => {
    const { q, writes } = queueWithHook((qq) => qq.cancelNudge('t1')) // fires once, on the first wait
    await q.submit('t1', 'A')
    await q.submit('t1', 'B')
    expect(writes.map((w) => w.data)).toEqual([submitSequence('A'), submitSequence('B'), '\r'])
  })
})
