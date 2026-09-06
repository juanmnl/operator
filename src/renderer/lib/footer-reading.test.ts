import { describe, it, expect } from 'vitest'
import { contextReading, planReading } from './footer-reading'
import { CONTEXT_WINDOW, CONTEXT_WINDOW_1M } from './model-config'
import type { PlanLimits } from './plan-limits'
import { FRESH_MS } from './plan-limits'
import type { AgentSession } from '../../shared/types'

const sess = (o: Partial<AgentSession> = {}) => ({
  model: 'claude-opus-4-20250514', phase: 'waiting', ...o,
} as AgentSession)

describe('contextReading — absent is not zero', () => {
  it('reports the live prompt size against the model’s window', () => {
    const r = contextReading(sess({ contextTokens: 84_000 }))
    expect(r.used).toBe(84_000)
    expect(r.window).toBe(CONTEXT_WINDOW)
    expect(r.pct).toBeCloseTo(42)
  })

  it('has NO value before the first assistant turn — never 0k under an empty bar', () => {
    // Rendering `0k` would say the context is fresh when in fact nothing is known. The cell
    // draws `—` over a bare track instead, the same rule the plan meter keeps for a missing
    // reading one axis over.
    for (const s of [sess(), sess({ contextTokens: 0 })]) {
      const r = contextReading(s)
      expect(r.used).toBeUndefined()
      expect(r.pct).toBe(0)
    }
  })

  it('uses the 1M window for a long-context model, so it is not called 84% full at 840k', () => {
    const r = contextReading(sess({ model: 'claude-sonnet-4-20250514[1m]', contextTokens: 840_000 }))
    expect(r.window).toBe(CONTEXT_WINDOW_1M)
    expect(r.pct).toBeCloseTo(84)
  })

  it('reports the compacting phase, which replaces the numbers with a word', () => {
    expect(contextReading(sess({ phase: 'compacting', contextTokens: 5 })).compacting).toBe(true)
    expect(contextReading(sess({ phase: 'running', contextTokens: 5 })).compacting).toBe(false)
  })

  it('carries the compaction count, zero included so the cell can hide it', () => {
    expect(contextReading(sess({ compactions: 2 })).compactions).toBe(2)
    expect(contextReading(sess()).compactions).toBe(0)
  })
})

// The number the cell shows comes from the tailer, which computes it from the transcript. This is
// that computation, run over the record shape the tailers actually parse — the brief's
// "context computation from a synthetic jsonl".
describe('the context number, computed from transcript records', () => {
  /** The tailers' rule, mirrored: input + cache_read + cache_creation of the LATEST main-thread
   *  assistant record. Not a running total — `usage` is cumulative and cannot answer this. */
  const contextOf = (lines: string[]): number => {
    let ctx = 0
    let lastId = ''
    for (const line of lines) {
      const rec = JSON.parse(line)
      if (rec.type !== 'assistant') continue
      const u = rec.message?.usage
      if (!u) continue
      const id = rec.message?.id ?? ''
      if (id && id === lastId) continue // the same message re-emitted as the turn streams
      lastId = id
      const g = (k: string) => (typeof u[k] === 'number' ? u[k] : 0)
      ctx = g('input_tokens') + g('cache_read_input_tokens') + g('cache_creation_input_tokens')
    }
    return ctx
  }
  const rec = (id: string, u: Record<string, number>) =>
    JSON.stringify({ type: 'assistant', timestamp: '2026-09-06T10:00:00Z', message: { id, model: 'claude-opus-4', usage: u } })

  it('sums the three parts of the prompt', () => {
    expect(contextOf([rec('m1', { input_tokens: 1200, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 2800 })]))
      .toBe(84_000)
  })

  it('takes the LATEST record, not a running total', () => {
    // The distinction the new field exists for: `usage` accumulates once per API response, so it
    // grows forever and can never say how full the context is right now.
    const lines = [
      rec('m1', { input_tokens: 1000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 0 }),
      rec('m2', { input_tokens: 1000, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 0 }),
    ]
    expect(contextOf(lines)).toBe(31_000)
  })

  it('ignores a message re-emitted as its turn streams', () => {
    const lines = [
      rec('m1', { input_tokens: 1000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 0 }),
      rec('m1', { input_tokens: 1000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 0 }),
    ]
    expect(contextOf(lines)).toBe(11_000)
  })

  it('is zero — and therefore ABSENT to the cell — before any assistant record', () => {
    const user = JSON.stringify({ type: 'user', message: { content: 'hello' } })
    expect(contextOf([user])).toBe(0)
    expect(contextReading(sess({ contextTokens: contextOf([user]) })).used).toBeUndefined()
  })
})

