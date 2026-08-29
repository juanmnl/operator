import { describe, it, expect } from 'vitest'
import type { AgentSession, ArtifactReport, DispatchRecord } from '../../shared/types'
import { announcement, canAnnounceTo, headline, projectComms, reportsForTask, reportsOfProject, reportState, reportStateLabel, rowKey, toReportRow } from './comms'

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

// TWO STATES, and what each honestly claims. `written` means stored and seen by nobody — the
// state the whole audit is about. There is no third: the mailbox that produced `acked` is gone,
// and a value nothing can write is a label nobody can reach.
describe('reportState', () => {
  it('is written until something has shown it', () => {
    expect(reportState(report())).toBe('written')
  })
  it('is delivered once the recipient was told', () => {
    expect(reportState(report({ deliveredAt: 'x' }))).toBe('delivered')
  })
  it('reads a LEGACY acked row as delivered — it was opened, and opening required being shown', () => {
    expect(reportState(report({ ackedAt: 'y' }))).toBe('delivered')
    expect(reportState(report({ deliveredAt: 'x', ackedAt: 'y' }))).toBe('delivered')
  })
})

// One vocabulary, two surfaces. The dispatch half of this record was born with a second copy of
// its labels that disagreed with the shared one; the report half never gets the chance.
describe('reportStateLabel', () => {
  it('names both states, and never says "unread" — nothing reads, so nothing is unread', () => {
    expect(reportStateLabel('delivered')).toBe('reported')
    expect(reportStateLabel('written')).toBe('reached nobody')
  })
})

describe('toReportRow', () => {
  // 298 rows of real history predate the `toRole` column, and every one of them meant "the
  // coordinator". Reading them as addressed to nobody would blank the timeline on the machine
  // that has the most to show.
  it('gives a LEGACY row with no toRole to the coordinator', () => {
    expect(toReportRow(report({ toRole: undefined })).to).toBe('operator')
    expect(toReportRow(report({ toRole: 'qa' })).to).toBe('qa')
  })

  it('falls back to the terminal id when a report has no role', () => {
    expect(toReportRow(report({ roleId: null })).from).toBe('t3')
  })

  it('parses artifacts defensively — that JSON is written by another process', () => {
    expect(toReportRow(report({ artifacts: 'not json' })).artifacts).toEqual([])
    expect(toReportRow(report({ artifacts: '{"a":1}' })).artifacts).toEqual([])
    expect(toReportRow(report({ artifacts: '[{"name":"x"}]' })).artifacts).toEqual([{ name: 'x' }])
  })
})

describe('reportsOfProject', () => {
  it('keeps this project and drops another', () => {
    const rs = [report({ id: 1, projectId: 'p' }), report({ id: 2, projectId: 'other' })]
    expect(reportsOfProject('p', rs).map((r) => r.id)).toEqual([1])
  })

  // An unattributable row appears under every project, which is visible and correctable; a
  // silently missing report is neither, and silence-that-looks-like-success is the exact failure
  // this record exists to make checkable.
  it('KEEPS an unattributed row rather than hiding it', () => {
    expect(reportsOfProject('p', [report({ id: 9, projectId: null })]).map((r) => r.id)).toEqual([9])
  })

  // Ported from `forProject` in the deleted `inbox.test.ts` — the two lanes wrote the same scope
  // independently and this was the one case only the other copy pinned. `undefined` is what a
  // surface passes before it knows its project, and dropping everything there would read as "no
  // reports" rather than "not scoped yet".
  it('returns everything when there is no project to scope by', () => {
    const rs = [report({ id: 1, projectId: 'p' }), report({ id: 2, projectId: 'other' })]
    expect(reportsOfProject(undefined, rs).map((r) => r.id)).toEqual([1, 2])
  })
})

// D1: every dispatch label comes from `chipForOutcome`. A first version of this module had a
// second seven-entry vocabulary that DISAGREED with it — these two cases are exactly where.
describe('projectComms — labels come from the shared vocabulary, never a second copy', () => {
  const chipOf = (o: DispatchRecord['outcome']) => {
    const [row] = projectComms({ projectId: 'p', reports: [], records: [record({ outcome: o })] })
    if (row.kind !== 'dispatch') throw new Error('expected a dispatch row')
    return row.chip
  }

  it('calls `undelivered` "sent · never started", NOT held — it left and did not arrive', () => {
    expect(chipOf('undelivered').label).toBe('sent · never started')
  })

  it('keeps `rejected` and `unassigned` MUTED — nothing is wrong and nothing retries', () => {
    expect(chipOf('rejected').tone).toBe('muted')
    expect(chipOf('unassigned').tone).toBe('muted')
  })

  it('warns only on the outcomes that actually held something up', () => {
    for (const o of ['hop-limit', 'pair-brake', 'paused', 'pending-approval'] as const) {
      expect(chipOf(o).tone, o).toBe('warn')
    }
  })

  // A surface deciding whether to offer Approve must branch on the ENUM. Carrying the raw
  // outcome next to its chip is what stops the next reader string-matching the label.
  it('carries the raw outcome alongside the chip', () => {
    const [row] = projectComms({ projectId: 'p', reports: [], records: [record({ outcome: 'pending-approval' })] })
    expect(row).toMatchObject({ kind: 'dispatch', outcome: 'pending-approval' })
  })

  it("carries the brake's OWN note through, rather than composing a new sentence", () => {
    const note = 'code → qa sent 6 messages in under a minute, so that pair is suspended.'
    const [row] = projectComms({ projectId: 'p', reports: [], records: [record({ outcome: 'pair-brake', note })] })
    expect(row.kind === 'dispatch' && row.note).toBe(note)
  })
})

