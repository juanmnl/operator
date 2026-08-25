import { describe, it, expect } from 'vitest'
import type { AgentSession, ArtifactReport, DispatchRecord } from '../../shared/types'
import { forProject, headline, inboxFor, outboxFor, laneComms, unreadCount, unreadByRole, reportState, announcement, canAnnounceTo } from './inbox'

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
    expect(inboxFor('qa', false, rs).map((i) => i.id)).toEqual([1])
  })

  // 298 rows of real history predate the column, and every one of them meant "the coordinator".
  // Dropping them would make the Inbox look empty on the machine that has the most to show.
  it('gives LEGACY rows with no toRole to the coordinator', () => {
    const rs = [report({ id: 7, toRole: undefined })]
    expect(inboxFor('operator', true, rs).map((i) => i.id)).toEqual([7])
    expect(inboxFor('code', false, rs)).toEqual([])
  })

  it('falls back to the terminal id when a report has no role', () => {
    expect(inboxFor('operator', true, [report({ roleId: null })])[0].from).toBe('t3')
  })

  it('parses artifacts defensively — that JSON is written by another process', () => {
    expect(inboxFor('operator', true, [report({ artifacts: 'not json' })])[0].artifacts).toEqual([])
    expect(inboxFor('operator', true, [report({ artifacts: '{"a":1}' })])[0].artifacts).toEqual([])
    expect(inboxFor('operator', true, [report({ artifacts: '[{"name":"x"}]' })])[0].artifacts).toEqual([{ name: 'x' }])
  })
})

// THE THREE STATES, and what each honestly claims. `written` means stored and seen by nobody —
// the state the whole audit is about.
describe('reportState', () => {
  it('is written until something has shown it', () => {
    expect(reportState(report())).toBe('written')
  })
  it('is delivered once the recipient was told, acked once someone opened it', () => {
    expect(reportState(report({ deliveredAt: 'x' }))).toBe('delivered')
    expect(reportState(report({ deliveredAt: 'x', ackedAt: 'y' }))).toBe('acked')
  })
})

// D1: every label comes from `chipForOutcome`. A first version had a second seven-entry
// vocabulary that DISAGREED with it — these two cases are exactly where.
describe('outboxFor — labels come from the shared vocabulary, never a second copy', () => {
  it('calls `undelivered` "sent · never started", NOT held — it left and did not arrive', () => {
    const [row] = outboxFor('operator', [record({ outcome: 'undelivered' })])
    expect(row.chip.label).toBe('sent · never started')
  })

  it('keeps `rejected` and `unassigned` MUTED — nothing is wrong and nothing retries', () => {
    expect(outboxFor('operator', [record({ outcome: 'rejected' })])[0].chip.tone).toBe('muted')
    expect(outboxFor('operator', [record({ outcome: 'unassigned' })])[0].chip.tone).toBe('muted')
  })

  it('warns only on the outcomes that actually held something up', () => {
    for (const o of ['hop-limit', 'pair-brake', 'paused', 'pending-approval'] as const) {
      expect(outboxFor('operator', [record({ outcome: o })])[0].chip.tone, o).toBe('warn')
    }
  })

  it('carries the brake\'s OWN note through, rather than composing a new sentence', () => {
    const note = 'code → qa sent 6 messages in under a minute, so that pair is suspended.'
    expect(outboxFor('operator', [record({ outcome: 'pair-brake', note })])[0].note).toBe(note)
  })

  it('lists only what this lane SENT', () => {
    expect(outboxFor('qa', [record({ fromRoleId: 'operator' })])).toEqual([])
  })
})

describe('laneComms — one chronological list', () => {
  it('merges received, reported and sent, newest first', () => {
    const rows = laneComms({
      role: 'operator', isCoordinator: true,
      reports: [report({ id: 1, at: '2026-08-24T10:00:00Z' })],
      records: [record({ id: 'd1', at: '2026-08-24T09:00:00Z', fromRoleId: 'operator' })],
    })
    expect(rows.map((r) => r.kind)).toEqual(['received', 'sent'])
  })

  it('shows a lane its OWN report and whether anyone opened it', () => {
    const rows = laneComms({
      role: 'code', isCoordinator: false,
      reports: [report({ roleId: 'code', deliveredAt: 'x' })], records: [],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'reported', to: 'operator', state: 'delivered' })
  })

  it('is empty rather than throwing with nothing to show', () => {
    expect(laneComms({ role: 'code', isCoordinator: false, reports: [], records: [] })).toEqual([])
  })
})

