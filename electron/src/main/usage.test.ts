import { describe, it, expect, afterAll, vi } from 'vitest'
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
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
  requestId?: string; sidechain?: boolean; skill?: string; durationMs?: number; effort?: string
  /** `usage.speed` exactly as Claude Code persists it — 'standard' on every real record today. */
  speed?: string
}) => JSON.stringify({
  type: 'assistant',
  timestamp: o.ts ?? '2026-08-20T10:00:00.000Z',
  requestId: o.requestId,
  isSidechain: o.sidechain,
  attributionSkill: o.skill,
  durationMs: o.durationMs,
  effort: o.effort,
  message: {
    id: o.id,
    model: o.model ?? 'claude-opus-5',
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
    const { stats } = await usageOf(turn({ id: 'a', model: 'claude-opus-5', input: M, output: M, cacheRead: M, cache5m: M, cache1h: M }))
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
  // Input rates from Claude Code 2.1.300's built-in model catalog.
  const cases: Array<[string, number]> = [
    ['claude-fable-5-1', 10], ['claude-fable-5', 10], ['claude-mythos-5-1', 10], ['mythos-mini', 10],
    ['claude-opus-5-5', 4], ['claude-opus-5', 5], ['claude-opus-4-8', 5], ['claude-opus-4-5-20251101', 5],
    ['claude-opus-4-1-20250805', 15], ['claude-opus-4-20250514', 15], ['claude-opus-4', 15],
    ['claude-sonnet-5-5', 2], ['claude-sonnet-5', 2], ['claude-sonnet-4-6', 3],
    ['claude-haiku-4-5', 1],
    ['gpt-4o', 5], // unknown falls back to opus pricing — never to zero, which would read as free
  ]
  // Haiku 5.5 is absent: a million input tokens is past its long-prompt threshold. See below.
  for (const [model, perM] of cases) {
    it(`${model} bills input at $${perM}/Mtok`, async () => {
      const { stats } = await usageOf(turn({ id: model, model, input: M }))
      expect(stats.totalCost).toBeCloseTo(perM, 9)
    })
  }

  // Sonnet stopped being one rate. A substring match on `sonnet` alone cannot separate Sonnet 5
  // (2/10) from Sonnet 4.6 (3/15), so the version is matched first.
  it('output rates follow the catalog, not a fixed 5× of input', async () => {
    for (const [model, perM] of [['claude-opus-5-5', 20], ['claude-haiku-5-5', 0.5], ['claude-opus-4-1', 75], ['claude-sonnet-5-5', 10]] as const) {
      const { stats } = await usageOf(turn({ id: `out-${model}`, model, output: M }))
      expect(stats.totalCost).toBeCloseTo(perM, 9)
    }
  })

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
  // 1M cache-read tokens on Fable 5.1 cost $0.25, not the $1.00 that 0.1 × $10 claims — a 4×
  // over-report on the traffic an agent session is mostly made of.
  it('Fable 5.1 and Mythos 5.1 read cache at a flat $0.25/Mtok', async () => {
    for (const model of ['claude-fable-5-1', 'claude-mythos-5-1']) {
      const { stats } = await usageOf(turn({ id: `cr-${model}`, model, cacheRead: M }))
      expect(stats.totalCost).toBeCloseTo(0.25, 9)
    }
  })

  it('Fable 5 and Mythos 5 keep the 0.1× default', async () => {
    const five = await usageOf(turn({ id: 'f5', model: 'claude-fable-5', cacheRead: M }))
    const mythos = await usageOf(turn({ id: 'm5', model: 'claude-mythos-5', cacheRead: M }))
    expect(five.stats.totalCost).toBeCloseTo(1, 9)
    expect(mythos.stats.totalCost).toBeCloseTo(1, 9)
  })

  it('Opus 5.5 reads cache at $0.20 and Sonnet 5.5 at $0.10, a twentieth of input', async () => {
    const opus = await usageOf(turn({ id: 'o55', model: 'claude-opus-5-5', cacheRead: M }))
    const sonnet = await usageOf(turn({ id: 's55', model: 'claude-sonnet-5-5', cacheRead: M }))
    expect(opus.stats.totalCost).toBeCloseTo(0.2, 9)
    expect(sonnet.stats.totalCost).toBeCloseTo(0.1, 9)
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

  // Claude Code prices fast mode per model; the old single 10/50 over-reported Opus 5.5 and
  // under-reported Opus 4.6 and 4.7.
  it('is priced per Opus model: 8/40 on 5.5, 10/50 on 5 and 4.8, 30/150 on 4.6 and 4.7', async () => {
    for (const [model, expected] of [['claude-opus-5-5', 48], ['claude-opus-4-8', 60], ['claude-opus-4-6', 180], ['claude-opus-4-7', 180]] as const) {
      const { stats } = await usageOf(turn({ id: `fast-${model}`, model, input: M, output: M, speed: 'fast' }))
      expect(stats.totalCost).toBeCloseTo(expected, 9)
    }
  })

  // Claude Code's billing lookup (`tNt`) has no fast row for any other Opus and falls through to
  // the catalog rate. The 30/150 in its fast-mode picker is a display string.
  it('bills any other Opus at its standard rate', async () => {
    for (const [model, expected] of [['claude-opus-4-5-20251101', 30], ['claude-opus-4-1', 90], ['claude-opus-4-20250514', 90]] as const) {
      const { stats } = await usageOf(turn({ id: `fast-${model}`, model, input: M, output: M, speed: 'fast' }))
      expect(stats.totalCost).toBeCloseTo(expected, 9)
    }
  })

  it('Opus 5.5 fast reads cache at $0.40, a twentieth of its input', async () => {
    const { stats } = await usageOf(turn({ id: 'fast-cr', model: 'claude-opus-5-5', cacheRead: M, speed: 'fast' }))
    expect(stats.totalCost).toBeCloseTo(0.4, 9)
  })

  // Fast mode is an Opus-only research preview, so the flag must not move any other family's bill.
  it('does not change a non-Opus model, which has no fast mode to bill', async () => {
    const { stats } = await usageOf(turn({ id: 's', model: 'claude-sonnet-5', input: M, speed: 'fast' }))
    expect(stats.totalCost).toBeCloseTo(2, 9)
  })
})

describe('Haiku 5.5 long-prompt tier', () => {
  // Claude Code switches the WHOLE turn to 0.50/2.50 (cache read 0.05) when input + cache read +
  // cache write exceeds 100,000 tokens. The comparison is strict.
  it('bills at the base tier up to 100K prompt tokens', async () => {
    const { stats } = await usageOf(turn({ id: 'h-base', model: 'claude-haiku-5-5', input: 100_000, output: M }))
    expect(stats.totalCost).toBeCloseTo(100_000 * 0.1 / M + 0.5, 9)
  })

  it('bills every tier at the long-prompt rate above 100K', async () => {
    const { stats } = await usageOf(turn({ id: 'h-long', model: 'claude-haiku-5-5', input: 100_001, output: M }))
    expect(stats.totalCost).toBeCloseTo(100_001 * 0.5 / M + 2.5, 9)
  })

  it('counts cache reads and writes toward the threshold', async () => {
    const { stats } = await usageOf(turn({ id: 'h-cache', model: 'claude-haiku-5-5', input: 1, cacheRead: 60_000, cache5m: 40_000 }))
    // 1 × 0.50 + 60K × 0.05 + 40K × 0.50 × 1.25
    expect(stats.totalCost).toBeCloseTo((0.5 + 60_000 * 0.05 + 40_000 * 0.625) / M, 12)
  })

  it('does not apply to Haiku 4.5', async () => {
    const { stats } = await usageOf(turn({ id: 'h45', model: 'claude-haiku-4-5', input: 200_000 }))
    expect(stats.totalCost).toBeCloseTo(0.2, 9)
  })
})

describe('api-request records', () => {
  // Shapes as Claude Code 2.1.300 writes them, keys taken from real transcripts.
  const request = JSON.stringify({ type: 'api-request', sessionId: 's', id: 'r1', timestamp: '2026-08-20T10:00:01.000Z', version: '2.1.300',
    querySource: 'repl_main_thread', shapeHash: 'h', requestDigest: 'd', cacheControl: {}, keep: 1, params: { model: 'claude-opus-5', max_tokens: 64000 }, base: 'b', tail: [] }) + '\n'
  const shape = JSON.stringify({ type: 'api-request-shape', sessionId: 's', shapeHash: 'h', timestamp: '2026-08-20T10:00:01.000Z', version: '2.1.300', shape: {} }) + '\n'
  const blob = JSON.stringify({ type: 'api-request-blob', sessionId: 's', hash: 'x', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }) + '\n'

  it('are recognised by prefix, and nothing else is', async () => {
    const { isApiRequestLine } = await import('./usage')
    for (const l of [request, shape, blob]) expect(isApiRequestLine(l)).toBe(true)
    expect(isApiRequestLine(turn({ id: 'a' }))).toBe(false)
    // A user turn that QUOTES the record type is still a user turn.
    expect(isApiRequestLine(JSON.stringify({ type: 'user', message: { content: '{"type":"api-request"}' } }))).toBe(false)
  })

  it('match only the three known types, so a new api-request-* type still reaches the parser', async () => {
    const { isApiRequestLine } = await import('./usage')
    expect(isApiRequestLine(JSON.stringify({ type: 'api-request-error', message: { usage: {} } }))).toBe(false)
    expect(isApiRequestLine(JSON.stringify({ type: 'api-requests' }))).toBe(false)
  })

  it('leave the totals unchanged when interleaved with turns', async () => {
    const { stats } = await usageOf(shape + request + blob + turn({ id: 'a', input: M }) + request)
    expect(stats.totalTokens).toBe(M)
    expect(stats.totalCost).toBeCloseTo(5, 9)
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
      turn({ id: 'a', model: 'claude-opus-5', input: M }) + turn({ id: 'b', model: 'claude-haiku-4-5', input: M }),
    )
    expect(stats.byModel.map((m: { model: string }) => m.model)).toEqual(['claude-opus-5', 'claude-haiku-4-5'])
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

describe('subagent transcripts', () => {
  // Claude Code writes a subagent's turns to `<slug>/<session>/subagents/agent-<id>.jsonl`, and a
  // workflow's agents one level deeper under `workflows/<id>/`. None of it is in the parent file.
  const SLUG = join(SANDBOX, '.claude', 'projects', '-Users-dev-subagents')

  /** Writes a parent transcript and its subagent files, then scans with a fresh module. `files`
   *  maps a path under `<session>/` to its lines. */
  async function scan(parent: string, files: Record<string, string>, tuningDays = 0) {
    const session = Math.random().toString(36).slice(2)
    mkdirSync(SLUG, { recursive: true })
    writeFileSync(join(SLUG, `${session}.jsonl`), parent)
    for (const [rel, lines] of Object.entries(files)) {
      const path = join(SLUG, session, rel)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, lines)
    }
    vi.resetModules()
    const mod = await import('./usage')
    const result = {
      session,
      stats: await mod.computeUsage(0),
      insights: await mod.computeInsights(0),
      tuning: await mod.computeTuning(tuningDays, 0),
    }
    rmSync(SLUG, { recursive: true, force: true })
    return result
  }

  it('counts a subagent turn and attributes it to the parent session', async () => {
    const { session, stats, tuning } = await scan(
      turn({ id: 'p', requestId: 'rp', input: M }),
      { 'subagents/agent-a.jsonl': turn({ id: 's', requestId: 'rs', input: M, sidechain: true }) },
    )
    expect(stats.totalTokens).toBe(2 * M)
    expect(tuning.bySession).toHaveLength(1)
    expect(tuning.bySession[0].session).toBe(session)
  })

  it('reads a workflow agent nested under workflows/<id>/', async () => {
    const { session, stats, tuning } = await scan(
      turn({ id: 'p', requestId: 'rp', input: M }),
      { 'subagents/workflows/wf_abc/agent-w.jsonl': turn({ id: 'w', requestId: 'rw', input: M, sidechain: true }) },
    )
    expect(stats.totalTokens).toBe(2 * M)
    expect(tuning.bySession[0].session).toBe(session)
    expect(tuning.bySession[0].subagentTokens).toBe(M)
  })

  it('does not read .jsonl files elsewhere in the session directory', async () => {
    const { stats } = await scan(
      turn({ id: 'p', requestId: 'rp', input: M }),
      { 'tool-results/x.jsonl': turn({ id: 't', requestId: 'rt', input: M }) },
    )
    expect(stats.totalTokens).toBe(M)
  })

  // A subagent turn is written several times as it streams, and output_tokens grows between
  // emissions. Keeping the first copy undercounts subagent output by about 87% on real data.
  it('keeps the emission with the largest output_tokens', async () => {
    const emit = (output: number) => turn({ id: 's', requestId: 'rs', input: 10, output, sidechain: true })
    const { stats } = await scan('', { 'subagents/agent-a.jsonl': emit(5) + emit(300) + emit(4000) + emit(4000) })
    expect(stats.totalTokens).toBe(4010)
    expect(stats.byModel[0].messages).toBe(1)
  })

  // A forked subagent's file begins with a replay of the parent's earlier turns: same id, same
  // requestId, same usage, but `isSidechain: true`. It is the parent's turn, counted once.
  it('counts a fork replay of a parent turn once, as the parent turn', async () => {
    const parentTurn = turn({ id: 'p', requestId: 'rp', input: M, output: 100 })
    const replay = turn({ id: 'p', requestId: 'rp', input: M, output: 100, sidechain: true })
    const own = turn({ id: 's', requestId: 'rs', input: 1000, sidechain: true })
    const { stats, tuning } = await scan(parentTurn, { 'subagents/agent-fork.jsonl': replay + own })
    expect(stats.totalTokens).toBe(M + 100 + 1000)
    expect(tuning.bySession[0].turns).toBe(1)
    expect(tuning.bySession[0].subagentTokens).toBe(1000)
  })

  it('makes subagentPct non-zero for a session that used a subagent', async () => {
    const { insights } = await scan(
      turn({ id: 'p', requestId: 'rp', input: 100 }),
      { 'subagents/agent-a.jsonl': turn({ id: 's', requestId: 'rs', input: 100, sidechain: true }) },
    )
    expect(insights.subagentPct).toBe(100)
  })

  describe('in Tuning', () => {
    // The lane: Opus 5 on high, two turns at 200k and 10k context. The subagent: Sonnet 5 on low,
    // later than both lane turns, at a small context.
    const lane = turn({ id: 'p1', requestId: 'r1', model: 'claude-opus-5', effort: 'high', cacheRead: 200_000, ts: '2026-08-20T10:00:00Z' })
      + turn({ id: 'p2', requestId: 'r2', model: 'claude-opus-5', effort: 'high', cacheRead: 10_000, ts: '2026-08-20T10:01:00Z' })
    const sub = turn({ id: 's1', requestId: 'rs1', model: 'claude-sonnet-5', effort: 'low', input: M, ts: '2026-08-20T10:05:00Z', sidechain: true })

    it('adds subagent spend to the session cost and tokens, and reports it separately', async () => {
      const { tuning } = await scan(lane, { 'subagents/agent-a.jsonl': sub })
      const row = tuning.bySession[0]
      expect(row.subagentTokens).toBe(M)
      expect(row.subagentCost).toBeCloseTo(2, 9)
      expect(row.tokens).toBe(210_000 + M)
      expect(row.cost).toBeCloseTo(210_000 * 0.5 / M + 2, 9)
      expect(tuning.totalCost).toBeCloseTo(row.cost, 9)
      expect(row.lastTsMs).toBe(Date.parse('2026-08-20T10:05:00Z'))
    })

    it('leaves turns, context stats, model and effort to the lane’s own turns', async () => {
      const without = (await scan(lane, {})).tuning.bySession[0]
      const withSub = (await scan(lane, { 'subagents/agent-a.jsonl': sub })).tuning.bySession[0]
      for (const k of ['turns', 'highContextTurns', 'medianContext', 'model', 'effort'] as const) expect(withSub[k]).toBe(without[k])
      expect(withSub.model).toBe('claude-opus-5')
      expect(withSub.effort).toBe('high')
      expect(withSub.turns).toBe(2)
    })

    it('counts subagent records in byModel, byProject and byEffort at their own effort', async () => {
      const { tuning } = await scan(lane, { 'subagents/agent-a.jsonl': sub })
      expect(tuning.byModel.map((m) => m.model).sort()).toEqual(['claude-opus-5', 'claude-sonnet-5'])
      expect(tuning.byProject[0].cost).toBeCloseTo(tuning.totalCost, 9)
      expect(tuning.byProject[0].messages).toBe(3)
      const low = tuning.byEffort.find((e) => e.effort === 'low')!
      expect(low).toMatchObject({ model: 'claude-sonnet-5', turns: 1, tokens: M })
      expect(tuning.byEffort.reduce((n, e) => n + e.cost, 0)).toBeCloseTo(tuning.totalCost, 9)
    })

    it('gives a session with only subagent records a row with no lane model', async () => {
      const { tuning } = await scan('', { 'subagents/agent-a.jsonl': sub })
      expect(tuning.bySession[0]).toMatchObject({ model: '', turns: 0, subagentTokens: M, tokens: M })
    })
  })
})

describe('per-file parse cache', () => {
  // Each transcript is parsed once and reused while its size and mtime are unchanged; the merged
  // result expires after 30 s. Both are exercised by moving the clock past that.
  it('re-reads a file that grew, and reuses one whose size and mtime did not change', async () => {
    const file = join(PROJ, 'cached.jsonl')
    // A whole-second mtime, so putting it back below restores it exactly (APFS keeps nanoseconds).
    const T = 1_790_000_000
    writeFileSync(file, turn({ id: 'a', requestId: 'ra', input: 100 }))
    utimesSync(file, T, T)
    vi.resetModules()
    const mod = await import('./usage')
    expect((await mod.computeUsage(0)).totalTokens).toBe(100)

    const now = Date.now()
    const later = (ms: number) => vi.spyOn(Date, 'now').mockReturnValue(now + ms)
    try {
      // Same length, different tokens, mtime put back: the cached parse is the one used.
      writeFileSync(file, turn({ id: 'a', requestId: 'ra', input: 900 }))
      utimesSync(file, T, T)
      later(31_000)
      expect((await mod.computeUsage(0)).totalTokens).toBe(100)

      appendFileSync(file, turn({ id: 'b', requestId: 'rb', input: 5 }))
      later(62_000)
      expect((await mod.computeUsage(0)).totalTokens).toBe(905)
    } finally {
      vi.restoreAllMocks()
      rmSync(file)
    }
  })
})
