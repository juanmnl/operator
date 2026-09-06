import { describe, it, expect } from 'vitest'
import type { Project, SavedSession, SessionUsage, ToolOutputStats } from '../../shared/types'
import {
  joinLanes, biggestChange, stepDown, slugToPath, cacheHealth,
  formatTokens, formatChars, DOMINANT_SHARE, UNATTRIBUTED, type LaneRow,
} from './tuning'

const sess = (o: Partial<SessionUsage> & { session: string }): SessionUsage => ({
  slug: '-Users-dev-proj', model: 'claude-opus-4-20250514', tokens: 1000, cost: 1, turns: 10,
  highContextTurns: 0, medianContext: 1000, compactions: 0, reReadTokens: 0, droppedTokens: 0,
  firstTsMs: 0, lastTsMs: 0, ...o,
})

const saved = (o: Partial<SavedSession> & { id: string }): SavedSession => ({
  cwd: '/Users/dev/proj', createdAt: '', ...o,
} as SavedSession)

const project = (roster: Project['roster']): Project => ({
  id: 'p1', name: 'proj', path: '/Users/dev/proj', createdAt: '', roster,
} as Project)

const ROSTER = [
  { id: 'code', name: 'Code', model: 'opus', effort: 'high' as const, accent: '#7ee787' },
  { id: 'qa', name: 'QA', model: 'sonnet', accent: '#5ac8fa' },
]

