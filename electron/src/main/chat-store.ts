// The durable chat store and the artifact plane — `~/.operator/chat.db` and
// `~/.operator/artifacts.db`. Mirrors `src-tauri/src/chatstore.rs` and `artifacts.rs`.
//
// A RETURN TRIP: `docs/tauri-migration.md` records this leaving `better-sqlite3` for `rusqlite`
// when the app moved to Tauri. The schema comes back unchanged, which is the point — an
// existing `chat.db` must open and read correctly under the new shell, so the DDL here is the
// Rust's DDL, column for column.
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { operatorDir } from './store'

// The renderer's own types — see the note in transcript.ts.
import type { NarrationEntry, ProjectReply, ArtifactReport, ArtifactStatusEvent } from '../../../src/shared/types'
export type { NarrationEntry, ProjectReply, ArtifactReport, ArtifactStatusEvent }

function openDb(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  // WAL: the tailer writes once a second while the UI reads. Without it a read blocks a write
  // and the feed stutters exactly when a lane is busiest.
  db.pragma('journal_mode = WAL')
  return db
}

export class ChatStore {
  private readonly db: Database.Database

  constructor(path = join(operatorDir(), 'chat.db')) {
    this.db = openDb(path)
    // Schema identical to chatstore.rs. `IF NOT EXISTS` must be a no-op on an existing db —
    // that is what makes a Tauri-era chat.db open here rather than being rebuilt empty.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        session_id TEXT NOT NULL,
        seq        INTEGER NOT NULL,
        kind       TEXT NOT NULL,
        text       TEXT NOT NULL,
        ts         TEXT NOT NULL,
        images     TEXT,
        tool       TEXT,
        PRIMARY KEY (session_id, seq)
      );
      CREATE TABLE IF NOT EXISTS replies (
        id         TEXT PRIMARY KEY,
        project_id TEXT,
        session_id TEXT NOT NULL,
        to_target  TEXT NOT NULL,
        text       TEXT NOT NULL,
        ts         TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS replies_by_project ON replies (project_id, ts);
    `)
    // The two late-added columns, as ALTERs for a db created before they existed. They throw
    // on a db that already has them, which is the normal case — hence the swallow.
    for (const col of ['images', 'tool']) {
      try { this.db.exec(`ALTER TABLE messages ADD COLUMN ${col} TEXT`) } catch { /* already present */ }
    }
  }

  /** UPSERT on (session_id, seq). A tool call is written when it starts and rewritten when its
   *  result arrives, so the same seq is appended twice by design — an INSERT would throw on the
   *  second, losing every tool result in the store. */
  append(sessionId: string, entries: Array<[number, NarrationEntry]>): void {
    const stmt = this.db.prepare(
      `INSERT INTO messages (session_id, seq, kind, text, ts, images, tool)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, seq) DO UPDATE SET
         kind = excluded.kind, text = excluded.text, ts = excluded.ts,
         images = excluded.images, tool = excluded.tool`,
    )
    const tx = this.db.transaction((rows: Array<[number, NarrationEntry]>) => {
      for (const [seq, e] of rows) {
        stmt.run(sessionId, seq, e.kind, e.text, e.timestamp,
          e.images?.length ? JSON.stringify(e.images) : null,
          e.tool ? JSON.stringify(e.tool) : null)
      }
    })
    tx(entries)
  }

  load(sessionId: string): NarrationEntry[] {
    const rows = this.db.prepare(
      'SELECT kind, text, ts, images, tool FROM messages WHERE session_id = ? ORDER BY seq',
    ).all(sessionId) as Array<{ kind: string; text: string; ts: string; images: string | null; tool: string | null }>
    return rows.map((r) => ({
      kind: r.kind as NarrationEntry['kind'],
      text: r.text,
      timestamp: r.ts,
      images: r.images ? (JSON.parse(r.images) as string[]) : [],
      tool: r.tool ? JSON.parse(r.tool) : undefined,
    }))
  }

  /** Replies are keyed by their CONTENT HASH (see directiveId), so re-reading a transcript
   *  after a relaunch reproduces the same id and this becomes a no-op rather than a duplicate. */
  appendReply(id: string, sessionId: string, projectId: string, to: string, text: string, ts: string): void {
    this.db.prepare(
      `INSERT INTO replies (id, project_id, session_id, to_target, text, ts)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
    ).run(id, projectId, sessionId, to, text, ts)
  }

  replies(projectId: string): ProjectReply[] {
    const rows = this.db.prepare(
      'SELECT id, session_id, to_target, text, ts FROM replies WHERE project_id = ? ORDER BY ts',
    ).all(projectId) as Array<{ id: string; session_id: string; to_target: string; text: string; ts: string }>
    return rows.map((r) => ({ id: r.id, sessionId: r.session_id, to: r.to_target, text: r.text, timestamp: r.ts }))
  }

  close(): void { this.db.close() }
}

