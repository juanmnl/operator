import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = mkdtempSync(join(tmpdir(), 'operator-tuning-'))
process.env.HOME = SANDBOX
process.env.OPERATOR_DIR = join(SANDBOX, 'operator-home')
const { computeTuning, resetUsageCache, percentile, median } = await import('./usage')

afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

const PROJECTS = join(SANDBOX, '.claude', 'projects')
const TODAY = new Date().toISOString()

/** An assistant record in the shape the real transcripts carry — `effort` is a TOP-LEVEL sibling
 *  of `timestamp`, not a field inside `message`. Measured across 300 real transcripts: present on
 *  68,972 of 69,022 assistant records, values `high` / `medium` / `low`. */
const assistant = (o: {
  id: string; model?: string; effort?: string; input?: number; output?: number
  cacheRead?: number; ts?: string
}) => JSON.stringify({
  type: 'assistant',
  timestamp: o.ts ?? TODAY,
  effort: o.effort,
  requestId: `req-${o.id}`,
  message: {
    id: o.id,
    model: o.model ?? 'claude-opus-4-20250514',
    usage: {
      input_tokens: o.input ?? 100,
      output_tokens: o.output ?? 10,
      cache_read_input_tokens: o.cacheRead ?? 0,
      cache_creation_input_tokens: 0,
    },
  },
})

/** A compaction boundary, transcribed from a real one
 *  (`~/.claude/projects/…/981a9e3b….jsonl`): the metadata block carries `durationMs`, so the
 *  record is written when the compaction has FINISHED. */
const boundary = (pre: number, post: number, ts = TODAY) => JSON.stringify({
  type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', level: 'info',
  timestamp: ts,
  compactMetadata: { trigger: 'auto', preTokens: pre, postTokens: post, durationMs: 133798 },
})

function write(slug: string, session: string, lines: string[]): void {
  mkdirSync(join(PROJECTS, slug), { recursive: true })
  writeFileSync(join(PROJECTS, slug, `${session}.jsonl`), `${lines.join('\n')}\n`)
}

beforeEach(() => {
  rmSync(PROJECTS, { recursive: true, force: true })
  resetUsageCache()
})

describe('effort, per record', () => {
  it('carries the transcript’s own effort onto the session', async () => {
    write('-Users-dev-a', 's1', [assistant({ id: 'm1', effort: 'high' })])
    const t = await computeTuning(7)
    expect(t.bySession[0].effort).toBe('high')
  })

  it('splits one session into a row per (model, effort) it actually ran at', async () => {
    // The case an averaged row would describe wrongly: half the window on High, half on Medium.
    write('-Users-dev-a', 's1', [
      assistant({ id: 'm1', effort: 'high', input: 1000 }),
      assistant({ id: 'm2', effort: 'high', input: 1000 }),
      assistant({ id: 'm3', effort: 'medium', input: 500 }),
    ])
    const t = await computeTuning(7)
    expect(t.byEffort).toHaveLength(2)
    const high = t.byEffort.find((e) => e.effort === 'high')!
    const med = t.byEffort.find((e) => e.effort === 'medium')!
    expect(high.turns).toBe(2)
    expect(med.turns).toBe(1)
    expect(high.tokens).toBeGreaterThan(med.tokens)
  })

  it('keeps the LATEST effort on the session row, not the first', async () => {
    write('-Users-dev-a', 's1', [
      assistant({ id: 'm1', effort: 'high', ts: '2026-09-05T10:00:00.000Z' }),
      assistant({ id: 'm2', effort: 'low', ts: '2026-09-05T11:00:00.000Z' }),
    ])
    const t = await computeTuning(0)
    expect(t.bySession[0].effort).toBe('low')
  })

  it('omits a record with no effort from the split rather than inventing one', async () => {
    write('-Users-dev-a', 's1', [assistant({ id: 'm1' })])
    const t = await computeTuning(7)
    expect(t.byEffort).toEqual([])
    expect(t.bySession[0].effort).toBeUndefined()
    // …but the tokens are still counted. An unknown effort is not an unknown turn.
    expect(t.bySession[0].tokens).toBeGreaterThan(0)
  })
})

describe('compaction', () => {
  it('counts boundaries and sums what was re-read and what was dropped', async () => {
    write('-Users-dev-a', 's1', [
      assistant({ id: 'm1', effort: 'high' }),
      boundary(998698, 21681),
      boundary(500000, 20000),
    ])
    const t = await computeTuning(7)
    const s = t.bySession.find((x) => x.session === 's1')!
    expect(s.compactions).toBe(2)
    // Re-read is `postTokens` — what the model must read again on the next turn.
    expect(s.reReadTokens).toBe(21681 + 20000)
    // Dropped is the difference, which is what compaction actually threw away.
    expect(s.droppedTokens).toBe((998698 - 21681) + (500000 - 20000))
  })

  it('gives a session whose only record is a boundary its own row', async () => {
    // It compacted, which is exactly what this page exists to show. Dropping it because it has
    // no usage record in the window would make the column lie by omission.
    write('-Users-dev-a', 's-quiet', [boundary(400000, 30000)])
    const t = await computeTuning(7)
    const s = t.bySession.find((x) => x.session === 's-quiet')!
    expect(s.compactions).toBe(1)
    expect(s.tokens).toBe(0)
  })

  it('never reports negative dropped tokens when post exceeds pre', async () => {
    write('-Users-dev-a', 's1', [boundary(100, 500)])
    const t = await computeTuning(7)
    expect(t.bySession[0].droppedTokens).toBe(0)
  })

  it('respects the window — an old boundary is not counted', async () => {
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString()
    write('-Users-dev-a', 's1', [assistant({ id: 'm1' }), boundary(900, 100, old)])
    const t = await computeTuning(7)
    expect(t.bySession[0].compactions).toBe(0)
  })

  it('does not mistake another system record for a compaction', async () => {
    write('-Users-dev-a', 's1', [
      assistant({ id: 'm1' }),
      JSON.stringify({ type: 'system', subtype: 'hook_result', timestamp: TODAY }),
    ])
    const t = await computeTuning(7)
    expect(t.bySession[0].compactions).toBe(0)
  })
})

