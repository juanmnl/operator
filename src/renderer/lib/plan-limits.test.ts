import { describe, it, expect } from 'vitest'
import {
  readable, hasData, toneFor, TONE_FILL, limitRows, glanceLine, updatedAgo, ringDash,
  bindingLimit, WARN_AT, DANGER_AT, type PlanLimits,
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

describe('the ring draws the BINDING limit, not the session', () => {
  it('picks the row furthest along, whichever window it is', () => {
    // The shipped bug, exactly: a quarter-used session above a two-thirds-used week drew 24%.
    const shipped: PlanLimits = { fetchedAt: 'x', sessionPct: 24, weekPct: 65, modelLabel: 'Fable', modelPct: 0 }
    expect(bindingLimit(shipped)).toEqual({ key: 'week', label: 'Current week', pct: 65 })
    expect(ringDash(bindingLimit(shipped)!.pct, 8).dash)
      .toBeCloseTo(ringDash(65, 8).dash, 5)
  })

  it('still picks the session when the session IS the binding one', () => {
    expect(bindingLimit(full)?.key).toBe('session')
  })

  it('carries the tone of the limit it draws, so a hot week turns the ring', () => {
    const hotWeek: PlanLimits = { fetchedAt: 'x', sessionPct: 10, weekPct: 93 }
    expect(toneFor(bindingLimit(hotWeek)?.pct)).toBe('danger')
    // The old behaviour would have read the session and stayed calm at 93% of the week.
    expect(toneFor(hotWeek.sessionPct)).toBe('normal')
  })

  it('keeps row order on a tie — the narrower window resets sooner', () => {
    expect(bindingLimit({ fetchedAt: 'x', sessionPct: 50, weekPct: 50 })?.key).toBe('session')
  })

  it('names the per-model row from the CLI label when that is the binding one', () => {
    const modelHot: PlanLimits = { fetchedAt: 'x', sessionPct: 5, weekPct: 10, modelLabel: 'Fable', modelPct: 80 }
    expect(bindingLimit(modelHot)).toEqual({ key: 'model', label: 'Current week (Fable)', pct: 80 })
  })

  it('is absent, not zero, when nothing was read', () => {
    expect(bindingLimit(empty)).toBeNull()
    expect(bindingLimit(null)).toBeNull()
  })

  it('counts a model-only reply as data, so the ring is never blank beside a filled popover', () => {
    const modelOnly: PlanLimits = { fetchedAt: 'x', modelLabel: 'Fable', modelPct: 42 }
    expect(hasData(modelOnly)).toBe(true)
    expect(bindingLimit(modelOnly)?.pct).toBe(42)
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
