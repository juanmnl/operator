import { describe, it, expect } from 'vitest'
import { partitionBoard } from './TaskBoard'
import type { DispatchRecord, ProjectTask } from '../../../shared/types'

// The board's whole data model is `partitionBoard`, and the two rules worth a test are the two
// that were got wrong by looking at the types instead of at the store:
//   • a `replyId` dispatch is a CHAT DELIVERY, not work. In the real projects.json, three of the
//     four non-delivered records carry one — so without this filter the Waiting column would be
//     three-quarters chat messages.
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

  it('puts held and stranded dispatches in Waiting and nothing else', () => {
    const b = partitionBoard([], [
      dispatch({ id: 'held', outcome: 'pending-approval' }),
      dispatch({ id: 'brake', outcome: 'pair-brake' }),
      dispatch({ id: 'hop', outcome: 'hop-limit' }),
      dispatch({ id: 'paused', outcome: 'paused' }),
      dispatch({ id: 'stranded', outcome: 'undelivered' }),
      dispatch({ id: 'sent', outcome: 'sent' }),
      dispatch({ id: 'launched', outcome: 'launched' }),
      dispatch({ id: 'queued', outcome: 'queued' }),
      dispatch({ id: 'rejected', outcome: 'rejected' }),
      dispatch({ id: 'unassigned', outcome: 'unassigned' }),
    ])
    expect(b.waiting.map((d) => d.id).sort())
      .toEqual(['brake', 'held', 'hop', 'paused', 'stranded'])
  })

  it('excludes reply deliveries — a braked OPERATOR-REPLY is a message, not work', () => {
    const b = partitionBoard([], [
      dispatch({ id: 'work', outcome: 'paused' }),
      dispatch({ id: 'chat', outcome: 'paused', replyId: 'd2a58751d134590a' }),
    ])
    expect(b.waiting.map((d) => d.id)).toEqual(['work'])
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
    expect(b).toEqual({ backlog: [], running: [], waiting: [], done: [], unconfirmed: 0 })
  })
})