describe('joinLanes — the lookup, never a guess', () => {
  it('joins a transcript to its lane by the Claude session uuid', () => {
    const rows = joinLanes({
      bySession: [sess({ session: 'u1', tokens: 5000, effort: 'high' })],
      byEffort: [], toolOutput: [],
      projects: [project(ROSTER)],
      saved: [saved({ id: 's', claudeSessionId: 'u1', roleId: 'code', projectId: 'p1' })],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('Code')
    expect(rows[0].projectName).toBe('proj')
    expect(rows[0].accent).toBe('#7ee787')
    expect(rows[0].share).toBe(1)
  })

  it('sums several sessions of one lane into a single row', () => {
    const rows = joinLanes({
      bySession: [sess({ session: 'u1', tokens: 1000 }), sess({ session: 'u2', tokens: 3000 })],
      byEffort: [], toolOutput: [],
      projects: [project(ROSTER)],
      saved: [
        saved({ id: 'a', claudeSessionId: 'u1', roleId: 'code', projectId: 'p1' }),
        saved({ id: 'b', claudeSessionId: 'u2', roleId: 'code', projectId: 'p1' }),
      ],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].tokens).toBe(4000)
    expect(rows[0].sessions.sort()).toEqual(['u1', 'u2'])
  })

  it('makes an unclaimed transcript its OWN row rather than folding it into a lane', () => {
    // Folding would inflate whichever lane was nearest; dropping would make the shares not sum.
    const rows = joinLanes({
      bySession: [
        sess({ session: 'mine', tokens: 6000 }),
        sess({ session: 'stranger', tokens: 4000, slug: '-Users-dev-other' }),
      ],
      byEffort: [], toolOutput: [],
      projects: [project(ROSTER)],
      saved: [saved({ id: 'a', claudeSessionId: 'mine', roleId: 'code', projectId: 'p1' })],
    })
    const un = rows.find((r) => r.key === UNATTRIBUTED)!
    expect(un.tokens).toBe(4000)
    expect(un.name).toBe('Not attributed')
    // The shares still sum to 1.
    expect(rows.reduce((n, r) => n + r.share, 0)).toBeCloseTo(1)
  })

  it('sorts the unattributed row LAST, whatever its size', () => {
    const rows = joinLanes({
      bySession: [
        sess({ session: 'mine', tokens: 100 }),
        sess({ session: 'stranger', tokens: 900_000, slug: '-Users-dev-other' }),
      ],
      byEffort: [], toolOutput: [],
      projects: [project(ROSTER)],
      saved: [saved({ id: 'a', claudeSessionId: 'mine', roleId: 'code', projectId: 'p1' })],
    })
    expect(rows[rows.length - 1].key).toBe(UNATTRIBUTED)
  })

  it('recovers the project AND the role via cwd when the uuid has rolled', () => {
    // `claudeSessionId` is "latest seen", so a resumed lane loses its earlier uuids — which is
    // the whole reason the cwd pass exists. It used to read the role from the uuid match only,
    // throwing away the roleId the cwd match had already found and sending a resumed lane to the
    // unattributed row while its own saved session sat there naming it. The cwd match is weaker
    // about WHICH lane, not about what that lane is.
    const rows = joinLanes({
      bySession: [sess({ session: 'rolled-uuid', slug: '-Users-dev-proj', tokens: 2000 })],
      byEffort: [], toolOutput: [],
      projects: [project(ROSTER)],
      saved: [saved({ id: 'a', claudeSessionId: 'some-other-uuid', roleId: 'code', projectId: 'p1' })],
    })
    expect(rows[0].projectName).toBe('proj')
    expect(rows[0].roleId).toBe('code')
    expect(rows[0].name).toBe('Code')
    expect(rows[0].key).not.toBe(UNATTRIBUTED)
  })

  it('the Not attributed row never wears a project name', () => {
    // It used to fall back to the slug's last path segment, so a transcript nothing claimed was
    // labelled with a real project — which reads as "this project's lane", the one thing the row
    // exists not to say.
    const rows = joinLanes({
      bySession: [sess({ session: 'stranger', slug: '-Users-dev-someproject', tokens: 4000 })],
      byEffort: [], toolOutput: [], projects: [], saved: [],
    })
    expect(rows[0].key).toBe(UNATTRIBUTED)
    expect(rows[0].name).toBe('Not attributed')
    expect(rows[0].projectName).toBe('—')
  })

  it('carries the roster pin beside the running effort, so a mid-session change is visible', () => {
    const rows = joinLanes({
      bySession: [sess({ session: 'u1', effort: 'low' })],
      byEffort: [], toolOutput: [],
      projects: [project(ROSTER)],
      saved: [saved({ id: 'a', claudeSessionId: 'u1', roleId: 'code', projectId: 'p1' })],
    })
    expect(rows[0].effort).toBe('low')       // what actually ran
    expect(rows[0].pinnedEffort).toBe('high') // what the roster would launch
    expect(rows[0].effortInherited).toBe(false)
  })

  it('marks an inherited pin as inherited', () => {
    const rows = joinLanes({
      bySession: [sess({ session: 'u1' })],
      byEffort: [], toolOutput: [],
      projects: [project(ROSTER)],
      saved: [saved({ id: 'a', claudeSessionId: 'u1', roleId: 'qa', projectId: 'p1' })],
    })
    expect(rows[0].effortInherited).toBe(true)
  })

  it('attaches tool percentiles to the lane', () => {
    const tools: ToolOutputStats[] = [
      { session: 'u1', p50: 2100, p90: 96_000, totalChars: 500_000, calls: 40, topTool: 'Bash', topToolChars: 400_000 },
    ]
    const rows = joinLanes({
      bySession: [sess({ session: 'u1' })],
      byEffort: [], toolOutput: tools,
      projects: [project(ROSTER)],
      saved: [saved({ id: 'a', claudeSessionId: 'u1', roleId: 'code', projectId: 'p1' })],
    })
    expect(rows[0].toolP50).toBe(2100)
    expect(rows[0].toolP90).toBe(96_000)
    expect(rows[0].topTool).toBe('Bash')
  })

  it('adds compaction and context stats across a lane’s sessions', () => {
    const rows = joinLanes({
      bySession: [
        sess({ session: 'u1', compactions: 2, reReadTokens: 40_000, highContextTurns: 3 }),
        sess({ session: 'u2', compactions: 1, reReadTokens: 10_000, highContextTurns: 1 }),
      ],
      byEffort: [], toolOutput: [],
      projects: [project(ROSTER)],
      saved: [
        saved({ id: 'a', claudeSessionId: 'u1', roleId: 'code', projectId: 'p1' }),
        saved({ id: 'b', claudeSessionId: 'u2', roleId: 'code', projectId: 'p1' }),
      ],
    })
    expect(rows[0].compactions).toBe(3)
    expect(rows[0].reReadTokens).toBe(50_000)
    expect(rows[0].highContextTurns).toBe(4)
  })

  // Review-2 blocker B. `bySession` arrives sorted by TOKENS, so "latest wins" written as
  // last-writer-wins described the BIGGEST session — a lane long since moved from Opus/xhigh to
  // Sonnet/medium was still reported, and argued about, at its old settings.
  it('takes the model and effort of the NEWEST session, not the biggest', () => {
    const rows = joinLanes({
      bySession: [
        // Bigger, older, and first in the array — exactly the order the engine produces.
        sess({ session: 'big-old', tokens: 900_000, model: 'claude-opus-4-20250514', effort: 'xhigh', lastTsMs: 1_000 }),
        sess({ session: 'small-new', tokens: 1_000, model: 'claude-sonnet-4-20250514', effort: 'medium', lastTsMs: 9_000 }),
      ],
      byEffort: [], toolOutput: [],
      projects: [project(ROSTER)],
      saved: [
        saved({ id: 'a', claudeSessionId: 'big-old', roleId: 'code', projectId: 'p1' }),
        saved({ id: 'b', claudeSessionId: 'small-new', roleId: 'code', projectId: 'p1' }),
      ],
    })
    expect(rows[0].model).toBe('claude-sonnet-4-20250514')
    expect(rows[0].effort).toBe('medium')
    expect(rows[0].lastTsMs).toBe(9_000)
    // …and the tokens are still the SUM. Only the description follows the newest session.
    expect(rows[0].tokens).toBe(901_000)
  })

  it('is order-independent — the newest wins whichever way the engine sorted', () => {
    const mk = (order: 'big-first' | 'new-first') => joinLanes({
      bySession: order === 'big-first'
        ? [sess({ session: 'a', tokens: 900_000, effort: 'xhigh', lastTsMs: 1 }), sess({ session: 'b', tokens: 1, effort: 'low', lastTsMs: 9 })]
        : [sess({ session: 'b', tokens: 1, effort: 'low', lastTsMs: 9 }), sess({ session: 'a', tokens: 900_000, effort: 'xhigh', lastTsMs: 1 })],
      byEffort: [], toolOutput: [],
      projects: [project(ROSTER)],
      saved: [
        saved({ id: 'x', claudeSessionId: 'a', roleId: 'code', projectId: 'p1' }),
        saved({ id: 'y', claudeSessionId: 'b', roleId: 'code', projectId: 'p1' }),
      ],
    })
    expect(mk('big-first')[0].effort).toBe('low')
    expect(mk('new-first')[0].effort).toBe('low')
  })

  it('answers an empty window with no rows and no division by zero', () => {
    expect(joinLanes({ bySession: [], byEffort: [], toolOutput: [], projects: [], saved: [] })).toEqual([])
  })
})

// THE FIRING RULES. This is the difference between a page that is trusted and one that always
// finds something, so each branch is pinned rather than left to a reviewer's eye.
describe('biggestChange — what the card is allowed to say', () => {
  const lane = (o: Partial<LaneRow> & { name: string; share: number }): LaneRow => ({
    key: o.name, projectName: 'proj', model: 'claude-opus-4-20250514', effortInherited: false,
    tokens: Math.round(o.share * 1e7), cost: 1, turns: 40, compactions: 0, reReadTokens: 0,
    highContextTurns: 0, medianContext: 0, toolP50: 0, toolP90: 0, sessions: [], lastTsMs: 0, ...o,
  })

  it('FIRES when the top lane is over the threshold and a step exists', () => {
    const card = biggestChange([lane({ name: 'Review', share: 0.38, effort: 'xhigh' }), lane({ name: 'Code', share: 0.2 })], 7)
    expect(card.kind).toBe('change')
    expect(card.step).toEqual({ from: 'xhigh', to: 'high' })
    expect(card.headline).toContain('Review')
    expect(card.headline).toContain('38%')
    // The suggestion names the rung it is proposing, spelled the way the UI spells it.
    expect(card.detail).toContain('one step to High')
  })

  it('DOES NOT fire at or below the threshold — the honest version instead', () => {
    const card = biggestChange([lane({ name: 'Code', share: DOMINANT_SHARE, effort: 'high' })], 7)
    expect(card.kind).toBe('nothing')
    expect(card.headline).toBe('Nothing stands out.')
    expect(card.detail).toContain('Code')
    expect(card.detail).toContain('25%')
  })

  it('DOES NOT fire when the lane is already at the bottom of the ladder', () => {
    const card = biggestChange([lane({ name: 'Code', share: 0.9, effort: 'low' })], 7)
    expect(card.kind).toBe('nothing')
    expect(card.detail).toContain('already at Low')
  })

  it('NEVER claims a saving, in tokens or dollars', () => {
    // A step down the ladder has no known multiplier; inventing one would be the same class of
    // error as showing 0% for a number that is absent. It ranks, it does not forecast.
    for (const share of [0.3, 0.5, 0.9]) {
      const card = biggestChange([lane({ name: 'Review', share, effort: 'high' })], 7)
      const copy = `${card.headline} ${card.detail}`.toLowerCase()
      for (const word of ['save', 'saving', 'cheaper', 'reduce', 'would cost', '$']) {
        expect(copy).not.toContain(word)
      }
    }
  })

  it('says "more than the next two together" only when that is true', () => {
    const dominant = biggestChange([
      lane({ name: 'Review', share: 0.6, effort: 'high' }),
      lane({ name: 'Code', share: 0.2 }), lane({ name: 'QA', share: 0.2 }),
    ], 7)
    expect(dominant.detail).toContain('more than the next two lanes together')

    const notDominant = biggestChange([
      lane({ name: 'Review', share: 0.35, effort: 'high' }),
      lane({ name: 'Code', share: 0.33 }), lane({ name: 'QA', share: 0.32 }),
    ], 7)
    expect(notDominant.detail).not.toContain('more than the next two')
  })

  it('never names the unattributed row as a lane to tune', () => {
    const card = biggestChange([
      { ...lane({ name: 'Not attributed', share: 0.9 }), key: UNATTRIBUTED },
      lane({ name: 'Code', share: 0.1, effort: 'high' }),
    ], 7)
    expect(card.lane?.name).toBe('Code')
  })

  it('says nothing ran when the window is empty', () => {
    const card = biggestChange([], 7)
    expect(card.kind).toBe('nothing')
    expect(card.headline).toContain('Nothing ran')
    expect(card.detail).toContain('Widen the range')
  })

  it('names the window in the reader’s words', () => {
    expect(biggestChange([lane({ name: 'R', share: 0.5, effort: 'high' })], 1).headline).toContain('today')
    expect(biggestChange([lane({ name: 'R', share: 0.5, effort: 'high' })], 30).headline).toContain('the last 30 days')
  })

  it('falls back to the roster pin when the transcript reported no effort', () => {
    const card = biggestChange([lane({ name: 'R', share: 0.5, effort: undefined, pinnedEffort: 'high' })], 7)
    expect(card.kind).toBe('change')
    expect(card.step).toEqual({ from: 'high', to: 'medium' })
  })
})

describe('stepDown — one rung, and only on the effort ladder', () => {
  it('walks the ladder down', () => {
    expect(stepDown('max')).toBe('xhigh')
    expect(stepDown('xhigh')).toBe('high')
    expect(stepDown('high')).toBe('medium')
    expect(stepDown('medium')).toBe('low')
  })
  it('stops at the bottom and refuses what it does not recognise', () => {
    expect(stepDown('low')).toBeNull()
    expect(stepDown(undefined)).toBeNull()
    expect(stepDown('normal')).toBeNull() // the legacy value that was never a Claude Code level
  })
})

describe('formatting', () => {
  it('renders tokens as the headline unit, never eight bare digits', () => {
    expect(formatTokens(12_400_000)).toBe('12.4M')
    expect(formatTokens(938_000)).toBe('938k')
    expect(formatTokens(1500)).toBe('1.5k')
    expect(formatTokens(412)).toBe('412')
  })
  it('renders tool characters compactly', () => {
    expect(formatChars(96_000)).toBe('96k')
    expect(formatChars(2100)).toBe('2k')
    expect(formatChars(140)).toBe('140')
  })
})

describe('slugToPath', () => {
  it('inverts Claude Code’s cwd slug', () => {
    expect(slugToPath('-Users-dev-thing')).toBe('/Users/dev/thing')
  })
})

describe('cacheHealth — a judgement, stated rather than tuned invisibly', () => {
  it('calls a high read share healthy and a low one low', () => {
    expect(cacheHealth(0.8, 1e6)).toBe('healthy')
    expect(cacheHealth(0.2, 1e6)).toBe('low')
  })
  it('refuses to judge a model with no real volume', () => {
    // Three calls reading 0% mean nothing by it.
    expect(cacheHealth(0, 1000)).toBe('thin')
  })
})
