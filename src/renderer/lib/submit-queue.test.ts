import { describe, it, expect } from 'vitest'
import { createSubmitQueue, submitSequence, nudgeDelayFor, rescueDelayFor, SUBMIT_GAP_MS, SUBMIT_NUDGE_MS, SUBMIT_NUDGE_MAX_MS, RESCUE_AFTER_MS, CONFIRM_POLL_MS, CONFIRM_WINDOW_MS, type SubmitQueue, clearComposerSequence, composerLines, MAX_CLEAR_LINES, DRAFT_POLL_MS } from './submit-queue'
import { noteDraftKey, hasUnsentInput, clearUnsentInput } from './lane-keystrokes'

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

  // Security audit 2026-10-01, H2: text that carries its own ESC[201~ would end the paste and
  // type the rest as keys. Exactly one start and one end marker may reach the pty.
  it('strips control characters from the text, so it cannot end the paste early', () => {
    const seq = submitSequence('ok\x1b[201~\x15!echo pwned > /tmp/p1\r')
    expect(seq).toBe('\x1b[200~ok[201~!echo pwned > /tmp/p1\n\x1b[201~\r')
    expect(seq.split('\x1b').length - 1).toBe(2)
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

// --- a human typing in the lane (rescue-cr-submits-user-typing) --------------------------
// The rescue CR is a keystroke into the SAME TUI composer the user types into, and it cannot
// tell a stranded dispatch from a person mid-sentence. On an observed terminal it is up to
// RESCUE_AFTER_MS away, so every dispatch used to open a 30-second window in which anything
// typed could be submitted half-written. Reported as "it sends my message with it, half baked".
describe('a keystroke disarms the rescue', () => {
  /** Like `queueWithHook` above, but with an undelivered sink — the report is half the fix. */
  const queueWithTyping = (during?: (q: SubmitQueue) => void) => {
    let t = 0
    const writes: { at: number; id: string; data: string }[] = []
    const undelivered: { id: string; text: string }[] = []
    let fired = false
    let q: SubmitQueue
    q = createSubmitQueue({
      write: (id, data) => writes.push({ at: t, id, data }),
      now: () => t,
      sleep: async (ms: number) => {
        t += ms
        if (during && !fired) { fired = true; during(q) }
      },
      onUndelivered: (id, text) => undelivered.push({ id, text }),
    })
    return { q, writes, undelivered }
  }

  it('does NOT fire the CR when the user typed during the wait', async () => {
    for (const text of ['x'.repeat(80), 'x'.repeat(4000)]) {
      const { q, writes } = queueWithTyping((qq) => qq.cancelNudge('t1', 'typing'))
      q.observable('t1')
      await q.submit('t1', text)
      await q.idle()
      expect(writes.filter((w) => w.id === 't1').map((w) => w.data), `${text.length} chars`)
        .toEqual([submitSequence(text)])
    }
  })

  it('REPORTS the disarmed dispatch instead of dropping it silently', async () => {
    const { q, undelivered } = queueWithTyping((qq) => qq.cancelNudge('t1', 'typing'))
    q.observable('t1')
    await q.submit('t1', 'do the thing')
    await q.idle()
    // Suppressing the CR may leave the dispatch as a draft forever. Silence would read as
    // delivered — the one thing the closed loop exists to stop.
    expect(undelivered).toEqual([{ id: 't1', text: 'do the thing' }])
  })

  it('stays SILENT when the disarm was a deliberate interrupt', async () => {
    const { q, undelivered } = queueWithTyping((qq) => qq.cancelNudge('t1'))
    q.observable('t1')
    await q.submit('t1', 'do the thing')
    await q.idle()
    expect(undelivered).toEqual([])
  })

  it('does not report a typing-disarmed message that committed anyway', async () => {
    // The paste can land on its own a moment after the keystroke. The entry stays in
    // `awaiting` precisely so the transcript watcher can still confirm it — a false
    // "undelivered" on a message the agent actually received is its own bug.
    const { q, undelivered } = queueWithTyping((qq) => { qq.cancelNudge('t1', 'typing'); qq.confirm('t1') })
    q.observable('t1')
    await q.submit('t1', 'do the thing')
    await q.idle()
    expect(undelivered).toEqual([])
  })

  it('is PER TERMINAL — typing in lane A must not disarm lane B', async () => {
    const { q, writes } = queueWithTyping((qq) => qq.cancelNudge('t1', 'typing'))
    await Promise.all([q.submit('t1', 'A'), q.submit('t2', 'B')])
    await q.idle()
    expect(writes.filter((w) => w.id === 't1').map((w) => w.data)).toEqual([submitSequence('A')])
    expect(writes.filter((w) => w.id === 't2').map((w) => w.data)).toEqual([submitSequence('B'), '\r'])
  })

  it('leaves nothing armed to disarm once the turn is confirmed', async () => {
    // `pending` is what the keystroke handler checks before doing any work, so it is also the
    // guarantee that typing into a settled lane costs one Map lookup and nothing else.
    const clock = fakeClock()
    const q = createSubmitQueue({ write: () => {}, ...clock })
    q.observable('t1')
    const sent = q.submit('t1', 'A')
    q.confirm('t1')
    await sent
    expect(q.pending('t1')).toBeUndefined()
  })
})

// --- a BUSY lane is not a lost message (2026-08-06-false-undelivered-toasts) -------------
// The verdict used to be taken 34s after the write, whether or not the lane was in a position
// to answer. Claude Code queues text that arrives mid-turn, so a lane working for longer than
// that produced no turn inside the window and a perfectly good dispatch was declared lost —
// five stacked "never started the task it was sent" toasts, from the two lanes that are always
// mid-turn. Measured on the real transcripts: 52 of 62 such reports were messages the lane had
// already accepted into its queue.
describe('a lane that is still working', () => {
  /** A queue with a virtual clock, an undelivered sink that records WHEN it fired, and a hook
   *  that runs once as time passes a mark — "the lane finished, and here is what it had". */
  const busyQueue = (opts: { at?: number; then?: (q: SubmitQueue) => void } = {}) => {
    let t = 0
    let fired = false
    const lost: { at: number; text: string }[] = []
    let q: SubmitQueue
    q = createSubmitQueue({
      write: () => {},
      now: () => t,
      sleep: async (ms: number) => {
        t += ms
        if (opts.at !== undefined && !fired && t >= opts.at) { fired = true; opts.then?.(q) }
      },
      onUndelivered: (_id, text) => lost.push({ at: t, text }),
    })
    return { q, lost, now: () => t }
  }

  it('says NOTHING about a message it queued, however late the confirmation is', async () => {
    // The transcript records the enqueue on arrival, but a loaded tailer can be slow and the
    // old window was 4s wide. Confirmation here lands eight minutes in.
    const LATE = RESCUE_AFTER_MS + 8 * 60_000
    const { q, lost } = busyQueue({ at: LATE, then: (qq) => { qq.confirm('t1'); qq.busy('t1', false) } })
    q.observable('t1')
    q.busy('t1', true)
    await q.submit('t1', 'do the thing')
    await q.idle()
    expect(lost).toEqual([])
  })

  it('REPORTS it once the lane goes idle with nothing to show for it', async () => {
    // The other direction, and the reason this is not just a longer timeout: a lane that
    // stopped working without the message ever appearing really has lost it.
    const IDLE_AT = RESCUE_AFTER_MS + 60_000
    const { q, lost } = busyQueue({ at: IDLE_AT, then: (qq) => qq.busy('t1', false) })
    q.observable('t1')
    q.busy('t1', true)
    await q.submit('t1', 'do the thing')
    await q.idle()
    expect(lost.map((l) => l.text)).toEqual(['do the thing'])
    // …and not before it went idle. This is what the old code got wrong.
    expect(lost[0].at).toBeGreaterThanOrEqual(IDLE_AT)
  })

  it('reports a DEAD terminal without waiting: nothing is working, so nothing is coming', async () => {
    // The true positive the report must keep — a write into a pty the lane reaper already
    // closed. Its session is `ended`, so it is never marked busy and the verdict is prompt.
    const { q, lost } = busyQueue()
    q.observable('t1')
    q.busy('t1', false)
    await q.submit('t1', 'do the thing')
    await q.idle()
    expect(lost.map((l) => l.text)).toEqual(['do the thing'])
    expect(lost[0].at).toBeLessThanOrEqual(RESCUE_AFTER_MS + CONFIRM_WINDOW_MS)
  })

  it('is PER TERMINAL — a working lane must not silence a dead one', async () => {
    const { q, lost } = busyQueue()
    q.observable('t1')
    q.observable('t2')
    q.busy('t1', true)
    await Promise.all([q.submit('t1', 'A'), q.submit('t2', 'B')])
    q.confirm('t1') // t1's queue entry showed up; t2 has nothing at all
    await q.idle()
    expect(lost.map((l) => l.text)).toEqual(['B'])
  })
})

// THE COMPOSER CLEAR. These bytes go into a LIVE agent's pty, so the properties that matter are
// as much about what they CANNOT do as what they do.
describe('clearComposerSequence', () => {
  it('clears one line: to the end, then kill to the start', () => {
    expect(clearComposerSequence(1)).toBe('\x05\x15')
  })

  it('walks a multi-line paste upward, joining each line to the one above', () => {
    // per extra line: backspace at column 0 joins, then end + kill empties the joined line
    expect(clearComposerSequence(3)).toBe('\x05\x15' + '\x7f\x05\x15' + '\x7f\x05\x15')
    expect(composerLines('a\nb\nc')).toBe(3)
  })

  it('contains NOTHING that submits, interrupts or exits — the property that lets it ship', () => {
    const seq = clearComposerSequence(10)
    expect(seq).not.toContain('\r')     // would submit
    expect(seq).not.toContain('\n')     // would submit
    expect(seq).not.toContain('\x1b')   // Esc — interrupts a running turn
    expect(seq).not.toContain('\x03')   // Ctrl+C — twice exits the lane
    expect(seq).not.toContain('\x04')   // Ctrl+D — exits on an empty line
    // …and only the three intended bytes appear at all.
    expect(new Set(seq.split(''))).toEqual(new Set(['\x05', '\x15', '\x7f']))
  })

  it('is bounded — a wrong line count cannot flood a live pty', () => {
    expect(clearComposerSequence(1e6).length).toBe(clearComposerSequence(MAX_CLEAR_LINES).length)
    // …and degenerate inputs still produce a valid, minimal sequence.
    expect(clearComposerSequence(0)).toBe('\x05\x15')
    expect(clearComposerSequence(-3)).toBe('\x05\x15')
  })

  it('composerLines counts what was pasted, including a trailing newline', () => {
    expect(composerLines('one')).toBe(1)
    expect(composerLines('one\ntwo')).toBe(2)
    expect(composerLines('one\n')).toBe(2)
  })
})

// Blocker/medium 5: the toolbar's `/model` and `/effort` writes used to go straight to
// `terminalWrite`, so a chip pressed while a dispatch paste was in flight could interleave a bare
// CR into it — which submits the half-pasted prompt.
describe('submitTyped — a slash command, in the same chain as a paste', () => {
  it('writes a TYPED line, never the bracketed-paste sequence', async () => {
    const writes: Array<[string, string]> = []
    const q = createSubmitQueue({ write: (id, d) => writes.push([id, d]), onUndelivered: () => {} })
    await q.submitTyped('t1', '/effort high')
    expect(writes).toEqual([['t1', '/effort high\r']])
    expect(writes[0][1]).not.toContain('\x1b[200~')
  })

  it('adds EXACTLY ONE terminator — the caller passes a line, not a submission', async () => {
    // This assertion is the one that was wrong. It previously asserted `/effort high\r\r`,
    // encoding the doubled CR as expected output, so a green suite hid a bare Return going into
    // a live lane after every chip press. QA-2 caught it; the lesson is that a test written from
    // observed output asserts the bug.
    const writes: string[] = []
    const q = createSubmitQueue({ write: (_id, d) => writes.push(d), onUndelivered: () => {} })
    await q.submitTyped('t1', '/model opus')
    expect(writes[0].match(/\r/g)).toHaveLength(1)
  })

  it('SERIALIZES with a paste on the same terminal, so a CR cannot land mid-paste', async () => {
    const writes: string[] = []
    const q = createSubmitQueue({ write: (_id, d) => writes.push(d), onUndelivered: () => {} })
    const a = q.submit('t1', 'a long dispatch')
    const b = q.submitTyped('t1', '/model opus')
    await Promise.all([a, b])
    // The paste is written WHOLE before the typed line begins — which is the property that
    // matters. (A rescue CR from the paste's own watchdog may sit between them; that belongs to
    // the paste, and it is precisely what must not land *inside* it.)
    const paste = writes.findIndex((w) => w.includes('\x1b[200~'))
    const typed = writes.findIndex((w) => w.startsWith('/model opus'))
    expect(paste).toBeGreaterThanOrEqual(0)
    expect(typed).toBeGreaterThan(paste)
    expect(writes[paste]).toBe('\x1b[200~a long dispatch\x1b[201~\r')
  })

  it('does not serialize across DIFFERENT terminals — one lane must not block another', async () => {
    const writes: string[] = []
    const q = createSubmitQueue({ write: (id) => writes.push(id), onUndelivered: () => {} })
    await Promise.all([q.submitTyped('t1', '/x'), q.submitTyped('t2', '/y')])
    expect(writes.sort()).toEqual(['t1', 't2'])
  })
})

describe('attachImages — a note screenshot goes out with its note', () => {
  it('pastes the image paths with no Return, in order, before the text that submits them', async () => {
    const clock = fakeClock()
    const writes: { id: string; data: string }[] = []
    const q = createSubmitQueue({ write: (id, data) => writes.push({ id, data }), ...clock })
    await Promise.all([
      q.submit('t1', 'earlier message'),
      q.attachImages('t1', ['/s/a.png', '/s/b.png']),
      q.submit('t1', 'note text'),
    ])
    const data = pastes(writes).map((w) => w.data)
    const img = data.indexOf('\x1b[200~/s/a.png /s/b.png\x1b[201~')
    expect(img).toBeGreaterThan(data.indexOf(submitSequence('earlier message')))
    expect(img).toBeLessThan(data.indexOf(submitSequence('note text')))
    expect(data[img].endsWith('\r')).toBe(false)
  })

  it('strips control characters from the paths (H2)', async () => {
    const clock = fakeClock()
    const writes: string[] = []
    const q = createSubmitQueue({ write: (_id, data) => writes.push(data), ...clock })
    await q.attachImages('t1', ['/s/a.png\x1b[201~\r!rm -rf ~\r'])
    expect(writes).toEqual(['\x1b[200~/s/a.png[201~\n!rm -rf ~\n\x1b[201~'])
  })

  it('writes nothing for an empty list', async () => {
    const clock = fakeClock()
    const writes: string[] = []
    const q = createSubmitQueue({ write: (_id, data) => writes.push(data), ...clock })
    await q.attachImages('t1', [])
    expect(writes).toEqual([])
  })
})

// H1 (review 2026-09-27): work typed into a lane that released its worktree cancels the release.
// The hook runs at ENQUEUE, before the write, so a lane is never retired in the gap between being
// handed work and its transcript showing the turn.
describe('onSubmit', () => {
  it('announces every submission at enqueue time, before anything is written', async () => {
    const clock = fakeClock()
    const seen: Array<{ id: string; text: string; writesBefore: number }> = []
    const writes: string[] = []
    const q = createSubmitQueue({
      write: (_id, data) => writes.push(data), ...clock,
      // The TEXT too, so the listener can tell work from a reply or a notice (R2-3).
      onSubmit: (id, text) => seen.push({ id, text, writesBefore: writes.length }),
    })
    const done = q.submit('t1', 'A')
    expect(seen).toEqual([{ id: 't1', text: 'A', writesBefore: 0 }])
    await done
    await q.submit('t2', 'B')
    expect(seen.map((s) => s.id)).toEqual(['t1', 't2'])
  })

  it('a throwing listener never blocks the submission', async () => {
    const clock = fakeClock()
    const writes: string[] = []
    const q = createSubmitQueue({ write: (_id, data) => writes.push(data), ...clock, onSubmit: () => { throw new Error('x') } })
    await q.submit('t1', 'A')
    expect(pastes(writes.map((data) => ({ data })))).toHaveLength(1)
  })
})

describe('divert — a lane whose pty is being ended in place (idle suspend, review N1)', () => {
  it('hands a submission queued before the divert, and not written yet, to the new owner', async () => {
    const clock = fakeClock()
    const writes: string[] = []
    const q = createSubmitQueue({ write: (_id, data) => writes.push(data), ...clock })
    await q.submit('t1', 'A')
    const handed: string[] = []
    // B is queued while the lane is still live; the suspend commits before its write.
    const b = q.submit('t1', 'B')
    q.divert('t1', (text) => handed.push(text))
    await b
    expect(pastes(writes.map((data) => ({ data }))).map((w) => w.data)).toEqual([submitSequence('A')])
    expect(handed).toEqual(['B'])
    // Nothing is awaited on the old pty, so nothing is reported lost there.
    expect(q.pending('t1')).toBeUndefined()
  })

  it('hands over every later submission in order, and only for that terminal', async () => {
    const clock = fakeClock()
    const writes: { id: string; data: string }[] = []
    const q = createSubmitQueue({ write: (id, data) => writes.push({ id, data }), ...clock })
    const handed: string[] = []
    q.divert('t1', (text) => handed.push(text))
    await Promise.all([q.submit('t1', 'one'), q.submit('t2', 'other'), q.submit('t1', 'two')])
    expect(handed).toEqual(['one', 'two'])
    expect(pastes(writes).map((w) => [w.id, w.data])).toEqual([['t2', submitSequence('other')]])
  })

  it('writes again once the divert ends (the kill failed and the lane is live)', async () => {
    const clock = fakeClock()
    const writes: string[] = []
    const q = createSubmitQueue({ write: (_id, data) => writes.push(data), ...clock })
    q.divert('t1', () => {})
    q.divert('t1', undefined)
    await q.submit('t1', 'A')
    expect(writes[0]).toBe(submitSequence('A'))
  })
})

describe('draft — text a person typed, into the composer, unsent (idle suspend, review N3)', () => {
  it('pastes with no Return and lands after a submission already queued for the lane', async () => {
    const clock = fakeClock()
    const writes: string[] = []
    const q = createSubmitQueue({ write: (_id, data) => writes.push(data), ...clock })
    const sub = q.submit('t1', 'the dispatch')
    const draft = q.draft('t1', 'my note')
    await Promise.all([sub, draft])
    const at = writes.indexOf('\x1b[200~my note\x1b[201~')
    expect(at).toBeGreaterThan(writes.indexOf(submitSequence('the dispatch')))
    // The dispatch's whole submission, rescue CR included, is done before the person's text goes in.
    expect(writes.slice(at + 1)).toEqual([])
  })

  it('strips control characters, so the text cannot end the paste or submit itself', async () => {
    const writes: string[] = []
    const q = createSubmitQueue({ write: (_id, data) => writes.push(data), ...fakeClock() })
    await q.draft('t1', 'a\x1b[201~\rb')
    expect(writes).toEqual(['\x1b[200~a[201~\nb\x1b[201~'])
  })
})

/** A clock that also runs scheduled events as virtual time passes: how a test makes the person
 *  press Enter at t=5000 while the queue is polling. Throws past an hour so a hold that never
 *  ends fails the test instead of spinning. */
function eventClock() {
  let t = 0
  const events: { at: number; run: () => void }[] = []
  const fire = () => {
    for (const e of events.filter((x) => x.at <= t)) { events.splice(events.indexOf(e), 1); e.run() }
  }
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms
      if (t > 3_600_000) throw new Error('held forever')
      fire()
    },
    at: (when: number, run: () => void) => { events.push({ at: when, run }) },
  }
}