/** THE ARTIFACT PLANE. Lanes write here from their own processes, through Operator's MCP
 *  server; the app reads. Phase 1 is lane→Operator only — nothing pushes into a lane. */
export class ArtifactStore {
  private readonly db: Database.Database

  constructor(path = join(operatorDir(), 'artifacts.db')) {
    this.db = openDb(path)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reports (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        at          TEXT NOT NULL,
        terminal_id TEXT NOT NULL,
        project_id  TEXT,
        role_id     TEXT,
        task_id     TEXT,
        summary     TEXT NOT NULL,
        artifacts   TEXT NOT NULL DEFAULT '[]',
        seen        INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS reports_seen ON reports (seen, id);
      CREATE TABLE IF NOT EXISTS task_status (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        at          TEXT NOT NULL,
        terminal_id TEXT NOT NULL,
        project_id  TEXT,
        task_id     TEXT NOT NULL,
        status      TEXT NOT NULL,
        applied     INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS task_status_applied ON task_status (applied, id);
    `)
  }

  insertReport(at: string, terminalId: string, projectId: string | null, roleId: string | null, taskId: string | null, summary: string, artifactsJson: string): number {
    const r = this.db.prepare(
      `INSERT INTO reports (at, terminal_id, project_id, role_id, task_id, summary, artifacts)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(at, terminalId, projectId, roleId, taskId, summary, artifactsJson)
    return Number(r.lastInsertRowid)
  }

  insertStatus(at: string, terminalId: string, projectId: string | null, taskId: string, status: string): number {
    const r = this.db.prepare(
      'INSERT INTO task_status (at, terminal_id, project_id, task_id, status) VALUES (?, ?, ?, ?, ?)',
    ).run(at, terminalId, projectId, taskId, status)
    return Number(r.lastInsertRowid)
  }

  listReports(limit: number): ArtifactReport[] {
    const rows = this.db.prepare(
      'SELECT id, at, terminal_id, project_id, role_id, task_id, summary, artifacts FROM reports ORDER BY id DESC LIMIT ?',
    ).all(limit) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      id: Number(r.id), at: String(r.at), terminalId: String(r.terminal_id),
      projectId: (r.project_id as string) ?? undefined, roleId: (r.role_id as string) ?? undefined,
      taskId: (r.task_id as string) ?? undefined, summary: String(r.summary),
      // The RAW JSON string, not a parsed array: `ArtifactReport.artifacts` is declared as
      // `string` in shared/types.ts and the renderer parses it itself. Handing it an array
      // here would have it call JSON.parse on an object.
      artifacts: String(r.artifacts ?? '[]'),
    }))
  }

  pendingStatus(): ArtifactStatusEvent[] {
    const rows = this.db.prepare(
      'SELECT id, at, terminal_id, project_id, task_id, status FROM task_status WHERE applied = 0 ORDER BY id',
    ).all() as Array<Record<string, unknown>>
    return rows.map((r) => ({
      id: Number(r.id), at: String(r.at), terminalId: String(r.terminal_id),
      projectId: (r.project_id as string) ?? undefined, taskId: String(r.task_id), status: String(r.status),
    }))
  }

  /** Acked AFTER the task is written through, so a crash REPLAYS a status rather than dropping
   *  it. That ordering is the whole reason this is a two-step protocol. */
  markApplied(ids: number[]): void {
    if (!ids.length) return
    const stmt = this.db.prepare('UPDATE task_status SET applied = 1 WHERE id = ?')
    this.db.transaction((xs: number[]) => { for (const id of xs) stmt.run(id) })(ids)
  }

  close(): void { this.db.close() }
}
