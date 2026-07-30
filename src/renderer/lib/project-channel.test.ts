import { describe, it, expect } from 'vitest'
import type { DispatchRecord, ProjectReply, Role } from '../../shared/types'
import {
  buildChannelFeed, chipForOutcome, unreadEntries, groupByDay, channelInitials, REPLY_CHIP,
} from './project-channel'

const roster: Role[] = [
  { id: 'operator', name: 'Operator', model: 'fable', accent: '#c98bff' },
  { id: 'code', name: 'Code', model: 'opus', accent: '#7ee787' },
  { id: 'research', name: 'Research', model: 'sonnet', accent: '#5ac8fa' },
]
const d = (o: Partial<DispatchRecord> = {}): DispatchRecord => ({
  id: o.id ?? crypto.randomUUID(),
  at: '2026-07-30T10:00:00.000Z',
  task: 'do the thing',
  outcome: 'sent',
  ...o,
})
const r = (o: Partial<ProjectReply> = {}): ProjectReply => ({
  // The content-hash id the tailer computes — carried so a delivery outcome recorded against a
  // live reply still matches the same row after a reload.
  id: 'reply-1',
  sessionId: 'sess-code',
  to: 'operator',
  text: 'done',
  timestamp: '2026-07-30T10:00:30.000Z',
  ...o,
})
const sessions = [{ id: 'sess-code', roleId: 'code' }, { id: 'sess-res', roleId: 'research' }]

describe('chipForOutcome — derived, never invented', () => {
  it('maps each outcome to exactly one chip', () => {
    expect(chipForOutcome('sent')).toEqual({ label: 'delivered', tone: 'accent' })
    expect(chipForOutcome('launched')).toEqual({ label: 'delivered', tone: 'accent' })
    expect(chipForOutcome('queued')).toEqual({ label: 'queued · behind current task', tone: 'progress' })
    expect(chipForOutcome('rejected')).toEqual({ label: 'declined', tone: 'muted' })
    expect(chipForOutcome('unassigned')).toEqual({ label: 'no matching lane', tone: 'muted' })
  })

  it('marks ONLY a held dispatch actionable', () => {
    expect(chipForOutcome('pending-approval')).toEqual({
      label: 'held · needs your approval', tone: 'warn', actionable: true,
    })
    for (const o of ['sent', 'launched', 'queued', 'rejected', 'unassigned'] as const) {
      expect(chipForOutcome(o).actionable).toBeUndefined()
    }
  })

  it('shows an unknown future outcome verbatim rather than mislabelling it', () => {
    expect(chipForOutcome('something-new' as DispatchRecord['outcome']))
      .toEqual({ label: 'something-new', tone: 'muted' })
  })
})