describe('held on a person\'s draft (2026-10-24: a delivery merged into half-typed text)', () => {
  /** A queue whose draft flag the test sets, per terminal. */
  function setup() {
    const clock = eventClock()
    const writes: { at: number; id: string; data: string }[] = []
    const drafts = new Set<string>()
    const cleared: string[] = []
    const q = createSubmitQueue({
      write: (id, data) => writes.push({ at: clock.now(), id, data }),
      now: clock.now, sleep: clock.sleep,
      hasUnsentInput: (id) => drafts.has(id),
      clearUnsentInput: (id) => { cleared.push(id); drafts.delete(id) },
    })
    return { clock, writes, drafts, cleared, q }
  }

  it('writes nothing while the draft is there, and counts the message as owed to the lane', async () => {
    const { clock, writes, drafts, q } = setup()
    drafts.add('t1')
    const seen: { held: number; unwritten: number; pending: boolean; writes: number }[] = []
    clock.at(2000, () => seen.push({ held: q.heldForDraft('t1'), unwritten: q.unwritten('t1'), pending: !!q.pending('t1'), writes: writes.length }))
    clock.at(5000, () => drafts.delete('t1'))
    await q.submit('t1', 'A')
    expect(seen).toEqual([{ held: 1, unwritten: 1, pending: false, writes: 0 }])
    expect(writes[0].data).toBe(submitSequence('A'))
    // The gap runs from the moment the draft went, not from the enqueue.
    expect(writes[0].at).toBeGreaterThanOrEqual(5000 + SUBMIT_GAP_MS)
    expect(q.unwritten('t1')).toBe(0)
    expect(q.heldForDraft('t1')).toBe(0)
  })

  it('does not hold a lane with no draft', async () => {
    const { writes, q } = setup()
    await q.submit('t1', 'A')
    expect(writes[0]).toMatchObject({ at: 0, data: submitSequence('A') })
  })

  it('releases on Enter, read from the real key tracking', async () => {
    const clock = eventClock()
    const writes: { at: number; data: string }[] = []
    const q = createSubmitQueue({ write: (_id, data) => writes.push({ at: clock.now(), data }), now: clock.now, sleep: clock.sleep, hasUnsentInput })
    noteDraftKey('hold-enter', { key: 'P' })
    clock.at(3000, () => noteDraftKey('hold-enter', { key: 'Enter' }))
    await q.submit('hold-enter', 'A')
    expect(writes[0].at).toBeGreaterThanOrEqual(3000 + SUBMIT_GAP_MS)
    expect(writes[0].at).toBeLessThan(3000 + DRAFT_POLL_MS + SUBMIT_GAP_MS + 1)
  })

  it('releases on Ctrl+C', async () => {
    const clock = eventClock()
    const writes: { at: number; data: string }[] = []
    const q = createSubmitQueue({ write: (_id, data) => writes.push({ at: clock.now(), data }), now: clock.now, sleep: clock.sleep, hasUnsentInput })
    noteDraftKey('hold-ctrlc', { key: 'x' })
    // Shift+Enter is a newline inside the draft, not a send.
    clock.at(1000, () => noteDraftKey('hold-ctrlc', { key: 'Enter', shiftKey: true }))
    clock.at(4000, () => noteDraftKey('hold-ctrlc', { key: 'c', ctrlKey: true }))
    await q.submit('hold-ctrlc', 'A')
    expect(writes[0].at).toBeGreaterThanOrEqual(4000 + SUBMIT_GAP_MS)
  })

  it('releases when the lane ends and its flag is cleared, so a dead id holds nothing', async () => {
    const clock = eventClock()
    const writes: { at: number; data: string }[] = []
    const q = createSubmitQueue({ write: (_id, data) => writes.push({ at: clock.now(), data }), now: clock.now, sleep: clock.sleep, hasUnsentInput })
    noteDraftKey('hold-exit', { key: 'x' })
    clock.at(2000, () => clearUnsentInput('hold-exit'))
    await q.submit('hold-exit', 'A')
    expect(writes[0].at).toBeGreaterThanOrEqual(2000)
  })

  it('holds the whole burst, then writes it in order with the gap between each', async () => {
    const { clock, writes, drafts, q } = setup()
    drafts.add('t1')
    clock.at(1000, () => expect(q.heldForDraft('t1')).toBe(3))
    clock.at(4000, () => drafts.delete('t1'))
    await Promise.all([q.submit('t1', 'A'), q.submit('t2', 'other lane'), q.submit('t1', 'B'), q.submit('t1', 'C')])
    // Another lane is not held by this lane's draft: written long before it clears. (The clock
    // is shared, so t1's polls move it; the order is what matters.)
    expect(pastes(writes).find((w) => w.id === 't2')!.at).toBeLessThan(4000)
    const subs = pastes(writes).filter((w) => w.id === 't1')
    expect(subs.map((w) => w.data)).toEqual([submitSequence('A'), submitSequence('B'), submitSequence('C')])
    expect(subs[0].at).toBeGreaterThanOrEqual(4000 + SUBMIT_GAP_MS)
    expect(subs[1].at - subs[0].at).toBeGreaterThanOrEqual(SUBMIT_GAP_MS)
    expect(subs[2].at - subs[1].at).toBeGreaterThanOrEqual(SUBMIT_GAP_MS)
  })

  it('holds again when typing starts during the gap after a release', async () => {
    const { clock, writes, drafts, q } = setup()
    drafts.add('t1')
    clock.at(1000, () => drafts.delete('t1'))
    clock.at(1100, () => drafts.add('t1'))
    clock.at(6000, () => drafts.delete('t1'))
    await q.submit('t1', 'A')
    expect(writes[0].at).toBeGreaterThanOrEqual(6000 + SUBMIT_GAP_MS)
  })

  it('deliverNow sends the head into the draft and clears the flag; the next goes once no draft is left', async () => {
    const { clock, writes, drafts, cleared, q } = setup()
    drafts.add('t1')
    clock.at(2000, () => q.deliverNow('t1'))
    await Promise.all([q.submit('t1', 'A'), q.submit('t1', 'B')])
    const subs = pastes(writes)
    expect(subs.map((w) => w.data)).toEqual([submitSequence('A'), submitSequence('B')])
    expect(subs[0].at).toBeGreaterThanOrEqual(2000)
    // The first one's CR sent the draft with it, so the flag goes and B is not held on it.
    expect(cleared).toEqual(['t1'])
    expect(subs[1].at - subs[0].at).toBeLessThan(RESCUE_AFTER_MS)
  })

  it('deliverNow does not release a message enqueued after it', async () => {
    const { clock, writes, drafts, q } = setup()
    drafts.add('t1')
    q.deliverNow('t1')
    clock.at(3000, () => drafts.delete('t1'))
    await q.submit('t1', 'later')
    expect(writes[0].at).toBeGreaterThanOrEqual(3000 + SUBMIT_GAP_MS)
  })

  it('tells listeners when the held count changes', async () => {
    const { clock, drafts, q } = setup()
    drafts.add('t1')
    const counts: number[] = []
    const off = q.onHoldChange(() => counts.push(q.heldForDraft('t1')))
    clock.at(2000, () => drafts.delete('t1'))
    const a = q.submit('t1', 'A')
    await Promise.resolve()
    void q.submit('t1', 'B')
    await a
    await q.idle()
    off()
    expect(counts[0]).toBe(1) // held
    expect(counts).toContain(2) // B joined while held
    expect(counts[counts.length - 1]).toBe(0)
  })

  it('times the delivery check from the write, not the enqueue: a long hold is not reported lost', async () => {
    const clock = eventClock()
    const writes: { at: number; data: string }[] = []
    const lost: string[] = []
    const drafts = new Set(['t1'])
    const q = createSubmitQueue({
      write: (_id, data) => writes.push({ at: clock.now(), data }),
      now: clock.now, sleep: clock.sleep,
      hasUnsentInput: (id) => drafts.has(id),
      onUndelivered: (_id, text) => lost.push(text),
    })
    q.observable('t1')
    // Held for ten minutes, far past RESCUE_AFTER_MS + CONFIRM_WINDOW_MS.
    const release = 600_000
    clock.at(release, () => drafts.delete('t1'))
    let pendingAt: number | undefined
    clock.at(release + SUBMIT_GAP_MS + 1000, () => { pendingAt = q.pending('t1')?.at; q.confirm('t1') })
    await q.submit('t1', 'A')
    await q.idle()
    expect(pendingAt).toBeGreaterThanOrEqual(release)
    expect(lost).toEqual([])
    // Confirmed inside the window that started at the write, so no rescue CR.
    expect(writes.map((w) => w.data)).toEqual([submitSequence('A')])
  })

  it('hands a held message to a divert instead of waiting on a draft in a dying pty', async () => {
    const { clock, writes, drafts, q } = setup()
    drafts.add('t1')
    const handed: string[] = []
    clock.at(1000, () => q.divert('t1', (text) => handed.push(text)))
    await q.submit('t1', 'A')
    expect(handed).toEqual(['A'])
    expect(writes).toEqual([])
    expect(q.unwritten('t1')).toBe(0)
  })
})

