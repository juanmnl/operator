import { describe, it, expect } from 'vitest'
import { createSubmitQueue, submitSequence, nudgeDelayFor, rescueDelayFor, SUBMIT_GAP_MS, SUBMIT_NUDGE_MS, SUBMIT_NUDGE_MAX_MS, RESCUE_AFTER_MS, CONFIRM_POLL_MS, CONFIRM_WINDOW_MS, type SubmitQueue } from './submit-queue'

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

    q.observable('t1')
    await q.submit('t1', 'A')

    // The stranded-draft rescue: paste+CR, then a lone CR once we KNOW no turn started —
    // submits a draft whose original CR was swallowed, no-op otherwise.
    expect(writes.map((w) => w.data)).toEqual([submitSequence('A'), '\r'])
    // It now waits the RESCUE horizon, not a guess at commit time. Nothing confirms in this
    // test, so this is the degraded path: no observation available, so we wait a long time and
    // then guess — which is strictly the old behaviour, moved to where it can't corrupt.
    expect(writes[1].at - writes[0].at).toBe(rescueDelayFor('A'))
    expect(writes[1].at - writes[0].at).toBeGreaterThanOrEqual(RESCUE_AFTER_MS)
  })

  it('waits LONGER before nudging a long message', async () => {
    const clock = fakeClock()
    const writes: { at: number; data: string }[] = []
    const q = createSubmitQueue({ write: (_id, data) => writes.push({ at: clock.now(), data }), ...clock })

    q.observable('t1')
    await q.submit('t1', 'x'.repeat(2000))

    const delay = writes[1].at - writes[0].at
    expect(delay).toBe(rescueDelayFor('x'.repeat(2000)))
    // The length term survives as GRACE on top of the horizon, not as the model: it was never
    // wrong, it was just never the dominant term (load is).
    expect(delay).toBeGreaterThanOrEqual(RESCUE_AFTER_MS)
    expect(nudgeDelayFor('x'.repeat(2000))).toBeGreaterThan(SUBMIT_NUDGE_MS)
    expect(nudgeDelayFor('x'.repeat(2000))).toBeLessThanOrEqual(SUBMIT_NUDGE_MAX_MS)
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

    q.observable('t1')
    await q.submit('t1', 'A')
    clock.advance(SUBMIT_GAP_MS * 3) // idle period
    await q.submit('t1', 'B')

    const subs = pastes(writes)
    // B goes out as soon as it's queued — the idle period already exceeds the gap.
    // (A waited out the full rescue horizon first: nothing confirmed it.)
    expect(subs[1].at).toBe(rescueDelayFor('A') + SUBMIT_GAP_MS * 3)
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
  /** ~1ms/char + 300ms fixed: the slowest rate consistent with the FIRST report (a 900-char
   *  message still committing at 800ms).
   *
   *  Overridable, because that model was falsified. The second report split a 203-char message
   *  on a machine running 25 `claude` processes at load 4.0, where `nudgeDelayFor` allowed
   *  1104ms — so commit time is dominated by CPU contention, not by message length, and a
   *  length-only model cannot express today's failure at all. See `slowTui` below. */
  commitMs: (n: number) => number = (n: number) => 300 + n

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

// --- the closed loop (dispatch-split-closed-loop) ----------------------------------------
// Everything above tunes a TIMER, and a timer can only ever estimate the TUI's pace: too early
// splits a long paste, too late strands it. `confirm()` replaces the estimate with an
// observation — the transcript recorded a user turn — so the rescue CR fires only when the
// submission demonstrably did NOT land, and a submission that lands nowhere gets reported
// instead of disappearing.
describe('delivery confirmation', () => {
  /** A queue whose `sleep` can run a hook on the Nth wait — "the confirmation arrived while the
   *  watchdog was armed", against a fake clock that resolves instantly. */
  const queueWithHook = (opts: {
    /** Run once, on the first wait — "the confirmation arrived while the watchdog was armed". */
    on?: Record<number, (q: SubmitQueue) => void>
    /** Run once, the first time virtual time passes this mark. Keyed on TIME rather than on the
     *  wait count, because the wait is now a poll loop: "wait 2" used to mean the confirmation
     *  window and now means 250ms in. */
    after?: [number, (q: SubmitQueue) => void]
    onUndelivered?: (id: string, text: string) => void
  } = {}) => {
    let t = 0
    let waits = 0
    let fired = false
    const writes: { at: number; id: string; data: string }[] = []
    let q: SubmitQueue
    q = createSubmitQueue({
      write: (id, data) => writes.push({ at: t, id, data }),
      now: () => t,
      sleep: async (ms: number) => {
        t += ms
        waits += 1
        opts.on?.[waits]?.(q)
        if (opts.after && !fired && t >= opts.after[0]) { fired = true; opts.after[1](q) }
      },
      onUndelivered: opts.onUndelivered,
    })
    return { q, writes }
  }

  it('SKIPS the rescue CR when the turn was confirmed', async () => {
    // The CR is a keystroke, and a keystroke against an already-committed paste is what split
    // long dispatches. Confirmed means there is nothing left to rescue.
    const { q, writes } = queueWithHook({ on: { 1: (qq) => qq.confirm('t1') } })
    await q.submit('t1', 'x'.repeat(900))
    expect(writes.map((w) => w.data)).toEqual([submitSequence('x'.repeat(900))])
  })

  it('still fires it when nothing confirmed — the stranded-draft rescue is intact', async () => {
    const { q, writes } = queueWithHook()
    await q.submit('t1', 'A')
    expect(writes.map((w) => w.data)).toEqual([submitSequence('A'), '\r'])
  })

  it('ignores a confirmation from BEFORE the submission', async () => {
    // A dispatch routinely goes to a lane that is already running, whose transcript is already
    // producing turns. Counting one of those would confirm a message still in the composer.
    const { q, writes } = queueWithHook()
    q.confirm('t1')
    q.confirm('t1')
    await q.submit('t1', 'A')
    expect(writes.map((w) => w.data)).toEqual([submitSequence('A'), '\r'])
  })

  it('reports a submission that never became a turn', async () => {
    const lost: Array<[string, string]> = []
    const { q, writes } = queueWithHook({ onUndelivered: (id, text) => lost.push([id, text]) })
    await q.submit('t1', 'do the thing')
    await q.idle()
    // Rescue CR went out, the window passed, still nothing.
    expect(writes.map((w) => w.data)).toEqual([submitSequence('do the thing'), '\r'])
    expect(lost).toEqual([['t1', 'do the thing']])
  })

  it('says nothing when the RESCUE worked — confirmed after the CR', async () => {
    const lost: string[] = []
    // Nothing confirms before the horizon, so the rescue CR fires; the confirmation lands
    // during the window that follows it — the rescue worked, so there is nothing to report.
    const { q, writes } = queueWithHook({
      after: [RESCUE_AFTER_MS + 1, (qq) => qq.confirm('t1')],
      onUndelivered: (_id, text) => lost.push(text),
    })
    q.observable('t1')
    await q.submit('t1', 'A')
    await q.idle()
    expect(writes.map((w) => w.data)).toEqual([submitSequence('A'), '\r'])
    expect(lost).toEqual([])
  })

  it('says nothing when the user interrupted — stop is deliberate, not a failure', async () => {
    const lost: string[] = []
    const { q } = queueWithHook({
      on: { 1: (qq) => qq.cancelNudge('t1') },
      onUndelivered: (_id, text) => lost.push(text),
    })
    await q.submit('t1', 'A')
    await q.idle()
    expect(lost).toEqual([])
  })

  it('never sends a SECOND rescue CR — each keystroke is another chance to split', async () => {
    const { q, writes } = queueWithHook({ onUndelivered: () => {} })
    await q.submit('t1', 'A')
    expect(writes.filter((w) => w.data === '\r').length).toBe(1)
  })

  it('exposes what a terminal is awaiting, and clears it once settled', async () => {
    const seen: Array<{ text: string; at: number } | undefined> = []
    const { q } = queueWithHook({ on: { 1: (qq) => seen.push(qq.pending('t1')) } })
    expect(q.pending('t1')).toBeUndefined() // nothing sent yet
    await q.submit('t1', 'the task')
    expect(seen[0]?.text).toBe('the task') // in flight, with its write time
    expect(q.pending('t1')).toBeUndefined() // settled — a stale entry would confirm a dead window
  })

  it('clears what it is awaiting when the turn confirms, and when stop fires', async () => {
    for (const act of ['confirm', 'cancelNudge'] as const) {
      const { q } = queueWithHook({ on: { 1: (qq) => qq[act]('t1') } })
      await q.submit('t1', 'A')
      expect(q.pending('t1'), act).toBeUndefined()
    }
  })

  it('is PER TERMINAL — confirming one lane must not silence another', async () => {
    const lost: string[] = []
    const { q, writes } = queueWithHook({
      on: { 1: (qq) => qq.confirm('t1') },
      onUndelivered: (id) => lost.push(id),
    })
    await Promise.all([q.submit('t1', 'A'), q.submit('t2', 'B')])
    await q.idle()
    expect(writes.filter((w) => w.id === 't1').map((w) => w.data)).toEqual([submitSequence('A')])
    expect(writes.filter((w) => w.id === 't2').map((w) => w.data)).toEqual([submitSequence('B'), '\r'])
    expect(lost).toEqual(['t2'])
  })

  it('a CONFIRMED burst moves at the speed of the lane, not of any timer', async () => {
    // What the queue is FOR, restated under the closed loop. A confirmed message releases the
    // chain immediately, so a burst is spaced by how fast the lane actually commits — which is
    // both faster than the old fixed gap and a stronger guarantee against the merge bug, since
    // message 2 cannot be pasted until message 1 demonstrably landed.
    let t = 0
    const writes: { at: number; data: string }[] = []
    let q: SubmitQueue
    q = createSubmitQueue({
      write: (_id, data) => { writes.push({ at: t, data }); if (data.startsWith('\x1b[200~')) commitAt = t + 400 },
      now: () => t,
      sleep: async (ms: number) => { t += ms; if (commitAt && t >= commitAt) { commitAt = 0; q.confirm('t1') } },
      onUndelivered: () => {},
    })
    q.observable('t1')
    let commitAt = 0

    await Promise.all([q.submit('t1', 'A'), q.submit('t1', 'B')])
    await q.idle()
    const subs = pastes(writes)
    expect(subs.length).toBe(2)
    // Nowhere near the rescue horizon: confirmation, not a deadline, is what advanced the queue.
    expect(subs[1].at - subs[0].at).toBeLessThan(RESCUE_AFTER_MS)
    // …and no rescue CR was needed for either.
    expect(writes.filter((w) => w.data === '\r')).toEqual([])
  })

  it('the DETACHED report never delays the next submission', async () => {
    // The regression dev/drive-dispatch.mjs's sweep caught: awaiting the verdict inside the chain
    // made every submission own its lane for CONFIRM_WINDOW_MS on top of everything else.
    const clock = fakeClock()
    const writes: { at: number; data: string }[] = []
    const q = createSubmitQueue({
      write: (_id, data) => writes.push({ at: clock.now(), data }),
      ...clock,
      onUndelivered: () => {},
    })

    await Promise.all([q.submit('t1', 'A'), q.submit('t1', 'B')])
    const subs = pastes(writes)
    // A's rescue horizon and the gap, and NOT the confirmation window stacked on top.
    expect(subs[1].at - subs[0].at).toBeLessThan(rescueDelayFor('A') + SUBMIT_GAP_MS + CONFIRM_WINDOW_MS)
    await q.idle()
  })

  it('END TO END: wired to the transcript, a long dispatch lands as one turn and needs no CR', async () => {
    // The same TUI model as the reproduction above, with the loop closed: every turn the model
    // records is fed back as a confirmation, exactly as DashboardView feeds session updates.
    const clock = fakeClock()
    const tui = new FakeTui()
    const text = 'T'.repeat(900)
    let q: SubmitQueue
    const lost: string[] = []
    q = createSubmitQueue({
      write: (_id, data) => tui.feed(clock.now(), data),
      now: clock.now,
      sleep: async (ms: number) => {
        clock.advance(ms)
        tui.settle(clock.now())            // the paste's own commit lands during the wait…
        if (tui.turns.length) q.confirm('t1') // …and the tailer sees the turn it produced
      },
      onUndelivered: (_id, t) => lost.push(t),
    })
    await q.submit('t1', text)
    await q.idle()
    expect(tui.turns).toEqual([text]) // ONE whole turn
    expect(tui.composer).toBe('')     // nothing stranded
    expect(lost).toEqual([])          // and nothing reported as lost
  })
})

// --- case 3: THE SPLIT UNDER LOAD (dev/briefs/dispatch-split-closed-loop.md) --------------
//
// The failure that falsified length scaling. A 203-char dispatch split on a machine running 25
// `claude` processes at load 4.01 — `nudgeDelayFor` allowed it 1104ms, and the TUI needed more,
// because a TUI competing for CPU commits slowly REGARDLESS of how short the paste is.
//
// The suite above could not express this: every model in it makes commit time a function of
// length, so a short message always looked safe. This one holds length constant and makes commit
// time long and length-INDEPENDENT, which is the shape of the real thing.
const REPORTED_LEN = 203      // the message that actually split
const SLOW_COMMIT_MS = 4_000  // a loaded machine; ~4× what the shipped model predicts

/** The TUI as it behaves under load: a fixed, length-independent commit cost. */
function slowTui(commitMs = SLOW_COMMIT_MS) {
  const tui = new FakeTui()
  tui.commitMs = () => commitMs
  return tui
}

describe('the split under LOAD — commit time independent of length', () => {
  it('REPRODUCES it with the shipped open-loop timer, at only 203 chars', async () => {
    const clock = fakeClock()
    const tui = slowTui()
    const text = 'T'.repeat(REPORTED_LEN)
    // Exactly what ships today: paste, then the length-scaled CR. No confirmation.
    tui.feed(clock.now(), submitSequence(text))
    clock.advance(nudgeDelayFor(text))
    tui.feed(clock.now(), '\r')
    tui.settle(clock.now() + 60_000)

    // The budget the current model grants this message, against what the machine needed.
    expect(nudgeDelayFor(text)).toBeLessThan(SLOW_COMMIT_MS)
    expect(nudgeDelayFor(text)).toBeLessThan(SUBMIT_NUDGE_MAX_MS) // nowhere near the cap
    // One dispatch, two pieces — the reported artifact, at a length the fix called safe.
    expect(tui.turns.length).toBe(2)
    expect(tui.turns[0].length).toBeLessThan(text.length)
    expect(tui.turns[1].startsWith('\n')).toBe(true)
    expect(tui.turns[0] + tui.turns[1].slice(1)).toBe(text)
  })

  it('the CLOSED LOOP delivers it whole — no CR is sent at all', async () => {
    const clock = fakeClock()
    const tui = slowTui()
    const text = 'T'.repeat(REPORTED_LEN)
    const writes: string[] = []
    const lost: string[] = []
    let q: SubmitQueue
    q = createSubmitQueue({
      write: (_id, data) => { writes.push(data); tui.feed(clock.now(), data) },
      now: clock.now,
      // The tailer, modelled: time passes, the paste eventually commits, and the turn it
      // produced is fed back as a confirmation.
      sleep: async (ms: number) => {
        clock.advance(ms)
        tui.settle(clock.now())
        if (tui.turns.length) q.confirm('t1')
      },
      onUndelivered: (_id, t) => lost.push(t),
    })
    q.observable('t1')
    await q.submit('t1', text)
    await q.idle()

    expect(tui.turns).toEqual([text])   // ONE whole turn…
    expect(tui.composer).toBe('')       // …nothing stranded…
    expect(writes).toEqual([submitSequence(text)]) // …and the CR that would have split it never went
    expect(lost).toEqual([])
  })

  it('survives commit times far past the nudge cap — no constant could have', async () => {
    // The point of the change: correctness stops depending on guessing the machine's speed.
    // Every one of these exceeds SUBMIT_NUDGE_MAX_MS, i.e. every one of them splits today.
    for (const commit of [2_000, 6_000, 15_000, 29_000]) {
      const clock = fakeClock()
      const tui = slowTui(commit)
      const text = 'T'.repeat(REPORTED_LEN)
      let q: SubmitQueue
      q = createSubmitQueue({
        write: (_id, data) => tui.feed(clock.now(), data),
        now: clock.now,
        sleep: async (ms: number) => {
          clock.advance(ms)
          tui.settle(clock.now())
          if (tui.turns.length) q.confirm('t1')
        },
      })
      q.observable('t1')
      await q.submit('t1', text)
      await q.idle()
      expect(tui.turns, `commit ${commit}ms`).toEqual([text])
      expect(tui.composer, `commit ${commit}ms left a draft`).toBe('')
    }
  })

  it('past the rescue horizon it DEGRADES to guessing — the honest limit of the design', async () => {
    // Worth pinning rather than hiding. With nothing ever confirming there is no way to tell a
    // slow commit from a swallowed CR, so at the horizon the rescue fires and can still land
    // mid-apply. This is only reachable when nobody is watching the transcript (an untracked
    // `local-` session); a watched lane confirms whenever it finally commits, however late.
    const clock = fakeClock()
    const tui = slowTui(RESCUE_AFTER_MS * 2)
    const text = 'T'.repeat(REPORTED_LEN)
    const q = createSubmitQueue({
      write: (_id, data) => tui.feed(clock.now(), data),
      ...clock, // no confirmations at all, and nothing watching: the degraded regime
    })
    await q.submit('t1', text)
    await q.idle()
    tui.settle(clock.now() + 120_000)
    expect(tui.turns.length).toBe(2) // split — and there is no constant that would have helped
  })

  it('a slow commit that NEVER arrives is reported, not silently lost', async () => {
    // The honest end of the loop. Nothing confirms, so the rescue CR fires once and the
    // submission is named — instead of a task sitting in a composer while the log says "sent".
    const clock = fakeClock()
    const lost: string[] = []
    const q = createSubmitQueue({
      write: () => {},
      ...clock,
      onUndelivered: (_id, t) => lost.push(t),
    })
    await q.submit('t1', 'T'.repeat(REPORTED_LEN))
    await q.idle()
    expect(lost.length).toBe(1)
  })

  it('and the MERGE bug stays fixed under the same slow commit', async () => {
    // Regression bar case 1. The two failures pull in opposite directions: everything that makes
    // the split safer (wait longer, send fewer CRs) is a chance to let a burst coalesce into one
    // draft again — which is the original bug the queue was built for.
    const clock = fakeClock()
    const tui = slowTui(1_200)
    let seen = 0 // the tailer confirms NEW turns only — a stale one would confirm the next
    let q: SubmitQueue // message before it committed, which is the merge bug wearing a disguise
    q = createSubmitQueue({
      write: (_id, data) => tui.feed(clock.now(), data),
      now: clock.now,
      sleep: async (ms: number) => {
        clock.advance(ms)
        tui.settle(clock.now())
        if (tui.turns.length > seen) { seen = tui.turns.length; q.confirm('t1') }
      },
    })
    q.observable('t1')
    await Promise.all([q.submit('t1', 'ALPHA'), q.submit('t1', 'BRAVO'), q.submit('t1', 'CIRCA')])
    await q.idle()
    tui.settle(clock.now() + 60_000)
    // Three separate turns — not one merged draft.
    expect(tui.turns).toEqual(['ALPHA', 'BRAVO', 'CIRCA'])
    expect(tui.composer).toBe('')
  })
})

// --- the two regimes ---------------------------------------------------------------------
describe('observable vs. unwatched terminals', () => {
  it('waits patiently only when a turn could actually be seen', () => {
    // The distinction that keeps the long horizon from becoming a stall: waiting 30s for an
    // observation nobody can make is half a minute of dead air per message.
    expect(rescueDelayFor('A', SUBMIT_NUDGE_MS, true)).toBe(RESCUE_AFTER_MS)
    expect(rescueDelayFor('A', SUBMIT_NUDGE_MS, false)).toBe(nudgeDelayFor('A'))
  })

  it('an UNWATCHED terminal behaves exactly as it does today — no better, no worse', async () => {
    const clock = fakeClock()
    const writes: { at: number; data: string }[] = []
    const q = createSubmitQueue({ write: (_id, data) => writes.push({ at: clock.now(), data }), ...clock })
    await q.submit('t1', 'A') // never marked observable
    expect(writes.map((w) => w.data)).toEqual([submitSequence('A'), '\r'])
    expect(writes[1].at - writes[0].at).toBe(nudgeDelayFor('A'))
  })

  it('a burst on an unwatched terminal is not stalled by the horizon', async () => {
    const clock = fakeClock()
    const writes: { at: number; data: string }[] = []
    const q = createSubmitQueue({ write: (_id, data) => writes.push({ at: clock.now(), data }), ...clock })
    await Promise.all([q.submit('t1', 'A'), q.submit('t1', 'B'), q.submit('t1', 'C')])
    const subs = pastes(writes)
    expect(subs.length).toBe(3)
    expect(subs[2].at).toBeLessThan(RESCUE_AFTER_MS) // all three out inside one horizon
  })

  it('is sticky and per terminal', async () => {
    const clock = fakeClock()
    const writes: { id: string; at: number; data: string }[] = []
    const q = createSubmitQueue({ write: (id, data) => writes.push({ id, at: clock.now(), data }), ...clock })
    q.observable('t1')
    await Promise.all([q.submit('t1', 'A'), q.submit('t2', 'B')])
    const cr = (id: string) => writes.find((w) => w.id === id && w.data === '\r')!
    const paste = (id: string) => writes.find((w) => w.id === id && w.data !== '\r')!
    expect(cr('t1').at - paste('t1').at).toBe(RESCUE_AFTER_MS) // watched → patient
    // Unwatched → today's timing. Bounded rather than exact: the two lanes share one virtual
    // clock here, so t1's 250ms poll steps round t2's wait up to the next tick.
    const t2 = cr('t2').at - paste('t2').at
    expect(t2).toBeGreaterThanOrEqual(nudgeDelayFor('B'))
    expect(t2).toBeLessThan(nudgeDelayFor('B') + CONFIRM_POLL_MS * 2)
  })
})