describe('buildChannelFeed', () => {
  it('interleaves dispatches and replies by timestamp, ascending', () => {
    const feed = buildChannelFeed(
      [
        d({ id: 'a', at: '2026-07-30T10:00:00.000Z', fromRoleId: 'operator', toRoleId: 'code', task: 'first' }),
        d({ id: 'c', at: '2026-07-30T12:00:00.000Z', fromRoleId: 'operator', toRoleId: 'code', task: 'third' }),
      ],
      [r({ timestamp: '2026-07-30T11:00:00.000Z', text: 'second' })],
      roster, sessions,
    )
    expect(feed.map((e) => e.text)).toEqual(['first', 'second', 'third'])
    expect(feed.map((e) => e.kind)).toEqual(['dispatch', 'reply', 'dispatch'])
  })

  it('orders totally — two entries in the same second do not reshuffle', () => {
    const at = '2026-07-30T10:00:00.000Z'
    const once = buildChannelFeed([d({ id: 'b', at }), d({ id: 'a', at })], [], roster, sessions)
    const twice = buildChannelFeed([d({ id: 'a', at }), d({ id: 'b', at })], [], roster, sessions)
    expect(once.map((e) => e.id)).toEqual(twice.map((e) => e.id))
  })

  it('resolves a dispatch against the roster', () => {
    const [e] = buildChannelFeed([d({ fromRoleId: 'operator', toRoleId: 'code' })], [], roster, sessions)
    expect(e.authorLabel).toBe('Operator')
    expect(e.targetLabel).toBe('Code')
    expect(e.authorRole?.accent).toBe('#c98bff')
  })

  it('resolves a reply through its SESSION, which carries no roleId of its own', () => {
    const [e] = buildChannelFeed([], [r({ sessionId: 'sess-code', to: 'operator' })], roster, sessions)
    expect(e.authorLabel).toBe('Code')
    expect(e.targetLabel).toBe('Operator')
    expect(e.chip).toEqual(REPLY_CHIP)
  })

  it('prints the raw id when a reply session no longer resolves — never blank, never guessed', () => {
    const [e] = buildChannelFeed([], [r({ sessionId: 'sess-vanished' })], roster, sessions)
    expect(e.authorLabel).toBe('sess-vanished')
    expect(e.authorRole).toBeUndefined()
  })

  it('treats `project` as a broadcast — addressed to the room, not a lane', () => {
    const [e] = buildChannelFeed([], [r({ to: 'project' })], roster, sessions)
    expect(e.targetLabel).toBeNull()
  })

  it('keeps an unroutable dispatch target readable', () => {
    const [none] = buildChannelFeed([d({ fromRoleId: 'operator', outcome: 'unassigned' })], [], roster, sessions)
    expect(none.targetLabel).toBeNull()
    const [raw] = buildChannelFeed([d({ fromRoleId: 'operator', toRoleId: 'ghost' })], [], roster, sessions)
    expect(raw.targetLabel).toBe('ghost')
  })

  it('names an unidentified sender rather than blanking it', () => {
    const [e] = buildChannelFeed([d({ fromRoleId: undefined })], [], roster, sessions)
    expect(e.authorLabel).toBe('unknown lane')
  })

  it('handles empty and absent stores', () => {
    expect(buildChannelFeed(undefined, undefined, undefined, undefined)).toEqual([])
    expect(buildChannelFeed([], [], roster, sessions)).toEqual([])
  })
})

describe('unreadEntries', () => {
  const feed = buildChannelFeed(
    [
      d({ id: 'a', at: '2026-07-30T10:00:00.000Z' }),
      d({ id: 'b', at: '2026-07-30T11:00:00.000Z' }),
      d({ id: 'c', at: '2026-07-30T12:00:00.000Z' }),
    ], [], roster, sessions,
  )

  it('counts only entries NEWER than lastReadAt', () => {
    expect(unreadEntries(feed, '2026-07-30T11:00:00.000Z').map((e) => e.id)).toEqual(['dispatch:c'])
  })

  it('treats a never-read channel as entirely unread', () => {
    expect(unreadEntries(feed, null)).toHaveLength(3)
  })

  it('is empty once read up to the newest entry', () => {
    expect(unreadEntries(feed, '2026-07-30T12:00:00.000Z')).toEqual([])
  })
})

describe('groupByDay', () => {
  it('buckets consecutive days without reordering', () => {
    // The zone is now PINNED. This test used to pass a UTC-dated fixture and read the UTC bucket
    // back, which is the shape that passes against the bug the local-day fix exists for: with the
    // machine at UTC−5 these three instants are all the same local afternoon. Pinning UTC keeps
    // what the test was actually for — consecutive days separate, order preserved — and stops it
    // depending on wherever the runner happens to be.
    const feed = buildChannelFeed(
      [
        d({ id: 'a', at: '2026-07-29T23:00:00.000Z' }),
        d({ id: 'b', at: '2026-07-30T01:00:00.000Z' }),
        d({ id: 'c', at: '2026-07-30T02:00:00.000Z' }),
      ], [], roster, sessions,
    )
    const days = groupByDay(feed, 'UTC')
    expect(days.map((g) => [g.day, g.entries.length])).toEqual([['2026-07-29', 1], ['2026-07-30', 2]])
  })
})

describe('channelInitials', () => {
  it('takes two letters from a lane name or a raw id', () => {
    expect(channelInitials('Operator')).toBe('OP')
    expect(channelInitials('el-encanto')).toBe('EE')
    expect(channelInitials('QA')).toBe('QA')
    expect(channelInitials('FastTrack')).toBe('FT')
    expect(channelInitials('')).toBe('?')
  })
})

