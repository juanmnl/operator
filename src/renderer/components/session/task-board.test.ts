import { describe, it, expect } from 'vitest'
import { partitionBoard } from './TaskBoard'
import type { DispatchRecord, ProjectTask } from '../../../shared/types'

// The board's whole data model is `partitionBoard`. Every dispatch fixture below is a shape the
// delivery path actually writes — checked against `~/.operator/projects.json` and against the one
// place each outcome is produced in `DashboardView`:
//
//   • a `replyId` record is a CHAT DELIVERY, not work. The three agent↔agent brakes
//     (`hop-limit`/`pair-brake`/`paused`) are written in exactly one literal and it ALWAYS sets
//     `replyId`, which `shared/types.ts` states as an invariant. A braked record without one is
//     not a rare case, it is impossible — an earlier version of this file asserted one and so
//     tested the filter against a record the system cannot produce.
//   • `undelivered` on a DISPATCH is producible: `reportUndelivered` reclassifies any
//     `sent`/`launched` record, and the store holds 82 non-reply `sent` records in one project.
//     So its fixture is a real `sent` record with only `outcome` changed — which is exactly the
//     mutation `setDispatchOutcome` performs.
//   • `unassigned` DOES reach Waiting now. It used to be excluded because the same handler called
//     `addProjectTask` first, so the work was already a queued task in Backlog — but that call is
//     gone: a dispatch naming a lane that doesn't exist is a delivery failure, not work, and
//     minting a durable task for it is how eight July status reports were later dispatched as if
//     they were. The one exception is a LEGACY pair (a row minted before the change), which keeps
//     its backlog card and must not also raise a Waiting one.
//   • `done` is done ∪ abandoned, but the two are counted apart. Folding abandoned into "done"
//     is how ~50 reconciled tasks once got relabelled as finished.

const task = (o: Partial<ProjectTask> & { id: string }): ProjectTask =>
  ({ text: 't', createdAt: '2026-08-01T00:00:00.000Z', ...o })

const dispatch = (o: Partial<DispatchRecord> & { id: string; outcome: DispatchRecord['outcome'] }): DispatchRecord =>
  ({ at: '2026-08-01T00:00:00.000Z', task: 'd', ...o })

