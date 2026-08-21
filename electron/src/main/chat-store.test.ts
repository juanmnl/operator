import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
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

// Scenario parity with `src-tauri/src/chatstore.rs`'s test module — the durability contract.
describe('chatstore parity with the Rust store', () => {
  it('a row written BEFORE the tool column existed still loads', () => {
    // The pre-migration schema, written by hand, then opened by the current code.
    const path = join(SANDBOX, 'legacy.db')
    const raw = new Database(path)
    raw.exec(`CREATE TABLE messages (session_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
              text TEXT NOT NULL, ts TEXT NOT NULL, PRIMARY KEY (session_id, seq));`)
    raw.prepare('INSERT INTO messages VALUES (?,?,?,?,?)').run('s', 0, 'user', 'from before', 't')
    raw.close()

    const store = new ChatStore(path)
    expect(store.load('s')[0].text).toBe('from before')
    store.close()
  })

  it('opening a db that already has replies KEEPS its rows', () => {
    const path = join(SANDBOX, 'keep.db')
    const a = new ChatStore(path)
    a.appendReply('r1', 's', 'p', 'operator', 'kept', 't')
    a.close()
    const b = new ChatStore(path)
    expect(b.replies('p').map((r) => r.text)).toEqual(['kept'])
    b.close()
  })

  it('opening the store never deletes rows it did not write', () => {
    const path = join(SANDBOX, 'untouched.db')
    const a = new ChatStore(path)
    a.append('s', [[0, { kind: 'user', text: 'real conversation', timestamp: 't' }]])
    a.close()
    const b = new ChatStore(path)
    expect(b.load('s')).toHaveLength(1)
    b.close()
  })

  it('replies do not disturb the message seq space', () => {
    const path = join(SANDBOX, 'seqspace.db')
    const store = new ChatStore(path)
    store.append('s', [[0, { kind: 'user', text: 'a', timestamp: 't' }]])
    store.appendReply('r', 's', 'p', 'operator', 'a reply', 't')
    store.append('s', [[1, { kind: 'text', text: 'b', timestamp: 't' }]])
    expect(store.load('s').map((e) => e.text)).toEqual(['a', 'b'])
    store.close()
  })

  it('a reply with no project is stored unscoped', () => {
    const path = join(SANDBOX, 'unscoped.db')
    const store = new ChatStore(path)
    store.appendReply('r', 's', '', 'operator', 'no project', 't')
    expect(store.replies('').map((r) => r.text)).toEqual(['no project'])
    store.close()
  })

  it('load never assumes seq is dense — gaps are fine', () => {
    // The purge deletes rows, leaving holes. `load` orders by seq and must not care.
    const path = join(SANDBOX, 'sparse.db')
    const store = new ChatStore(path)
    store.append('s', [[0, { kind: 'user', text: 'a', timestamp: 't' }], [7, { kind: 'text', text: 'b', timestamp: 't' }]])
    expect(store.load('s').map((e) => e.text)).toEqual(['a', 'b'])
    store.close()
  })
})

// THE ONE DESTRUCTIVE STATEMENT IN THE APP. It runs once per database, and only after a backup.
//
// The rows it targets were written by an OLDER build, before the parser learned to drop them —
// so the fixture has to be a legacy db (user_version 0, rows already in it), not one this code
// created. A store this code opens stamps user_version at creation, which is exactly why a
// fresh db never gets purged.
describe('the one-time injected-row purge', () => {
  /** A db as an older Operator left it: schema present, plumbing rows in, user_version 0. */
  function legacyDb(path: string, texts: string[]): void {
    const raw = new Database(path)
    raw.exec(`CREATE TABLE messages (session_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
              text TEXT NOT NULL, ts TEXT NOT NULL, images TEXT, tool TEXT, PRIMARY KEY (session_id, seq));`)
    const st = raw.prepare('INSERT INTO messages (session_id, seq, kind, text, ts) VALUES (?,?,?,?,?)')
    texts.forEach((t, i) => st.run('s', i, 'user', t, 'ts'))
    raw.pragma('user_version = 0')
    raw.close()
  }

  it('deletes plumbing rows, keeps real conversation, and runs ONCE', () => {
    const path = join(SANDBOX, 'purge.db')
    legacyDb(path, [
      '<system-reminder>plumbing</system-reminder>',
      'real conversation',
      '<command-name>/foo</command-name>',
      '<local-command-stdout>out</local-command-stdout>',
      '<task-notification>done</task-notification>',
    ])

    const b = new ChatStore(path)
    expect(b.load('s').map((e) => e.text)).toEqual(['real conversation'])
    // It records that it ran, so a later write of a similar-looking row is NOT swept: the purge
    // is a one-time cleanup, not a standing filter.
    b.append('s', [[9, { kind: 'user', text: '<system-reminder>written after</system-reminder>', timestamp: 't' }]])
    b.close()
    const c = new ChatStore(path)
    expect(c.load('s').map((e) => e.text)).toEqual(['real conversation', '<system-reminder>written after</system-reminder>'])
    c.close()
  })

  it('writes a backup beside the db BEFORE deleting anything', () => {
    const path = join(SANDBOX, 'backup.db')
    legacyDb(path, ['<system-reminder>doomed</system-reminder>', 'kept'])
    new ChatStore(path).close()
    // The user's undo. Never cleaned up automatically.
    expect(existsSync(`${path}.pre-v1.bak`)).toBe(true)
    const backup = new Database(`${path}.pre-v1.bak`, { readonly: true })
    expect((backup.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c).toBe(2)
    backup.close()
  })

  it('writes NO backup when there is nothing to lose', () => {
    const path = join(SANDBOX, 'nobackup.db')
    legacyDb(path, ['all real', 'also real'])
    new ChatStore(path).close()
    expect(existsSync(`${path}.pre-v1.bak`)).toBe(false)
  })

  it('leaves a fresh db alone — nothing to purge, and it is stamped at creation', () => {
    const path = join(SANDBOX, 'fresh.db')
    const store = new ChatStore(path)
    store.append('s', [[0, { kind: 'user', text: '<system-reminder>x</system-reminder>', timestamp: 't' }]])
    store.close()
    const again = new ChatStore(path)
    expect(again.load('s')).toHaveLength(1)
    expect(existsSync(`${path}.pre-v1.bak`)).toBe(false)
    again.close()
  })
})