describe('a HUMAN message in the feed', () => {
  it('renders as `You →`, never as a lane, and borrows no lane accent', () => {
    // Provenance is the whole reason `fromHuman` exists: on the wire a channel message and the
    // user typing into a pty are the same `user` turn, so the record is the only place it lives.
    const [e] = buildChannelFeed(
      [d({ fromHuman: true, toRoleId: 'code', task: 'have a look at this', outcome: 'sent' })],
      [], roster, sessions,
    )
    expect(e.fromHuman).toBe(true)
    expect(e.authorLabel).toBe('You')
    expect(e.authorRole).toBeUndefined()
    expect(e.targetLabel).toBe('Code')
    expect(e.chip.label).toBe('delivered')
  })

  it('is not confused with a lane that happens to have fromRoleId set', () => {
    const [human] = buildChannelFeed([d({ fromHuman: true, fromRoleId: 'code' })], [], roster, sessions)
    expect(human.authorLabel).toBe('You') // fromHuman wins; fromRoleId is not consulted
  })

  it('survives a projects.json round-trip', () => {
    // Project is opaque JSON end-to-end, so the only risk is our own serialization.
    const rec = d({ fromHuman: true, groupId: 'g1', toRoleId: 'code' })
    const revived = JSON.parse(JSON.stringify({ dispatches: [rec] })).dispatches
    expect(revived[0].fromHuman).toBe(true)
    expect(revived[0].groupId).toBe('g1')
    expect(buildChannelFeed(revived, [], roster, sessions)[0].authorLabel).toBe('You')
  })

  it('collapses a fan-out into ONE row summarising its targets', () => {
    const at = '2026-07-30T10:00:00.000Z'
    const feed = buildChannelFeed([
      d({ id: 'f1', at, fromHuman: true, groupId: 'g', toRoleId: 'code', task: 'standup', outcome: 'sent' }),
      d({ id: 'f2', at, fromHuman: true, groupId: 'g', toRoleId: 'research', task: 'standup', outcome: 'sent' }),
      d({ id: 'f3', at, fromHuman: true, groupId: 'g', toRoleId: 'operator', task: 'standup', outcome: 'queued' }),
    ], [], roster, sessions)
    expect(feed).toHaveLength(1)
    expect(feed[0].id).toBe('group:g')
    expect(feed[0].targetLabel).toBe('everyone')
    expect(feed[0].chip.label).toBe('delivered 2/3 · 1 queued')
    expect(feed[0].group?.records).toHaveLength(3) // expandable per target
  })

  it('keeps a fan-out row in time order beside ungrouped entries', () => {
    const feed = buildChannelFeed([
      d({ id: 'a', at: '2026-07-30T09:00:00.000Z', fromRoleId: 'operator', toRoleId: 'code', task: 'before' }),
      d({ id: 'f1', at: '2026-07-30T10:00:00.000Z', fromHuman: true, groupId: 'g', toRoleId: 'code', task: 'fan' }),
      d({ id: 'f2', at: '2026-07-30T10:00:01.000Z', fromHuman: true, groupId: 'g', toRoleId: 'qa', task: 'fan' }),
      d({ id: 'z', at: '2026-07-30T11:00:00.000Z', fromRoleId: 'operator', toRoleId: 'code', task: 'after' }),
    ], [], roster, sessions)
    // The group sorts by its EARLIEST member, so it sits where the send happened.
    expect(feed.map((e) => e.text)).toEqual(['before', 'fan', 'after'])
  })
})

