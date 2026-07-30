import { describe, it, expect } from 'vitest'
import {
  readable, hasData, toneFor, TONE_FILL, limitRows, glanceLine, updatedAgo, ringDash,
  resetAtOf, windowEnded, freshnessOf, hasCurrentData, FRESH_MS, STALE_MS,
  WARN_AT, DANGER_AT, type PlanLimits,
} from './plan-limits'

const full: PlanLimits = {
  sessionPct: 66, sessionResets: 'Jul 30 at 2am (America/Guayaquil)',
  weekPct: 39, weekResets: 'Aug 4 at 1am (America/Guayaquil)',
  modelLabel: 'Fable', modelPct: 0, modelResets: 'Aug 4 at 1am (America/Guayaquil)',
  plan: 'You are currently using your subscription to power your Claude Code usage',
  fetchedAt: '2026-07-30T12:00:00.000Z',
}
/** What an API-billing account (or a reworded CLI) produces. */
const empty: PlanLimits = { fetchedAt: '2026-07-30T12:00:00.000Z', note: 'Couldn’t find usage lines.' }

describe('ABSENT IS NOT ZERO — the rule the whole meter turns on', () => {
  it('keeps a missing reading and a zero reading apart', () => {
    expect(readable(0)).toBe(0)
    expect(readable(null)).toBeNull()
    expect(readable(undefined)).toBeNull()
    expect(readable(NaN)).toBeNull()
  })

  it('draws NO arc when there is no data, rather than an empty-looking full ring', () => {
    expect(ringDash(null, 8).dash).toBe(0)
    expect(hasData(empty)).toBe(false)
    expect(hasData(null)).toBe(false)
  })

  it('treats a real 0% as data — a fresh week is a reading, not a failure', () => {
    expect(hasData({ fetchedAt: 'x', sessionPct: 0 })).toBe(true)
    expect(limitRows({ fetchedAt: 'x', sessionPct: 0 })).toHaveLength(1)
  })

  it('lists no rows at all when nothing was read', () => {
    expect(limitRows(empty)).toEqual([])
    expect(limitRows(null)).toEqual([])
    expect(glanceLine(empty)).toBeNull()
  })
})

describe('thresholds', () => {
  it('changes tone at 75 and 90, inclusive', () => {
    expect(toneFor(0)).toBe('normal')
    expect(toneFor(74)).toBe('normal')
    expect(toneFor(WARN_AT)).toBe('warn')
    expect(toneFor(89)).toBe('warn')
    expect(toneFor(DANGER_AT)).toBe('danger')
    expect(toneFor(100)).toBe('danger')
  })

  it('has no tone for an absent reading — an unknown limit is not a calm one either', () => {
    expect(toneFor(null)).toBe('normal') // the arc isn't drawn at all, so this is never painted
  })

  it('maps each tone to a distinct token, and none of them is a raw colour', () => {
    const fills = Object.values(TONE_FILL)
    expect(new Set(fills).size).toBe(fills.length)
    for (const f of fills) expect(f.startsWith('var(--')).toBe(true)
  })
})

describe('limitRows', () => {
  it('lists session, week and the per-model line in order', () => {
    expect(limitRows(full).map((r) => [r.key, r.pct])).toEqual([['session', 66], ['week', 39], ['model', 0]])
  })

  it("carries the CLI's own model label rather than hardcoding a model name", () => {
    expect(limitRows(full)[2].label).toBe('Current week (Fable)')
    expect(limitRows({ ...full, modelLabel: 'Sonnet' })[2].label).toBe('Current week (Sonnet)')
    // …and stays readable when the label is missing but the number isn't.
    expect(limitRows({ fetchedAt: 'x', modelPct: 4 })[0].label).toBe('Current week (per model)')
  })

  it('skips a limit this account does not have', () => {
    expect(limitRows({ fetchedAt: 'x', sessionPct: 10 }).map((r) => r.key)).toEqual(['session'])
  })

  it('carries the reset text VERBATIM, timezone and all', () => {
    // Re-deriving a local time from an already-localised string prints the wrong hour.
    expect(limitRows(full)[0].resets).toBe('Jul 30 at 2am (America/Guayaquil)')
  })

  it('clamps a number outside 0–100 rather than drawing a bar past its track', () => {
    expect(limitRows({ fetchedAt: 'x', sessionPct: 140 })[0].pct).toBe(100)
    expect(limitRows({ fetchedAt: 'x', sessionPct: -5 })[0].pct).toBe(0)
  })
})