describe('clearComposer never runs over a draft (retry path)', () => {
  it('writes nothing while the person has unsent text', async () => {
    const writes: string[] = []
    const q = createSubmitQueue({ write: (_id, data) => writes.push(data), ...fakeClock(), hasUnsentInput: () => true })
    await q.clearComposer('t1', 2)
    expect(writes).toEqual([])
  })

  it('still clears our own stale paste when there is no draft', async () => {
    const writes: string[] = []
    const q = createSubmitQueue({ write: (_id, data) => writes.push(data), ...fakeClock(), hasUnsentInput: () => false })
    await q.clearComposer('t1', 2)
    expect(writes).toEqual([clearComposerSequence(2)])
  })
})

describe('held on a draft: review fixes (2026-10-24)', () => {
  function setup(extra: Partial<Parameters<typeof createSubmitQueue>[0]> = {}) {
    const clock = eventClock()
    const writes: { at: number; id: string; data: string }[] = []
    const drafts = new Set<string>()
    const q = createSubmitQueue({
      write: (id, data) => writes.push({ at: clock.now(), id, data }),
      now: clock.now, sleep: clock.sleep,
      hasUnsentInput: (id) => drafts.has(id),
      clearUnsentInput: (id) => { drafts.delete(id) },
      ...extra,
    })
    return { clock, writes, drafts, q }
  }

  it('F2: deliverNow releases only the head; typing right after it holds message 2', async () => {
    const { clock, writes, drafts, q } = setup()
    drafts.add('t1')
    clock.at(2000, () => q.deliverNow('t1'))
    // The person starts their next line just after message 1 went with their draft.
    clock.at(2000 + SUBMIT_GAP_MS + 10, () => drafts.add('t1'))
    clock.at(9000, () => drafts.delete('t1'))
    await Promise.all([q.submit('t1', 'A'), q.submit('t1', 'B')])
    const subs = pastes(writes)
    expect(subs.map((w) => w.data)).toEqual([submitSequence('A'), submitSequence('B')])
    expect(subs[0].at).toBeLessThan(2000 + SUBMIT_GAP_MS + 10)
    // Not merged into the new line: B waited for it to be sent.
    expect(subs[1].at).toBeGreaterThanOrEqual(9000 + SUBMIT_GAP_MS)
  })

  it('F2: deliverNow with nothing at the hold releases nothing', async () => {
    const { clock, writes, drafts, q } = setup()
    q.deliverNow('t1')
    drafts.add('t1')
    clock.at(3000, () => drafts.delete('t1'))
    await q.submit('t1', 'A')
    expect(writes[0].at).toBeGreaterThanOrEqual(3000 + SUBMIT_GAP_MS)
  })

  it('F6: onlyIf is asked after the hold, told it was held, and false writes nothing', async () => {
    const { clock, writes, drafts, q } = setup()
    drafts.add('t1')
    clock.at(2000, () => drafts.delete('t1'))
    const asked: boolean[] = []
    const ok = await q.submit('t1', 'announce', { onlyIf: (held) => { asked.push(held); return !held } })
    expect(ok).toBe(false)
    expect(asked).toEqual([true])
    expect(writes).toEqual([])
    expect(q.unwritten('t1')).toBe(0)
    expect(q.pending('t1')).toBeUndefined()
    // Unheld, the same guard lets it through.
    expect(await q.submit('t1', 'announce', { onlyIf: (held) => !held })).toBe(true)
    expect(pastes(writes).map((w) => w.data)).toEqual([submitSequence('announce')])
  })

  it('F7: images go in the same step as the text, after the hold', async () => {
    const { clock, writes, drafts, q } = setup()
    drafts.add('t1')
    clock.at(1500, () => drafts.delete('t1'))
    await q.submit('t1', 'fix the header', { images: ['/tmp/a.png', '/tmp/b.png'] })
    expect(writes.slice(0, 2).map((w) => w.data)).toEqual(['\x1b[200~/tmp/a.png /tmp/b.png\x1b[201~', submitSequence('fix the header')])
    expect(writes[0].at).toBeGreaterThanOrEqual(1500)
  })

  it('F8: a slash command over a draft writes nothing and resolves false', async () => {
    const { writes, drafts, q } = setup()
    drafts.add('t1')
    expect(await q.submitTyped('t1', '/effort high')).toBe(false)
    drafts.delete('t1')
    expect(await q.submitTyped('t1', '/effort high')).toBe(true)
    expect(writes.map((w) => w.data)).toEqual(['/effort high\r'])
  })

  it('F3: draft runs onWrite at the write, after what was queued ahead of it', async () => {
    const { writes, q } = setup()
    const seenAtMark: string[][] = []
    const a = q.submit('t1', 'A')
    const d = q.draft('t1', 'mine', () => seenAtMark.push(pastes(writes).map((w) => w.data)))
    // Not at the enqueue.
    expect(seenAtMark).toEqual([])
    await Promise.all([a, d])
    expect(seenAtMark).toEqual([[submitSequence('A'), '\x1b[200~mine\x1b[201~']])
  })

  it('F1: tells the ledger what is owed, when the draft holds it, and when it is settled', async () => {
    const events: string[] = []
    const { clock, drafts, q } = setup({
      ledger: {
        owe: (id, _key, text) => events.push(`owe ${id} ${text}`),
        settle: (id) => events.push(`settle ${id}`),
        held: (id, _key, text, on) => events.push(`${on ? 'held' : 'unheld'} ${id} ${text}`),
      },
    })
    drafts.add('t1')
    clock.at(1000, () => drafts.delete('t1'))
    await Promise.all([q.submit('t1', 'A'), q.submit('t2', 'B')])
    expect(events).toEqual(['owe t1 A', 'owe t2 B', 'held t1 A', 'settle t2', 'unheld t1 A', 'settle t1'])
  })

  it('F1: settles a submission a divert took, and one refused by onlyIf', async () => {
    const settled: string[] = []
    const { q } = setup({ ledger: { owe: () => {}, settle: (_id, key) => settled.push(key), held: () => {} } })
    expect(await q.submit('t1', 'no', { onlyIf: () => false })).toBe(false)
    q.divert('t1', () => {})
    expect(await q.submit('t1', 'away')).toBe(true)
    expect(settled).toHaveLength(2)
    expect(new Set(settled).size).toBe(2)
  })

  it('S3/S4: hands the ledger the images and reports a re-submission needs', async () => {
    const owed: unknown[] = []
    const { q } = setup({ ledger: { owe: (_id, _key, _text, opts) => owed.push({ images: opts?.images, reports: opts?.reports }), settle: () => {}, held: () => {} } })
    await q.submit('t1', 'look here', { images: ['/tmp/a.png'] })
    await q.submit('t1', 'report #7 ready', { reports: [7], onlyIf: () => true })
    expect(owed).toEqual([{ images: ['/tmp/a.png'], reports: undefined }, { images: undefined, reports: [7] }])
  })

  it('S5: a re-submission whose record reads held turns it back at the write, without holding again', async () => {
    const events: string[] = []
    const { q } = setup({ ledger: { owe: () => {}, settle: () => events.push('settle'), held: (_id, _key, text, on) => events.push(`${on ? 'held' : 'unheld'} ${text}`) } })
    await q.submit('t1', 'A', { held: true })
    expect(events).toEqual(['unheld A', 'settle'])
  })

  it('S5: one that is held again is not marked held twice', async () => {
    const events: string[] = []
    const { clock, drafts, q } = setup({ ledger: { owe: () => {}, settle: () => events.push('settle'), held: (_id, _key, text, on) => events.push(`${on ? 'held' : 'unheld'} ${text}`) } })
    drafts.add('t1')
    clock.at(1000, () => drafts.delete('t1'))
    await q.submit('t1', 'A', { held: true })
    expect(events).toEqual(['unheld A', 'settle'])
  })
})
