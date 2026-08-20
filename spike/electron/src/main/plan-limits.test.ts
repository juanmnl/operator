import { describe, it, expect } from 'vitest'
import { parseUsage, percentIn, resetsIn, parenLabel } from './plan-limits'

describe('field extractors', () => {
  it('reads the number immediately before the % sign', () => {
    expect(percentIn('Current session: 47% used')).toBe(47)
    expect(percentIn('Current week (all models): 8%')).toBe(8)
  })
  it('clamps above 100 and returns null with no percentage', () => {
    expect(percentIn('999%')).toBe(100)
    expect(percentIn('no number here')).toBeNull()
    expect(percentIn('% leading sign')).toBeNull()
  })
  it('reads the reset phrase', () => {
    expect(resetsIn('Current session: 47% · resets in 2h 14m')).toBe('in 2h 14m')
    expect(resetsIn('no reset here')).toBeNull()
  })
  it('reads a parenthesised label', () => {
    expect(parenLabel('Current week (Fable): 3%')).toBe('Fable')
    expect(parenLabel('Current week: 3%')).toBeNull()
  })
})

describe('parseUsage', () => {
  it('reads a full answer', () => {
    const r = parseUsage([
      'You are currently using your subscription.',
      'Current session: 47% · resets in 2h 14m',
      'Current week (all models): 8% · resets Thursday',
      'Current week (Fable): 3% · resets Thursday',
    ].join('\n'))
    expect(r.plan).toBe('You are currently using your subscription.')
    expect(r.sessionPct).toBe(47)
    expect(r.sessionResets).toBe('in 2h 14m')
    expect(r.weekPct).toBe(8)
    expect(r.modelLabel).toBe('Fable')
    expect(r.modelPct).toBe(3)
    expect(r.note).toBeUndefined()
  })

  it('treats an UNLABELLED weekly line as the overall one', () => {
    const r = parseUsage('Current week: 12% · resets Thursday')
    expect(r.weekPct).toBe(12)
    expect(r.modelPct).toBeUndefined()
  })

  it('stops at the contributing breakdown', () => {
    const r = parseUsage("Current session: 5%\nWhat's contributing\nCurrent week: 99%")
    expect(r.sessionPct).toBe(5)
    expect(r.weekPct).toBeUndefined() // past the heading — not a meter
  })

  it('SURFACES an unexpected answer as a note rather than as zeroes', () => {
    // An empty meter with no explanation is indistinguishable from a broken one.
    const r = parseUsage('Login required to view usage.')
    expect(r.sessionPct).toBeUndefined()
    expect(r.note).toContain('Login required')
  })

  it('notes an empty answer', () => {
    expect(parseUsage('').note).toMatch(/returned nothing/)
  })

  it('does not mistake a percentage line for the plan sentence', () => {
    const r = parseUsage('Your subscription is at 40%\nCurrent session: 40%')
    expect(r.plan).toBeUndefined()
  })
})