describe('per-session context stats', () => {
  it('reports a MEDIAN context, so one huge turn does not describe the lane', async () => {
    write('-Users-dev-a', 's1', [
      assistant({ id: 'm1', input: 1000, cacheRead: 0 }),
      assistant({ id: 'm2', input: 2000, cacheRead: 0 }),
      assistant({ id: 'm3', input: 900_000, cacheRead: 0 }),
    ])
    const t = await computeTuning(7)
    const s = t.bySession[0]
    // Median of 1000 / 2000 / 900000 is 2000. A mean would have been ~301k and described no turn.
    expect(s.medianContext).toBe(2000)
  })

  it('counts turns over 150k rather than folding them into one global percentage', async () => {
    write('-Users-dev-a', 's1', [
      assistant({ id: 'm1', input: 10_000 }),
      assistant({ id: 'm2', input: 200_000 }),
      assistant({ id: 'm3', input: 300_000 }),
    ])
    const t = await computeTuning(7)
    expect(t.bySession[0].highContextTurns).toBe(2)
    expect(t.bySession[0].turns).toBe(3)
  })

  it('keeps sessions apart instead of pooling them', async () => {
    write('-Users-dev-a', 's1', [assistant({ id: 'm1', input: 200_000 })])
    write('-Users-dev-b', 's2', [assistant({ id: 'm2', input: 1000 })])
    const t = await computeTuning(7)
    expect(t.bySession.find((s) => s.session === 's1')!.highContextTurns).toBe(1)
    expect(t.bySession.find((s) => s.session === 's2')!.highContextTurns).toBe(0)
  })
})

describe('windowing and totals', () => {
  it('excludes records older than the window', async () => {
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString()
    write('-Users-dev-a', 's1', [assistant({ id: 'm1', ts: old }), assistant({ id: 'm2' })])
    expect((await computeTuning(7)).bySession[0].turns).toBe(1)
    resetUsageCache()
    expect((await computeTuning(0)).bySession[0].turns).toBe(2)
  })

  it('dedupes a message re-emitted as its turn streams', async () => {
    // Without this the totals are several times the truth — the same guard the other folds use.
    write('-Users-dev-a', 's1', [assistant({ id: 'same' }), assistant({ id: 'same' })])
    expect((await computeTuning(7)).bySession[0].turns).toBe(1)
  })

  it('groups projects by slug and orders lanes by tokens', async () => {
    write('-Users-dev-a', 's1', [assistant({ id: 'm1', input: 100 })])
    write('-Users-dev-b', 's2', [assistant({ id: 'm2', input: 50_000 })])
    const t = await computeTuning(7)
    expect(t.bySession[0].session).toBe('s2')
    expect(t.byProject[0].slug).toBe('-Users-dev-b')
    expect(t.byProject.map((p) => p.name)).toContain('b')
  })

  it('answers an empty window without throwing', async () => {
    const t = await computeTuning(7)
    expect(t.bySession).toEqual([])
    expect(t.totalTokens).toBe(0)
  })
})

describe('percentile and median', () => {
  it('takes the nearest rank, so p50 and p90 are real observations', () => {
    const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    expect(percentile(s, 50)).toBe(5)
    expect(percentile(s, 90)).toBe(9)
    expect(percentile(s, 100)).toBe(10)
  })

  it('answers 0 for an empty set rather than NaN — a lane with no calls has no p90', () => {
    expect(percentile([], 90)).toBe(0)
    expect(median([])).toBe(0)
  })

  it('separates a spiky distribution from a flat one, which a mean would not', () => {
    // The finding the design is after: p50 2.1k / p90 96k is one turn in ten swallowing half a
    // context window, and the mean of that set describes neither turn.
    const spiky = [2100, 2100, 2100, 2100, 2100, 2100, 2100, 2100, 2100, 96_000]
    expect(percentile(spiky, 50)).toBe(2100)
    expect(percentile(spiky, 90)).toBe(2100)
    expect(percentile(spiky, 100)).toBe(96_000)
  })

  it('averages the two middle values for an even-length median', () => {
    expect(median([1, 2, 3, 4])).toBe(3) // (2+3)/2 = 2.5, rounded
    expect(median([10, 20])).toBe(15)
  })

  it('does not mutate the caller’s array', () => {
    const xs = [3, 1, 2]
    median(xs)
    expect(xs).toEqual([3, 1, 2])
  })
})