describe('projectComms — one chronological timeline for the whole project', () => {
  it('merges reports and dispatches, newest first', () => {
    const rows = projectComms({
      projectId: 'p',
      reports: [report({ id: 1, at: '2026-08-24T10:00:00Z' })],
      records: [record({ id: 'd1', at: '2026-08-24T09:00:00Z' })],
    })
    expect(rows.map((r) => r.kind)).toEqual(['report', 'dispatch'])
  })

  // PROJECT-WIDE IS THE POINT. A cascade is lanes going quiet TOGETHER — the hop-limit budget is
  // one scalar per lane, so a brake in one starves the coordinator and the fleet stalls. Seen one
  // lane at a time, that shape is six unrelated quiet panels.
  it('shows every lane, not just one — a brake cascade is only visible side by side', () => {
    const rows = projectComms({
      projectId: 'p',
      reports: [report({ id: 1, roleId: 'qa', at: '2026-08-24T10:02:00Z' })],
      records: [
        record({ id: 'd1', at: '2026-08-24T10:01:00Z', fromRoleId: 'code', toRoleId: 'qa', outcome: 'hop-limit' }),
        record({ id: 'd2', at: '2026-08-24T10:00:00Z', fromRoleId: 'review', toRoleId: 'qa', outcome: 'hop-limit' }),
      ],
    })
    expect(rows.map((r) => r.from)).toEqual(['qa', 'code', 'review'])
  })

  it('scopes reports to the project — one app-wide poll feeds every project', () => {
    const rows = projectComms({
      projectId: 'p',
      reports: [report({ id: 1, projectId: 'p' }), report({ id: 2, projectId: 'elsewhere' })],
      records: [],
    })
    expect(rows).toHaveLength(1)
  })

  it('is empty rather than throwing with nothing to show', () => {
    expect(projectComms({ projectId: 'p', reports: [], records: [] })).toEqual([])
  })

  // A numeric report id and a string dispatch id can stringify the same way; the kind is what
  // keeps two rows from colliding on one React key.
  it('keys a report and a dispatch apart even when their ids stringify the same', () => {
    expect(rowKey(toReportRow(report({ id: 1 })))).not.toBe(
      rowKey(projectComms({ projectId: 'p', reports: [], records: [record({ id: '1' })] })[0]),
    )
  })
})

// THE RESULT ON THE TASK — the replacement for the mailbox. A finished task carries what its
// lane handed back, so the outcome is read where you were already looking.
describe('reportsForTask', () => {
  it('joins a report to the task it named', () => {
    const rs = [report({ id: 1, taskId: 'task-a' }), report({ id: 2, taskId: 'task-b' })]
    expect(reportsForTask('task-a', rs).map((r) => r.id)).toEqual([1])
  })

  // The tempting fallback — "a report from this task's lane, timestamped inside its run" —
  // attaches a result to work that never claimed it, and a lane running three tasks in an
  // afternoon gets three wrong answers that look exactly like right ones.
  it('never guesses: a report with no taskId belongs to no task', () => {
    expect(reportsForTask('task-a', [report({ taskId: null, roleId: 'code' })])).toEqual([])
  })

  it('lists instalments oldest first — a second report is not a correction of the first', () => {
    const rs = [
      report({ id: 2, taskId: 't', at: '2026-08-24T12:00:00Z' }),
      report({ id: 1, taskId: 't', at: '2026-08-24T10:00:00Z' }),
    ]
    expect(reportsForTask('t', rs).map((r) => r.id)).toEqual([1, 2])
  })

  it('carries the state through, so a result nobody was shown says so on the card', () => {
    expect(reportsForTask('t', [report({ taskId: 't' })])[0].state).toBe('written')
    expect(reportsForTask('t', [report({ taskId: 't', deliveredAt: 'x' })])[0].state).toBe('delivered')
  })
})

describe('announcement — the one pty line, and it is NOT the report', () => {
  it('names the id, the sender and where the text is', () => {
    expect(announcement(report({ id: 42, roleId: 'research', summary: 'Found the cause' })))
      .toBe('[Operator] report #42 from research: Found the cause — full text in the project Comms log')
  })

  it('points at the TASK when the lane named one — that is where the result now lives', () => {
    expect(announcement(report({ id: 7, taskId: 'task-a' }))).toContain('full text on its task card')
  })

  // Reports exist precisely BECAUSE typing a long paste into a live TUI races its composer.
  // An announcement that carried the report would reintroduce the failure it was built to avoid.
  it('stays short even for a long report', () => {
    const line = announcement(report({ summary: 'x'.repeat(500) }))
    expect(line.length).toBeLessThan(180)
  })

  it('is a single line — it is typed into a pty', () => {
    expect(announcement(report({ summary: 'a\nb\nc' })).includes('\n')).toBe(false)
  })
})


// Ported wholesale from the deleted `inbox.test.ts`. The mailbox was cut; the announce path it
// guards was not, and this guard is the one that stopped a batch typing into a lane it had just
// woken up.
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