describe('the glance line', () => {
  it('says both numbers so a hover never needs a click', () => {
    expect(glanceLine(full)).toBe('Session 66% · Week 39%')
  })
  it('says only what it knows', () => {
    expect(glanceLine({ fetchedAt: 'x', weekPct: 12 })).toBe('Week 12%')
  })
})

describe('updatedAgo — coarse on purpose (a 5-minute cache)', () => {
  const t = Date.parse('2026-07-30T12:00:00.000Z')
  it('reads in minutes and hours', () => {
    expect(updatedAgo('2026-07-30T12:00:00.000Z', t)).toBe('just now')
    expect(updatedAgo('2026-07-30T11:59:10.000Z', t)).toBe('just now')
    expect(updatedAgo('2026-07-30T11:59:00.000Z', t)).toBe('1m ago')
    expect(updatedAgo('2026-07-30T11:57:00.000Z', t)).toBe('3m ago')
    expect(updatedAgo('2026-07-30T11:00:00.000Z', t)).toBe('1h ago')
    expect(updatedAgo('2026-07-30T09:00:00.000Z', t)).toBe('3h ago')
  })
  it('never prints a negative age from clock skew', () => {
    expect(updatedAgo('2026-07-30T12:05:00.000Z', t)).toBe('just now')
  })
  it('is null for a missing or unparseable stamp', () => {
    expect(updatedAgo(undefined, t)).toBeNull()
    expect(updatedAgo('not a date', t)).toBeNull()
  })
})

describe('ringDash', () => {
  it('sweeps the arc in proportion to the percentage', () => {
    const { dash, circumference } = ringDash(50, 10)
    expect(dash).toBeCloseTo(circumference / 2, 6)
    expect(ringDash(100, 10).gap).toBeCloseTo(0, 6)
    expect(ringDash(0, 10).dash).toBe(0)
  })
  it('always sums to the circumference, so the track is never over- or under-drawn', () => {
    for (const pct of [0, 1, 33, 66, 99, 100, null]) {
      const { dash, gap, circumference } = ringDash(pct, 8.2)
      expect(dash + gap).toBeCloseTo(circumference, 6)
    }
  })
})