describe('partitionBoard', () => {
  it('splits tasks by lifecycle, with an absent status reading as queued', () => {
    const b = partitionBoard([
      task({ id: 'a' }),                          // no status = queued
      task({ id: 'b', status: 'queued' }),
      task({ id: 'c', status: 'running' }),
      task({ id: 'd', status: 'done' }),
      task({ id: 'e', status: 'abandoned' }),
    ], [])
    expect(b.backlog.map((t) => t.id)).toEqual(['a', 'b'])
    expect(b.running.map((t) => t.id)).toEqual(['c'])
    expect(b.done.map((t) => t.id).sort()).toEqual(['d', 'e'])
  })

  it('counts abandoned and reconciled-done as unconfirmed, without hiding them', () => {
    const b = partitionBoard([
      task({ id: 'a', status: 'done' }),
      task({ id: 'b', status: 'abandoned' }),
      task({ id: 'c', status: 'done', reconciledAt: '2026-08-01T01:00:00.000Z' }),
    ], [])
    expect(b.done).toHaveLength(3)   // nothing vanishes
    expect(b.unconfirmed).toBe(2)    // but only one of them was seen to finish
  })

  it('puts work that is stopped until a human acts in Waiting, and nothing else', () => {
    const b = partitionBoard([], [
      // The two that belong there.
      dispatch({ id: 'held', outcome: 'pending-approval', fromRoleId: 'design', toRoleId: 'code' }),
      dispatch({ id: 'stranded', outcome: 'undelivered', fromRoleId: 'operator', toRoleId: 'review' }),
      // Delivered, or on its way — history, not a decision.
      dispatch({ id: 'sent', outcome: 'sent' }),
      dispatch({ id: 'launched', outcome: 'launched' }),
      dispatch({ id: 'queued', outcome: 'queued' }),
      dispatch({ id: 'rejected', outcome: 'rejected' }),
      // WAS excluded, on the argument that the work was already a queued task in Backlog. The
      // handler no longer files that task, so the premise is gone and the record is now the only
      // representation of the work — it belongs in the column for things stopped until a human
      // acts. (Its card carries a lane picker, which answers the old "no affordance" objection.)
      dispatch({ id: 'unassigned', outcome: 'unassigned' }),
    ])
    expect(b.waiting.map((d) => d.id).sort()).toEqual(['held', 'stranded', 'unassigned'])
  })

  it('excludes chat deliveries, whatever happened to them', () => {
    // Every one of these carries a replyId because that is the ONLY way the delivery path writes
    // them — `record()` in the reply handler sets it unconditionally. `undelivered` on a reply is
    // producible too (reportUndelivered matches reply-delivery `sent` records), and it is still
    // chat: the discriminator is what the record IS, not where its text ended up.
    const b = partitionBoard([], [
      dispatch({ id: 'brake', outcome: 'pair-brake', replyId: 'r1' }),
      dispatch({ id: 'hop', outcome: 'hop-limit', replyId: 'r2' }),
      dispatch({ id: 'paused', outcome: 'paused', replyId: 'd2a58751d134590a' }),
      dispatch({ id: 'reply-stranded', outcome: 'undelivered', replyId: 'r3' }),
      dispatch({ id: 'work', outcome: 'pending-approval' }),
    ])
    expect(b.waiting.map((d) => d.id)).toEqual(['work'])
  })

  it('reports why an unroutable dispatch became an unassigned backlog task', () => {
    // The handler files the task and records the outcome with the SAME string, and never links
    // them by id — so the join is the text, and this is what keeps the reason visible once the
    // channel (which shows it today) is deleted.
    const b = partitionBoard(
      [task({ id: 't1', text: 'Audit the release gate' })],
      [
        dispatch({ id: 'u1', outcome: 'unassigned', task: 'Audit the release gate' }),
        // A reply is never a reason for a backlog task.
        dispatch({ id: 'u2', outcome: 'unassigned', task: 'Something else', replyId: 'r1' }),
      ],
    )
    expect(b.unassignedReasons.has('Audit the release gate')).toBe(true)
    expect(b.unassignedReasons.has('Something else')).toBe(false)
  })

  it('orders each column by what you need to see first', () => {
    const b = partitionBoard([
      task({ id: 'new-queued', createdAt: '2026-08-01T03:00:00.000Z' }),
      task({ id: 'old-queued', createdAt: '2026-08-01T01:00:00.000Z' }),
      task({ id: 'just-started', status: 'running', startedAt: '2026-08-01T05:00:00.000Z' }),
      task({ id: 'long-running', status: 'running', startedAt: '2026-07-29T05:00:00.000Z' }),
      task({ id: 'old-done', status: 'done', doneAt: '2026-08-01T02:00:00.000Z' }),
      task({ id: 'new-done', status: 'done', doneAt: '2026-08-01T06:00:00.000Z' }),
    ], [
      dispatch({ id: 'older', outcome: 'pending-approval', at: '2026-08-01T01:00:00.000Z' }),
      dispatch({ id: 'newer', outcome: 'pending-approval', at: '2026-08-01T07:00:00.000Z' }),
    ])
    // A queue reads from the top: oldest first.
    expect(b.backlog.map((t) => t.id)).toEqual(['old-queued', 'new-queued'])
    // Longest-running first — the one stuck for three days is the one worth looking at.
    expect(b.running.map((t) => t.id)).toEqual(['long-running', 'just-started'])
    // Both of these are things that just happened to you: newest first.
    expect(b.waiting.map((d) => d.id)).toEqual(['newer', 'older'])
    expect(b.done.map((t) => t.id)).toEqual(['new-done', 'old-done'])
  })

  it('survives an empty project without inventing columns', () => {
    const b = partitionBoard(undefined, undefined)
    expect(b).toEqual({
      backlog: [], running: [], waiting: [], done: [],
      unassignedReasons: new Set(), unconfirmed: 0,
    })
  })
})


// ── a dispatch that named no lane (dispatch-hygiene) ───────────────────────────────────────
describe('partitionBoard · unassigned dispatches', () => {
  it('raises a WAITING card and no backlog task', () => {
    const b = partitionBoard([], [dispatch({ id: 'd1', outcome: 'unassigned', task: 'code done: …' })])
    expect(b.waiting.map((d) => d.id)).toEqual(['d1'])
    expect(b.backlog).toEqual([])
  })

  it('does NOT double up on a legacy pair that already has its backlog row', () => {
    // Rows minted before the handler stopped creating them are the user's to clear, not ours to
    // migrate — so they keep the backlog card (with its reason) and raise no second card.
    const b = partitionBoard(
      [task({ id: 't1', text: 'code done: …' })],
      [dispatch({ id: 'd1', outcome: 'unassigned', task: 'code done: …' })],
    )
    expect(b.waiting).toEqual([])
    expect(b.backlog.map((t) => t.id)).toEqual(['t1'])
    expect(b.unassignedReasons.has('code done: …')).toBe(true)
  })

  it('still excludes a REPLY, whatever its outcome — clause (a) is unchanged', () => {
    const b = partitionBoard([], [dispatch({ id: 'r1', outcome: 'unassigned', replyId: 'x' })])
    expect(b.waiting).toEqual([])
  })

  it('a dismissed one leaves Waiting entirely', () => {
    const b = partitionBoard([], [dispatch({ id: 'd1', outcome: 'rejected', task: 'x' })])
    expect(b.waiting).toEqual([])
  })
})