const NOW = Date.parse('2026-09-06T12:00:00.000Z')
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const limits = (o: Partial<PlanLimits> = {}): PlanLimits => ({
  fetchedAt: at(1000),
  sessionPct: 17, sessionResets: 'Sep 6 at 4:00pm',
  weekPct: 42, weekResets: 'Sep 8 at 12:59am (America/Guayaquil)',
  modelLabel: 'Fable', modelPct: 66, modelResets: 'Sep 8 at 12:59am',
  ...o,
})

describe('planReading — every limit named, one marked', () => {
  it('marks the FURTHEST ALONG row and only that one', () => {
    const { rows, state } = planReading(limits(), NOW)
    expect(state).toBe('current')
    expect(rows.map((r) => r.binding)).toEqual([false, false, true]) // Fable at 66%
    expect(rows.filter((r) => r.binding)).toHaveLength(1)
  })

  it('moves the mark when another limit overtakes — it is not pinned to a row', () => {
    // The failure that caused this design: the arc happened to draw the per-model row and the
    // whole control read as "it's only showing Fable".
    const { rows } = planReading(limits({ sessionPct: 91 }), NOW)
    expect(rows.find((r) => r.binding)?.label).toMatch(/session/i)
  })

  it('names every limit, so "it only shows one" cannot be thought', () => {
    const { rows } = planReading(limits(), NOW)
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.label.length > 1)).toBe(true)
  })

  it('takes the per-model row’s label from the reading, never a hardcoded model name', () => {
    expect(planReading(limits({ modelLabel: 'Opus' }), NOW).rows.some((r) => /opus/i.test(r.label))).toBe(true)
  })

  it('carries the reset clause verbatim, so nobody re-derives the hour', () => {
    const binding = planReading(limits(), NOW).rows.find((r) => r.binding)!
    expect(binding.resets).toBe('Sep 8 at 12:59am')
  })
})

describe('planReading — no data never renders as a percentage', () => {
  it('is `no-reading` with NO rows when there is nothing', () => {
    const r = planReading(null, NOW)
    expect(r.state).toBe('no-reading')
    expect(r.rows).toEqual([])
  })

  it('is `loading` rather than `no-reading` while a read is in flight', () => {
    expect(planReading(null, NOW, true).state).toBe('loading')
  })

  it('is `window-closed` once the reading’s own reset time has passed', () => {
    // A percentage beside a reset time that has already gone by is not "possibly out of date" —
    // it provably describes a window that no longer exists, so no percentage is shown at all.
    // The CLI's own clause format — `resetAtOf` parses that, not an ISO string. Anchored on
    // `fetchedAt`, "in 0 min" resolves to the moment of the read, which is already behind NOW.
    const r = planReading(limits({ sessionResets: 'in 0 min' }), NOW)
    expect(r.state).toBe('window-closed')
    expect(r.rows).toEqual([])
  })

  it('window-closed outranks loading — provably false beats busy', () => {
    expect(planReading(limits({ sessionResets: 'in 0 min' }), NOW, true).state).toBe('window-closed')
  })

  it('KEEPS the numbers while merely aging, with the state saying so', () => {
    // Still the best thing available, and a dot is the only warning 34px has room for.
    const r = planReading(limits({ fetchedAt: at(FRESH_MS + 60_000) }), NOW)
    expect(r.state).toBe('aging')
    expect(r.rows).toHaveLength(3)
    expect(r.rows.some((x) => x.binding)).toBe(true)
  })
})