// --- the reset clause, and the window it names (dev/briefs/plan-usage-stale.md) -----------
// The reported failure: session shown at 12% next to `resets Jul 30 at 9:59am`, read after 10am.
// Not stale — provably false, from data already in hand.
describe('resetAtOf', () => {
  const fetched = '2026-07-30T18:00:00.000Z' // 1pm in America/Guayaquil (UTC-5, no DST)

  it('parses the phrasing the CLI actually emits — zoned, with minutes', () => {
    const at = resetAtOf('Jul 30 at 8:30pm (America/Guayaquil)', fetched)
    expect(at).toBe(Date.UTC(2026, 6, 31, 1, 30)) // 8:30pm UTC-5 → 01:30 UTC next day
  })

  it('parses a whole-hour zoned clause, and a 12-hour boundary', () => {
    expect(resetAtOf('Jul 30 at 2am (America/Guayaquil)', fetched)).toBe(Date.UTC(2026, 6, 30, 7, 0))
    // 12am is hour 0, 12pm is hour 12 — the modulo trap.
    expect(resetAtOf('Aug 4 at 12:59am (America/Guayaquil)', fetched)).toBe(Date.UTC(2026, 7, 4, 5, 59))
    expect(resetAtOf('Aug 4 at 12pm (America/Guayaquil)', fetched)).toBe(Date.UTC(2026, 7, 4, 17, 0))
  })

  it('reads an unzoned clause as local time', () => {
    // No zone named → the machine's own, which is what the CLI meant by omitting it.
    expect(resetAtOf('Jul 30 at 2am', fetched)).toBe(new Date(2026, 6, 30, 2, 0).getTime())
  })

  it('parses the relative forms, anchored to when we FETCHED it', () => {
    const t = Date.parse(fetched)
    expect(resetAtOf('in 3 hours', fetched)).toBe(t + 3 * 3_600_000)
    expect(resetAtOf('in 45 minutes', fetched)).toBe(t + 45 * 60_000)
    expect(resetAtOf('in 4 hr 55 min', fetched)).toBe(t + 4 * 3_600_000 + 55 * 60_000)
  })

  it('rolls the YEAR forward, since the clause never carries one', () => {
    const dec = '2026-12-31T20:00:00.000Z'
    const at = resetAtOf('Jan 1 at 2am (America/Guayaquil)', dec)
    expect(at).toBe(Date.UTC(2027, 0, 1, 7, 0)) // next year, not ten months ago
  })

  it('DECLINES every phrasing it cannot pin exactly', () => {
    // Each is a real fixture from planlimits.rs's tests. Declining falls back to the plain age
    // thresholds; guessing would blank a number the user can see is fine.
    for (const clause of ['tomorrow', 'Sunday', 'Aug 4', 'later', 'in 3', 'in a while', '', '   ']) {
      expect(resetAtOf(clause, fetched), clause).toBeNull()
    }
    expect(resetAtOf(null, fetched)).toBeNull()
    expect(resetAtOf('Jul 30 at 2am', undefined)).toBeNull()   // no anchor → no year, no answer
    expect(resetAtOf('Jul 30 at 2am', 'not a date')).toBeNull()
  })

  it('declines an unknown timezone rather than silently using local', () => {
    expect(resetAtOf('Jul 30 at 2am (Mars/Olympus)', fetched)).toBeNull()
  })
})

describe('windowEnded / freshnessOf', () => {
  const at = (iso: string) => Date.parse(iso)
  const reading = (over: Partial<PlanLimits> = {}): PlanLimits => ({
    sessionPct: 12, weekPct: 40,
    sessionResets: 'in 2 hours',
    fetchedAt: '2026-07-30T18:00:00.000Z',
    ...over,
  })

  it('is the REPORTED BUG: a reading whose own reset time has passed', () => {
    const l = reading()
    const t = at('2026-07-30T18:00:00.000Z')
    expect(windowEnded(l, t + 60_000)).toBe(false)
    expect(windowEnded(l, t + 2 * 3_600_000)).toBe(true)
    // …and the meter stops asserting the number, rather than showing 12% from a dead window.
    expect(hasCurrentData(l, t + 2 * 3_600_000)).toBe(false)
    expect(freshnessOf(l, t + 2 * 3_600_000)).toBe('expired')
  })

  it('separates "a bit old" from "we know this window ended"', () => {
    const t = at('2026-07-30T18:00:00.000Z')
    expect(freshnessOf(reading(), t)).toBe('current')
    expect(freshnessOf(reading(), t + FRESH_MS + 1)).toBe('aging')      // past TTL, window open
    expect(freshnessOf(reading(), t + 2 * 3_600_000)).toBe('expired')   // window closed
    // Aging still shows its numbers — they are drifting, not false.
    expect(hasCurrentData(reading(), t + FRESH_MS + 1)).toBe(true)
  })

  it('never reads an unparseable clause as ended — it falls back to the age thresholds', () => {
    const l = reading({ sessionResets: 'Sunday' })
    const t = at('2026-07-30T18:00:00.000Z')
    // Six hours on: a parseable clause would have called this closed long ago. This one can't be
    // read, so it is merely OLD — and only the STALE_MS catch-all eventually retires it.
    expect(windowEnded(l, t + 6 * 3_600_000)).toBe(false)
    expect(freshnessOf(l, t + 30 * 60_000)).toBe('aging')       // old, but not disproven
    expect(freshnessOf(l, t + STALE_MS + 1)).toBe('expired')    // …until the catch-all bites
  })

  it('treats a reading with no reset clause the same way', () => {
    const l = reading({ sessionResets: undefined })
    expect(windowEnded(l, at('2026-07-31T18:00:00.000Z'))).toBe(false)
  })
})
