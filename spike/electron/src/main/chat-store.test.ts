import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatStore, ArtifactStore } from './chat-store'

const SANDBOX = mkdtempSync(join(tmpdir(), 'operator-db-test-'))
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

describe('ChatStore', () => {
  let store: ChatStore
  beforeAll(() => { store = new ChatStore(join(SANDBOX, 'chat.db')) })

  it('round-trips a narration entry in seq order', () => {
    store.append('s1', [
      [1, { kind: 'user', text: 'hello', timestamp: '2026-01-01T00:00:00Z' }],
      [0, { kind: 'text', text: 'first', timestamp: '2026-01-01T00:00:00Z' }],
    ])
    expect(store.load('s1').map((e) => e.text)).toEqual(['first', 'hello'])
  })

  it('UPSERTS on (session, seq) — a tool row is written twice by design', () => {
    // Written when the call starts, rewritten when the result lands. An INSERT would throw on
    // the second write and every tool result in the store would be lost.
    store.append('s2', [[0, { kind: 'tool', text: '', timestamp: 't', tool: { name: 'Bash', output: '' } }]])
    store.append('s2', [[0, { kind: 'tool', text: '', timestamp: 't', tool: { name: 'Bash', output: 'done' } }]])
    const rows = store.load('s2')
    expect(rows).toHaveLength(1)
    expect((rows[0].tool as { output: string }).output).toBe('done')
  })

  it('keeps images as a list', () => {
    store.append('s3', [[0, { kind: 'user', text: 'look', timestamp: 't', images: ['/tmp/a.png'] }]])
    expect(store.load('s3')[0].images).toEqual(['/tmp/a.png'])
  })

  it('scopes by session', () => {
    expect(store.load('nobody')).toEqual([])
  })

  it('deduplicates replies by content-hash id, so a transcript re-read is a no-op', () => {
    store.appendReply('abc', 's1', 'p1', 'operator', 'done', '2026-01-01T00:00:00Z')
    store.appendReply('abc', 's1', 'p1', 'operator', 'done', '2026-01-01T00:00:00Z')
    expect(store.replies('p1')).toHaveLength(1)
  })

  it('returns replies for a project, oldest first', () => {
    store.appendReply('r2', 's1', 'p2', 'operator', 'second', '2026-01-02T00:00:00Z')
    store.appendReply('r1', 's1', 'p2', 'operator', 'first', '2026-01-01T00:00:00Z')
    expect(store.replies('p2').map((r) => r.text)).toEqual(['first', 'second'])
  })

  it('reopens an existing db without rebuilding it — CREATE IF NOT EXISTS is a no-op', () => {
    const path = join(SANDBOX, 'reopen.db')
    const a = new ChatStore(path)
    a.append('s', [[0, { kind: 'user', text: 'persisted', timestamp: 't' }]])
    a.close()
    const b = new ChatStore(path)
    expect(b.load('s')[0].text).toBe('persisted')
    b.close()
  })
})

describe('ArtifactStore', () => {
  let store: ArtifactStore
  beforeAll(() => { store = new ArtifactStore(join(SANDBOX, 'artifacts.db')) })

  it('lists reports newest first', () => {
    store.insertReport('2026-01-01T00:00:00Z', 't1', 'p1', 'code', 'task-1', 'older', '[]')
    store.insertReport('2026-01-02T00:00:00Z', 't1', 'p1', 'code', 'task-2', 'newer', '[{"name":"a","content":"b"}]')
    const rows = store.listReports(10)
    expect(rows.map((r) => r.summary)).toEqual(['newer', 'older'])
    // The RAW JSON string, not a parsed array: `ArtifactReport.artifacts` is declared `string`
    // in shared/types.ts and the renderer parses it itself. Returning an array here would have
    // it call JSON.parse on an object.
    expect(rows[0].artifacts).toBe('[{"name":"a","content":"b"}]')
  })

  it('honours the limit', () => {
    expect(store.listReports(1)).toHaveLength(1)
  })

  it('returns only UNAPPLIED status events, and marking is what removes them', () => {
    const id = store.insertStatus('2026-01-01T00:00:00Z', 't1', 'p1', 'task-9', 'done')
    expect(store.pendingStatus().map((s) => s.taskId)).toContain('task-9')
    store.markApplied([id])
    expect(store.pendingStatus().map((s) => s.taskId)).not.toContain('task-9')
  })

  it('an un-acked status REPLAYS — that is the point of the two-step protocol', () => {
    store.insertStatus('2026-01-01T00:00:00Z', 't1', 'p1', 'task-crash', 'blocked')
    // simulate a crash between reading and acking: read twice, never ack
    expect(store.pendingStatus().map((s) => s.taskId)).toContain('task-crash')
    expect(store.pendingStatus().map((s) => s.taskId)).toContain('task-crash')
  })

  it('markApplied with no ids is a no-op, not an error', () => {
    expect(() => store.markApplied([])).not.toThrow()
  })
})