describe('agent→agent delivery, folded into the reply it belongs to', () => {
  // A reply and the attempt to hand it on are ONE event to a reader. Two rows would read as the
  // lane having said it twice, so the delivery record is metadata for the reply's row, not an entry.
  const reply = r({ id: 'h1', sessionId: 'sess-code', to: 'research', text: 'api contract changed' })
  const delivery = (outcome: DispatchRecord['outcome']) =>
    d({ id: 'dv1', at: '2026-07-30T10:00:31.000Z', fromRoleId: 'code', toRoleId: 'research', task: reply.text, outcome, replyId: 'h1' })

  it('renders ONE row, not two', () => {
    const feed = buildChannelFeed([delivery('sent')], [reply], roster, sessions)
    expect(feed).toHaveLength(1)
    expect(feed[0].kind).toBe('reply')
  })

  it('says it was delivered', () => {
    const [e] = buildChannelFeed([delivery('sent')], [reply], roster, sessions)
    expect(e.chip.label).toBe('posted · delivered')
  })

  it('names the brake that stopped it, so a halted chain never looks like being ignored', () => {
    const label = (o: DispatchRecord['outcome']) =>
      buildChannelFeed([delivery(o)], [reply], roster, sessions)[0].chip.label
    expect(label('hop-limit')).toBe('posted · chain limit reached')
    expect(label('pair-brake')).toBe('posted · pair sending too fast')
    expect(label('paused')).toBe('posted · agent↔agent paused')
    expect(label('queued')).toBe('posted · queued · behind current task')
  })

  it('never offers an Approve button — a brake is not a held dispatch', () => {
    for (const o of ['hop-limit', 'pair-brake', 'paused'] as const) {
      expect(buildChannelFeed([delivery(o)], [reply], roster, sessions)[0].chip.actionable).toBeUndefined()
    }
  })

  it('leaves an undelivered reply reading as merely posted', () => {
    // A broadcast, or any reply from before delivery existed. Absence of a record is not a failure.
    expect(buildChannelFeed([], [reply], roster, sessions)[0].chip).toEqual(REPLY_CHIP)
  })

  it('takes the NEWEST record when a reply somehow has two', () => {
    const feed = buildChannelFeed([
      delivery('pair-brake'),
      d({ id: 'dv2', at: '2026-07-30T10:09:00.000Z', fromRoleId: 'code', toRoleId: 'research', task: reply.text, outcome: 'sent', replyId: 'h1' }),
    ], [reply], roster, sessions)
    expect(feed).toHaveLength(1)
    expect(feed[0].chip.label).toBe('posted · delivered')
  })

  it('does not fold onto a DIFFERENT reply', () => {
    const other = r({ id: 'h2', text: 'unrelated', timestamp: '2026-07-30T10:05:00.000Z' })
    const feed = buildChannelFeed([delivery('hop-limit')], [reply, other], roster, sessions)
    expect(feed.map((e) => e.chip.label)).toEqual(['posted · chain limit reached', 'posted'])
  })

  it('is invisible to the fan-out collapse even if it carries a groupId', () => {
    // Belt: a delivery record is never a channel message of its own, whatever else is set on it.
    const feed = buildChannelFeed(
      [{ ...delivery('sent'), groupId: 'g' }], [reply], roster, sessions,
    )
    expect(feed).toHaveLength(1)
    expect(feed[0].kind).toBe('reply')
  })
})

describe('groupByDay buckets on the LOCAL day', () => {
  const GYE = 'America/Guayaquil' // UTC−5
  const entry = (id: string, at: string) => ({
    id, at, kind: 'dispatch' as const, authorLabel: 'Operator', accent: null,
    targetLabel: null, text: id, chip: { label: 'delivered', tone: 'accent' as const },
  })

  it('files an evening message under TODAY, not tomorrow', () => {
    // The bug that hides until 19:00: at UTC−5 these are 16:00 and 20:30 on the SAME local day,
    // but their UTC dates are the 30th and the 31st. The slice split them across a separator.
    const days = groupByDay([
      entry('afternoon', '2026-07-30T21:00:00.000Z'),
      entry('evening', '2026-07-31T01:30:00.000Z'),
    ], GYE)
    expect(days.length).toBe(1)
    expect(days[0].day).toBe('2026-07-30')
    expect(days[0].entries.map((e) => e.id)).toEqual(['afternoon', 'evening'])
  })

  it('still separates a genuine local-midnight crossing', () => {
    const days = groupByDay([
      entry('before', '2026-07-31T04:59:00.000Z'), // 23:59 local
      entry('after', '2026-07-31T05:01:00.000Z'),  // 00:01 local, next day
    ], GYE)
    expect(days.map((d) => d.day)).toEqual(['2026-07-30', '2026-07-31'])
  })

  it('preserves order and does not merge non-adjacent days', () => {
    const days = groupByDay([
      entry('a', '2026-07-30T21:00:00.000Z'),
      entry('b', '2026-07-31T21:00:00.000Z'),
      entry('c', '2026-07-30T22:00:00.000Z'), // out of order on purpose
    ], GYE)
    expect(days.map((d) => d.day)).toEqual(['2026-07-30', '2026-07-31', '2026-07-30'])
  })
})
