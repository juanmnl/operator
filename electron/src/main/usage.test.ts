import { describe, it, expect, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The aggregator scans $HOME/.claude/projects, so HOME is redirected before the module loads —
// pointing it at the real one would make the numbers depend on the user's actual history.
const SANDBOX = mkdtempSync(join(tmpdir(), 'operator-usage-test-'))
process.env.HOME = SANDBOX
const PROJ = join(SANDBOX, '.claude', 'projects', '-Users-dev-thing')
mkdirSync(PROJ, { recursive: true })

const M = 1_000_000
/** One assistant turn with a usage block. `id` drives the de-duplication. */
const turn = (o: {
  id: string; model?: string; input?: number; output?: number; cacheRead?: number
  cache5m?: number; cache1h?: number; ccTotal?: number; ts?: string
  requestId?: string; sidechain?: boolean; skill?: string; durationMs?: number
  /** `usage.speed` exactly as Claude Code persists it — 'standard' on every real record today. */
  speed?: string
}) => JSON.stringify({
  type: 'assistant',
  timestamp: o.ts ?? '2026-08-20T10:00:00.000Z',
  requestId: o.requestId,
  isSidechain: o.sidechain,
  attributionSkill: o.skill,
  durationMs: o.durationMs,
  message: {
    id: o.id,
    model: o.model ?? 'claude-opus-4',
    usage: {
      ...(o.speed !== undefined ? { speed: o.speed } : {}),
      input_tokens: o.input ?? 0,
      output_tokens: o.output ?? 0,
      cache_read_input_tokens: o.cacheRead ?? 0,
      cache_creation_input_tokens: o.ccTotal ?? ((o.cache5m ?? 0) + (o.cache1h ?? 0)),
      ...(o.cache5m !== undefined || o.cache1h !== undefined
        ? { cache_creation: { ephemeral_5m_input_tokens: o.cache5m ?? 0, ephemeral_1h_input_tokens: o.cache1h ?? 0 } }
        : {}),
    },
    content: [{ type: 'text', text: 'x' }],
  },
}) + '\n'

/** Each case writes its own session file and gets a FRESH module.
 *
 *  `resetModules` is the point: the aggregator caches its parsed records for 30 s, so without it
 *  every case after the first would be reading the first one's fixture. */
async function usageOf(lines: string, days = 0) {
  const file = join(PROJ, `${Math.random().toString(36).slice(2)}.jsonl`)
  writeFileSync(file, lines)
  vi.resetModules()
  const mod = await import('./usage')
  const stats = await mod.computeUsage(days)
  const insights = await mod.computeInsights(days)
  rmSync(file)
  return { stats, insights }
}

afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

describe('cost — the cache tiers are billed at different rates', () => {
  // Ported from `cost_sums_every_token_tier_with_correct_multipliers` in usage.rs.
  it('opus, one million of every tier, is $46.75', async () => {
    // 5 (input) + 25 (output) + 0.5 (cache_read ×0.1) + 6.25 (cache5m ×1.25) + 10 (cache1h ×2)
    const { stats } = await usageOf(turn({ id: 'a', model: 'claude-opus-4', input: M, output: M, cacheRead: M, cache5m: M, cache1h: M }))
    expect(stats.totalCost).toBeCloseTo(46.75, 9)
  })

  it('flattening the cache tiers would misreport badly — the split is the point', async () => {
    // Same token count, all as cache_read rather than cache-write: 20× cheaper on that tier.
    const read = await usageOf(turn({ id: 'r', cacheRead: M }))
    const write = await usageOf(turn({ id: 'w', cache5m: M }))
    expect(read.stats.totalCost).toBeCloseTo(0.5, 9)
    expect(write.stats.totalCost).toBeCloseTo(6.25, 9)
  })

  it('an older record with only a single cache_creation total bills at the 5-minute rate', async () => {
    // The 5m/1h split does not exist on older records; the total must not be dropped.
    const { stats } = await usageOf(turn({ id: 'old', ccTotal: M }))
    expect(stats.totalCost).toBeCloseTo(6.25, 9)
    expect(stats.totalTokens).toBe(M)
  })

  it('is zero with no tokens', async () => {
    const { stats } = await usageOf(turn({ id: 'z' }))
    expect(stats.totalCost).toBe(0)
    expect(stats.totalTokens).toBe(0)
  })

  it('sums every tier into totalTokens', async () => {
    const { stats } = await usageOf(turn({ id: 't', input: 1, output: 2, cacheRead: 3, cache5m: 4, cache1h: 5 }))
    expect(stats.totalTokens).toBe(15)
  })
})

describe('rates by model family', () => {
  const cases: Array<[string, number]> = [
    ['claude-fable-5-1', 10], ['claude-fable-5', 10], ['mythos-mini', 10],
    ['claude-opus-5', 5], ['claude-opus-4-8', 5],
    ['claude-sonnet-5', 2], ['claude-sonnet-4-6', 3], ['claude-haiku-4-5', 1],
    ['gpt-4o', 5], // unknown falls back to opus pricing — never to zero, which would read as free
  ]
  for (const [model, perM] of cases) {
    it(`${model} bills input at $${perM}/Mtok`, async () => {
      const { stats } = await usageOf(turn({ id: model, model, input: M }))
      expect(stats.totalCost).toBeCloseTo(perM, 9)
    })
  }

  // Sonnet stopped being one rate. A substring match on `sonnet` alone cannot separate Sonnet 5
  // (2/10) from Sonnet 4.6 (3/15), so the version is matched first.
  it('a dated id and a point release both inherit the Sonnet 5 tier', async () => {
    for (const model of ['claude-sonnet-5-20260101', 'claude-sonnet-5-1']) {
      const { stats } = await usageOf(turn({ id: model, model, input: M }))
      expect(stats.totalCost).toBeCloseTo(2, 9)
    }
  })

  // The ambiguous case, answered deliberately: an unversioned alias takes the HIGHER rate.
  // Over-reporting is recoverable; a cost view that quietly under-reports is not.
  it('a bare `sonnet` alias takes the higher 3/15, not the newer 2/10', async () => {
    const { stats } = await usageOf(turn({ id: 'bare', model: 'sonnet', input: M }))
    expect(stats.totalCost).toBeCloseTo(3, 9)
  })
})

describe('cache reads are a per-model rate, not a flat 0.1×', () => {
  // The largest distortion the old flat multiplier produced: 1M cache-read tokens on Fable 5.1
  // cost $0.25, not the $1.00 that 0.1 × $10 claimed — a 4× over-report on the traffic an agent
  // session is mostly made of.
  it('Fable 5.1 reads cache at a flat $0.25/Mtok', async () => {
    const { stats } = await usageOf(turn({ id: 'f51', model: 'claude-fable-5-1', cacheRead: M }))
    expect(stats.totalCost).toBeCloseTo(0.25, 9)
  })

  // $0.25 is documented for 5.1 specifically, as something it ADDS over Fable 5; whether Mythos
  // 5.1 shares it is open. Neither takes the discount on assumption.
  it('Fable 5 and Mythos keep the 0.1× default', async () => {
    const five = await usageOf(turn({ id: 'f5', model: 'claude-fable-5', cacheRead: M }))
    const mythos = await usageOf(turn({ id: 'm51', model: 'claude-mythos-5-1', cacheRead: M }))
    expect(five.stats.totalCost).toBeCloseTo(1, 9)
    expect(mythos.stats.totalCost).toBeCloseTo(1, 9)
  })

  it('every other model reads cache at a tenth of its own input rate', async () => {
    for (const [model, expected] of [['claude-opus-5', 0.5], ['claude-sonnet-5', 0.2], ['claude-haiku-4-5', 0.1]] as const) {
      const { stats } = await usageOf(turn({ id: `cr-${model}`, model, cacheRead: M }))
      expect(stats.totalCost).toBeCloseTo(expected, 9)
    }
  })
})

describe('fast mode', () => {
  // `usage.speed` is real and persisted — 132,245 of 451,480 transcript lines carry it, all
  // reading 'standard'. Nothing infers fast mode from timing; only the field decides.
  it('a fast Opus turn bills 10/50 instead of 5/25', async () => {
    const std = await usageOf(turn({ id: 'std', model: 'claude-opus-5', input: M, output: M, speed: 'standard' }))
    const fast = await usageOf(turn({ id: 'fast', model: 'claude-opus-5', input: M, output: M, speed: 'fast' }))
    expect(std.stats.totalCost).toBeCloseTo(30, 9)
    expect(fast.stats.totalCost).toBeCloseTo(60, 9)
  })

  it('a missing or standard speed is the standard rate', async () => {
    const absent = await usageOf(turn({ id: 'a', model: 'claude-opus-5', input: M }))
    const standard = await usageOf(turn({ id: 'b', model: 'claude-opus-5', input: M, speed: 'standard' }))
    expect(absent.stats.totalCost).toBeCloseTo(5, 9)
    expect(standard.stats.totalCost).toBeCloseTo(5, 9)
  })

  // Fast mode is an Opus-only research preview, so the flag must not move any other family's bill.
  it('does not change a non-Opus model, which has no fast mode to bill', async () => {
    const { stats } = await usageOf(turn({ id: 's', model: 'claude-sonnet-5', input: M, speed: 'fast' }))
    expect(stats.totalCost).toBeCloseTo(2, 9)
  })
})

describe('de-duplication', () => {
  it('counts a message id ONCE however often the turn is re-emitted', async () => {
    // Claude Code re-emits the same message as a turn streams; counting each would multiply the
    // totals several times over.
    const { stats } = await usageOf(turn({ id: 'same', input: 100 }) + turn({ id: 'same', input: 100 }) + turn({ id: 'other', input: 100 }))
    expect(stats.totalTokens).toBe(200)
  })

  it('treats the same id with a DIFFERENT requestId as a separate record', async () => {
    const { stats } = await usageOf(turn({ id: 'x', requestId: 'r1', input: 100 }) + turn({ id: 'x', requestId: 'r2', input: 100 }))
    expect(stats.totalTokens).toBe(200)
  })

  it('skips synthetic and model-less turns', async () => {
    const { stats } = await usageOf(turn({ id: 's', model: '<synthetic>', input: 999 }))
    expect(stats.totalTokens).toBe(0)
  })
})

describe('grouping', () => {
  it('splits by model, newest cost first', async () => {
    const { stats } = await usageOf(
      turn({ id: 'a', model: 'claude-opus-4', input: M }) + turn({ id: 'b', model: 'claude-haiku-4-5', input: M }),
    )
    expect(stats.byModel.map((m: { model: string }) => m.model)).toEqual(['claude-opus-4', 'claude-haiku-4-5'])
    expect(stats.byModel[0].cost).toBeGreaterThan(stats.byModel[1].cost)
  })

  it('groups by day, oldest first', async () => {
    const { stats } = await usageOf(
      turn({ id: 'a', ts: '2026-08-19T10:00:00Z', input: M }) + turn({ id: 'b', ts: '2026-08-20T10:00:00Z', input: M }),
    )
    expect(stats.byDay.map((d: { date: string }) => d.date)).toEqual(['2026-08-19', '2026-08-20'])
  })

  it('wall time is the SPAN, not the sum — sessions overlap', async () => {
    const { stats } = await usageOf(
      turn({ id: 'a', ts: '2026-08-20T10:00:00Z', durationMs: 60_000 }) +
      turn({ id: 'b', ts: '2026-08-20T11:00:00Z', durationMs: 60_000 }),
    )
    expect(stats.wallMs).toBe(3_600_000)   // one hour apart
    expect(stats.apiMs).toBe(120_000)      // the durations DO sum
  })

  it('honours the day cutoff', async () => {
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString()
    const { stats } = await usageOf(turn({ id: 'old', ts: old, input: M }) + turn({ id: 'new', input: M }))
    expect((await usageOf(turn({ id: 'old2', ts: old, input: M }), 7)).stats.totalTokens).toBe(0)
    expect(stats.totalTokens).toBe(2 * M)  // days = 0 means everything
  })
})

describe('insights', () => {
  it('attributes subagent share per SESSION, not per record', async () => {
    // The question is "how much of my work involves delegation", so a session that used a
    // subagent has ALL of its tokens counted.
    const { insights } = await usageOf(
      turn({ id: 'a', input: 100 }) + turn({ id: 'b', input: 100, sidechain: true }),
    )
    expect(insights.subagentPct).toBe(100)
  })

  it('counts high-context tokens above 150k', async () => {
    const { insights } = await usageOf(turn({ id: 'big', input: 200_000 }) + turn({ id: 'small', input: 10 }))
    expect(insights.highContextPct).toBeGreaterThan(99)
  })

  it('ranks skills by share and caps the list at 8', async () => {
    let lines = ''
    for (let i = 0; i < 12; i++) lines += turn({ id: `s${i}`, input: (i + 1) * 100, skill: `skill-${i}` })
    const { insights } = await usageOf(lines)
    expect(insights.skills).toHaveLength(8)
    expect(insights.skills[0].name).toBe('skill-11')   // the biggest share first
  })

  it('is all zeroes rather than NaN when there is nothing', async () => {
    const { insights } = await usageOf('')
    expect(insights.totalTokens).toBe(0)
    expect(insights.highContextPct).toBe(0)
    expect(insights.subagentPct).toBe(0)
  })
})
