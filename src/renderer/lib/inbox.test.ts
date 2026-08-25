import { describe, it, expect } from 'vitest'
import type { ArtifactReport, DispatchRecord } from '../../shared/types'
import { headline, inboxFor, outboxFor, trafficFor, laneTraffic, unackedCount, announcement } from './inbox'

const report = (over: Partial<ArtifactReport> = {}): ArtifactReport => ({
  id: 1, at: '2026-08-24T10:00:00Z', terminalId: 't3', projectId: 'p', roleId: 'code',
  taskId: null, summary: 'Did the thing', artifacts: '[]', ...over,
})

const record = (over: Partial<DispatchRecord> = {}): DispatchRecord => ({
  id: 'd1', at: '2026-08-24T09:00:00Z', fromRoleId: 'operator', toRoleId: 'code',
  task: 'Do the thing', outcome: 'sent', ...over,
})

describe('headline', () => {
  it('takes the first non-empty line', () => {
    expect(headline('\n\nFirst line\nsecond')).toBe('First line')
  })
  it('strips a leading markdown heading or bold wrapper — reports are written as prose', () => {
    expect(headline('## Result\nbody')).toBe('Result')
    expect(headline('**Done**')).toBe('Done')
  })
  it('truncates with an ellipsis, never mid-list-row', () => {
    expect(headline('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`)
  })
  it('is empty for an empty summary rather than throwing', () => {
    expect(headline('')).toBe('')
  })
})

describe('inboxFor — what is addressed to this lane', () => {
  it('routes by toRole when the column is set', () => {
    const rs = [report({ id: 1, toRole: 'qa' }), report({ id: 2, toRole: 'operator' })]
    expect(inboxFor('qa', false, rs).map((i) => i.id)).toEqual(['report:1'])
  })

  // 298 rows of real history predate the column, and every one of them meant "the coordinator".
  // Dropping them would make the Inbox look empty on the machine that has the most to show.
  it('gives LEGACY rows with no toRole to the coordinator', () => {
    const rs = [report({ id: 7, toRole: undefined })]
    expect(inboxFor('operator', true, rs).map((i) => i.id)).toEqual(['report:7'])
    expect(inboxFor('code', false, rs)).toEqual([])
  })

  it('carries the ack state, which is the only read receipt there is', () => {
    const [item] = inboxFor('operator', true, [report({ deliveredAt: 'x', ackedAt: 'y' })])
    expect(item).toMatchObject({ delivered: true, acked: true, who: 'code' })
  })

  it('falls back to the terminal id when a report has no role', () => {
    expect(inboxFor('operator', true, [report({ roleId: null })])[0].who).toBe('t3')
  })
})

describe('outboxFor — so a worker can see its own result landed', () => {
  it('lists this lane\'s own reports with their ack state', () => {
    const [item] = outboxFor('code', [report({ deliveredAt: 'x' })])
    expect(item).toMatchObject({ kind: 'sent', delivered: true, acked: false, who: 'operator' })
  })
  it('ignores another lane\'s reports', () => {
    expect(outboxFor('qa', [report({ roleId: 'code' })])).toEqual([])
  })
})

describe('trafficFor — and WHICH brake stopped it', () => {
  it('shows direction from this lane\'s point of view', () => {
    expect(trafficFor('operator', [record()])[0].who).toBe('→ code')
    expect(trafficFor('code', [record()])[0].who).toBe('← operator')
  })

  // The audit's complaint about the brakes is that they are silent. A row saying only "blocked"
  // would reproduce that in a new place, so every blocked outcome names its brake.
  it('names the brake in words for every blocked outcome', () => {
    for (const outcome of ['hop-limit', 'pair-brake', 'paused', 'pending-approval', 'rejected', 'unassigned', 'undelivered'] as const) {
      const [item] = trafficFor('code', [record({ outcome })])
      expect(item.kind, outcome).toBe('blocked')
      expect(item.blockedBy, outcome).toBeTruthy()
      expect(item.blockedBy, outcome).not.toBe(outcome) // words, not the enum name
    }
  })

  it('leaves a delivered dispatch unblocked', () => {
    for (const outcome of ['sent', 'launched', 'queued'] as const) {
      expect(trafficFor('code', [record({ outcome })])[0].kind, outcome).toBe('sent')
    }
  })

  it('ignores traffic this lane is not part of', () => {
    expect(trafficFor('design', [record({ fromRoleId: 'operator', toRoleId: 'code' })])).toEqual([])
  })
})

describe('laneTraffic', () => {
  it('merges all three sources newest first', () => {
    const items = laneTraffic({
      role: 'operator',
      isCoordinator: true,
      reports: [report({ id: 1, at: '2026-08-24T10:00:00Z' })],
      records: [record({ id: 'd1', at: '2026-08-24T09:00:00Z' })],
    })
    expect(items.map((i) => i.id)).toEqual(['report:1', 'dispatch:d1'])
  })

  it('does not show a coordinator its own report twice', () => {
    const items = laneTraffic({
      role: 'operator', isCoordinator: true,
      reports: [report({ id: 5, roleId: 'operator', toRole: 'operator' })], records: [],
    })
    // One row per underlying thing: `report:5` and `sent:5` are different ids, so both appear —
    // which is correct, they are the inbox and outbox views of a message to itself.
    expect(items).toHaveLength(2)
    expect(new Set(items.map((i) => i.id)).size).toBe(2)
  })

  it('is empty rather than throwing with nothing to show', () => {
    expect(laneTraffic({ role: 'code', isCoordinator: false, reports: [], records: [] })).toEqual([])
  })
})

describe('unackedCount — the number that makes "silence means no report" checkable', () => {
  it('counts only what is addressed here and not yet opened', () => {
    const rs = [report({ id: 1 }), report({ id: 2, ackedAt: 'x' }), report({ id: 3, toRole: 'qa' })]
    expect(unackedCount('operator', true, rs)).toBe(1)
  })
  it('is zero when everything has been read', () => {
    expect(unackedCount('operator', true, [report({ ackedAt: 'x' })])).toBe(0)
  })
})

describe('announcement — the one pty line, and it is NOT the report', () => {
  it('names the id, the sender and where the text is', () => {
    expect(announcement(report({ id: 42, roleId: 'research', summary: 'Found the cause' })))
      .toBe('[Operator] report #42 from research: Found the cause — full text in Inbox')
  })

  // Reports exist precisely BECAUSE typing a long paste into a live TUI races its composer.
  // An announcement that carried the report would reintroduce the failure it was built to avoid.
  it('stays short even for a long report', () => {
    const line = announcement(report({ summary: 'x'.repeat(500) }))
    expect(line.length).toBeLessThan(160)
    expect(line.endsWith('full text in Inbox')).toBe(true)
  })

  it('is a single line — it is typed into a pty', () => {
    expect(announcement(report({ summary: 'a\nb\nc' })).includes('\n')).toBe(false)
  })
})