describe('unreadCount / unreadByRole — the number that makes silence checkable', () => {
  it('counts only what is addressed here and not yet acked', () => {
    const rs = [report({ id: 1 }), report({ id: 2, ackedAt: 'x' }), report({ id: 3, toRole: 'qa' })]
    expect(unreadCount('operator', true, rs)).toBe(1)
  })

  it('a DELIVERED but unacked report still counts — shown is not read', () => {
    expect(unreadCount('operator', true, [report({ deliveredAt: 'x' })])).toBe(1)
  })

  // D3: one fetch feeds the rail marker, the tab badge and the toolbar chip.
  it('counts every lane at once, legacy rows falling to the coordinator', () => {
    const rs = [
      report({ id: 1, toRole: 'qa' }), report({ id: 2, toRole: 'qa', ackedAt: 'x' }),
      report({ id: 3, toRole: undefined }), report({ id: 4, toRole: 'code' }),
    ]
    expect(unreadByRole(rs, 'operator')).toEqual({ qa: 1, operator: 1, code: 1 })
  })

  it('is empty when everything has been read', () => {
    expect(unreadByRole([report({ ackedAt: 'x' })], 'operator')).toEqual({})
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

describe('canAnnounceTo — the guard that has to be asked twice', () => {
  const at = (over: Partial<AgentSession> = {}) => ({ status: 'active', phase: 'idle', ...over } as AgentSession)

  it('allows a lane that is between turns', () => {
    expect(canAnnounceTo(at({ phase: 'idle' }))).toBe(true)
    expect(canAnnounceTo(at({ phase: 'waiting' }))).toBe(true)
  })

  it('refuses a lane mid-turn — the announcement would land in a live composer', () => {
    // This is the one the batch used to get wrong: announcement #1 wakes the lane, and #2 and #3
    // were pasted into it while it was still thinking.
    expect(canAnnounceTo(at({ phase: 'running' }))).toBe(false)
    expect(canAnnounceTo(at({ phase: 'compacting' }))).toBe(false)
  })

  it('refuses an ended lane and a tab with no session — there is nobody to tell', () => {
    expect(canAnnounceTo(at({ status: 'ended' }))).toBe(false)
    expect(canAnnounceTo(undefined)).toBe(false)
  })
})

describe('forProject — one global store, many projects', () => {
  // `~/.operator/artifacts.db` holds every project on the machine. Unscoped, an Inbox opened in
  // `operator` listed reports filed by lanes in `uwazi-app`, and `unreadByRole` merged the two
  // projects' `operator` lanes into one count because role ids repeat across projects.
  const ours = report({ id: 1, projectId: 'operator-3cfdffb0' })
  const theirs = report({ id: 2, projectId: 'uwazi-app-d9bb8dcc' })
  const orphan = report({ id: 3, projectId: undefined })

  it('keeps this project and drops the others', () => {
    expect(forProject([ours, theirs], 'operator-3cfdffb0').map((r) => r.id)).toEqual([1])
  })

  it('keeps a report that names no project — unattributable is not foreign', () => {
    // A row that belongs to no list is a row nobody reads, which is the failure this module
    // exists to end. Shown to the wrong coordinator beats shown to none.
    expect(forProject([theirs, orphan], 'operator-3cfdffb0').map((r) => r.id)).toEqual([3])
  })

  it('returns everything when there is no project to scope by', () => {
    expect(forProject([ours, theirs], undefined).map((r) => r.id)).toEqual([1, 2])
  })

  it('keeps the count honest — the badge is what made the bleed visible', () => {
    const scoped = forProject([ours, theirs], 'operator-3cfdffb0')
    expect(unreadByRole(scoped, 'operator')).toEqual({ operator: 1 })
    expect(unreadByRole([ours, theirs], 'operator')).toEqual({ operator: 2 })
  })
})
