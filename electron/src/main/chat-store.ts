// The durable chat store and the artifact plane — `~/.operator/chat.db` and
// `~/.operator/artifacts.db`. Mirrors `src-tauri/src/chatstore.rs` and `artifacts.rs`.
//
// A RETURN TRIP: `docs/tauri-migration.md` records this leaving `better-sqlite3` for `rusqlite`
// when the app moved to Tauri. The schema comes back unchanged, which is the point — an
// existing `chat.db` must open and read correctly under the new shell, so the DDL here is the
// Rust's DDL, column for column.
import Database from 'better-sqlite3'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { operatorDir } from './store'

// The renderer's own types — see the note in transcript.ts.
import type { NarrationEntry, ProjectReply, ArtifactReport, ArtifactStatusEvent } from '../../../src/shared/types'
export type { NarrationEntry, ProjectReply, ArtifactReport, ArtifactStatusEvent }

const SCHEMA_VERSION = 1

/** The same prefixes as `isInjectedTurn` in transcript.ts — keep the two lists in sync. Written
 *  as SQL patterns so the delete matches exactly what the parser and the renderer filter. */
const INJECTED_PREFIXES = [
  '<local-command-%', '<command-name>%', '<command-message>%', '<command-args>%',
  '<system-reminder>%', '<task-notification>%', '<synthetic>%',
]

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
    this.purgeInjectedRows(path)
  }

  /** ONE-TIME cleanup of Claude Code's plumbing turns that were persisted before the parser
   *  learned to drop them (measured on a real store: 191 rows across 33 sessions).
   *
   *  The renderer filters these anyway (`lib/chat-turns.isRenderableTurn`), so this is about the
   *  store rather than about correctness on screen — both guards stay. Deleting them here means
   *  the rows stop being loaded, searched and shipped to the renderer on every session open.
   *
   *  Guarded by `PRAGMA user_version` so it runs exactly once per database, and it takes a FILE
   *  BACKUP first: this is the only destructive statement in the app, and a bad prefix would eat
   *  real conversation. The backup sits beside the db as `chat.db.pre-v1.bak` and is never
   *  cleaned up automatically — it is the user's undo.
   *
   *  Deleting rows leaves gaps in `seq`. That is safe: `load` orders by seq and never assumes it
   *  is dense, and the next seq comes from the tailer's own counter, not from the store. */
  private purgeInjectedRows(path: string): void {
    const version = Number((this.db.pragma('user_version', { simple: true }) as number) ?? 0)
    if (version >= SCHEMA_VERSION) return

    const where = INJECTED_PREFIXES.map(() => 'text LIKE ?').join(' OR ')
    // Count first — a backup is only worth writing if there is something to lose.
    const doomed = Number((this.db.prepare(`SELECT COUNT(*) c FROM messages WHERE ${where}`)
      .get(...INJECTED_PREFIXES) as { c: number }).c)

    if (doomed > 0 && path !== ':memory:') {
      // Checkpoint first, or the backup copy misses everything still sitting in the WAL.
      this.db.pragma('wal_checkpoint(TRUNCATE)')
      try {
        copyFileSync(path, `${path}.pre-v1.bak`)
      } catch {
        // NO BACKUP, NO DELETE. Leaving the rows is harmless (the renderer hides them);
        // deleting them without an undo is not.
        return
      }
    }
    if (doomed > 0) this.db.prepare(`DELETE FROM messages WHERE ${where}`).run(...INJECTED_PREFIXES)
    this.db.pragma(`user_version = ${SCHEMA_VERSION}`)
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

/** Bumped when a one-time data migration is added to `ArtifactStore`. Tracked in
 *  `artifacts.db`'s own `PRAGMA user_version`, which is independent of `chat.db`'s. */
const ARTIFACTS_SCHEMA_VERSION = 1

/** THE ARTIFACT PLANE. Lanes write here from their own processes, through Operator's MCP
 *  server; the app reads. Phase 1 is lane→Operator only — nothing pushes into a lane. */
/** One `reports` row → the shape the renderer is typed against.
 *
 *  `artifacts` stays the RAW JSON STRING, not a parsed array: `ArtifactReport.artifacts` is
 *  declared as `string` in shared/types.ts and the renderer parses it itself. Handing it an array
 *  here would have it call JSON.parse on an object. */
function rowToReport(r: Record<string, unknown>): ArtifactReport {
  return {
    id: Number(r.id), at: String(r.at), terminalId: String(r.terminal_id),
    projectId: (r.project_id as string) ?? undefined, roleId: (r.role_id as string) ?? undefined,
    taskId: (r.task_id as string) ?? undefined, summary: String(r.summary),
    artifacts: String(r.artifacts ?? '[]'),
    toRole: (r.to_role as string) ?? undefined,
    deliveredAt: (r.delivered_at as string) ?? undefined,
    ackedAt: (r.acked_at as string) ?? undefined,
  }
}

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
    this.migrateReports()
    this.backfillDelivered()
  }

  /** THE BACKFILL, run exactly once per database.
   *
   *  `delivered_at` arrived long after the table did, so every row written before that migration
   *  has it NULL — 310 of them, back to 2026-08-06 — and `undeliveredFor` read the whole backlog
   *  as "never announced" and replayed it at the coordinator on every launch, one pty line per
   *  row. Those rows are not undelivered; they are from before anything recorded delivery.
   *
   *  `delivered_at = at` rather than a timestamp of the migration: the claim being written is
   *  "this one had its moment", and `at` is when that moment was. It also keeps the column
   *  honest for the Inbox, which shows the value.
   *
   *  WHY NOT A TIME CUTOFF (this shipped as one first, and it was wrong): "ignore anything older
   *  than app launch" also silences reports a lane files while the app is CLOSED, which is
   *  exactly when a lane is most likely to be working unattended. A one-time backfill divides on
   *  the migration, not on the clock, so history goes quiet and everything filed afterwards is
   *  still announced whenever the app next opens.
   *
   *  NOT AN ACK. These rows stay `acked_at IS NULL`, so the Inbox still shows them unread and
   *  still counts them — announced and read are different facts, and only a human opening one
   *  writes the second.
   *
   *  Guarded by `PRAGMA user_version`, the same mechanism `ChatStore.purgeInjectedRows` uses. No
   *  backup is taken here because nothing is destroyed: one NULL column becomes a timestamp that
   *  was already in the row next to it.
   *
   *  ONE TRANSACTION, AND IT MUST BE `immediate()`. Any process that opens this database may be
   *  the one to run it — the app, or any lane's `mcp-serve` — and they routinely open it at the
   *  same moment, on the same WAL file. Read-check, UPDATE and set-version as three loose
   *  statements can interleave: both processes read version 0, one runs the UPDATE and stamps 1,
   *  and the second's UPDATE — now running AFTER a report the first process's caller has already
   *  inserted — marks that fresh report delivered and it is never announced. `BEGIN IMMEDIATE`
   *  takes the write lock at the top, so the loser waits and then reads version 1 and does
   *  nothing, which is the whole contract this migration rests on. */
  private backfillDelivered(): void {
    this.db.transaction(() => {
      const version = Number((this.db.pragma('user_version', { simple: true }) as number) ?? 0)
      if (version >= ARTIFACTS_SCHEMA_VERSION) return
      this.db.prepare('UPDATE reports SET delivered_at = at WHERE delivered_at IS NULL').run()
      this.db.pragma(`user_version = ${ARTIFACTS_SCHEMA_VERSION}`)
    }).immediate()
  }

  /** THE LIFECYCLE COLUMNS, added rather than replacing anything.
   *
   *  A report row used to mean only "this exists in a table", which stood in for "it reached
   *  someone" — and for the whole life of the Electron shell nothing read the table at all, so the
   *  two were very far apart. `to_role` says who it is FOR (it used to implicitly mean "the
   *  coordinator" and nothing else); `delivered_at` is set when a human or the coordinator has
   *  actually been shown it; `acked_at` when someone opened it. written → delivered → acked.
   *
   *  `ALTER TABLE … ADD COLUMN` per column, each tolerated if it is already there: SQLite has no
   *  `IF NOT EXISTS` for columns, and this database has 298 rows of real history that a
   *  drop-and-recreate would throw away. */
  private migrateReports(): void {
    for (const col of ['to_role TEXT', 'delivered_at TEXT', 'acked_at TEXT']) {
      try { this.db.exec(`ALTER TABLE reports ADD COLUMN ${col}`) } catch { /* already present */ }
    }
  }

  insertReport(at: string, terminalId: string, projectId: string | null, roleId: string | null, taskId: string | null, summary: string, artifactsJson: string, toRole: string | null = null): number {
    const r = this.db.prepare(
      `INSERT INTO reports (at, terminal_id, project_id, role_id, task_id, summary, artifacts, to_role)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(at, terminalId, projectId, roleId, taskId, summary, artifactsJson, toRole)
    return Number(r.lastInsertRowid)
  }

  /** Mark a report as SHOWN to its recipient. Idempotent — the first delivery is the one that
   *  counts, and a second announcement of the same report is the noise this timestamp prevents.
   *
   *  DELIVERY ONLY. It does not touch `acked_at` or `seen`: announcing a report to a lane is not
   *  a human reading it, and writing the ack here would empty the Inbox's unread count for
   *  messages nobody has opened. The caller writes this AFTER the announcement has actually gone
   *  into the composer, so an announce that fails or is skipped leaves the row announceable.
   *
   *  `at` is an ISO-8601 UTC string, the same format `insertReport` is given for `at` (both come
   *  from `new Date().toISOString()` — the MCP server's for the row, `ipc.ts`'s for this). The
   *  column is only ever read back for display and for an IS NULL test, never compared against
   *  another timestamp, so the format is a display contract rather than an ordering one. */
  markReportDelivered(id: number, at: string): void {
    this.db.prepare('UPDATE reports SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL').run(at, id)
  }

  /** Mark a report as OPENED. This is the only signal in the system that a report was actually
   *  read, as opposed to written, stored, or announced. */
  markReportAcked(id: number, at: string): void {
    this.db.prepare('UPDATE reports SET acked_at = ?, seen = 1 WHERE id = ?').run(at, id)
  }

  /** Undo an ack: clears `acked_at` AND `seen`, putting the row back exactly as
   *  `markReportAcked` found it. Delivery is left alone — it was still announced, and claiming
   *  otherwise would announce it again.
   *
   *  NO LONGER REACHABLE. It existed for the Inbox's `mark unread` control, which made
   *  ack-on-open safe to have; the mailbox — the ack, the unread dot and that control — was cut
   *  on 2026-08-29, and `artifactMarkUnread` went with it from the IPC surface. Kept because the
   *  column and its historical values are still in the store, so the write that undoes an ack
   *  should not have to be rewritten if anything ever reads them again. */
  markReportUnread(id: number): void {
    this.db.prepare('UPDATE reports SET acked_at = NULL, seen = 0 WHERE id = ?').run(id)
  }

  /** Reports written for `role` that have never been delivered, oldest first — the queue the
   *  idle announcement drains. Oldest first because a backlog should be read in the order it
   *  happened, not newest-first like a browsing list.
   *
   *  SCOPED BY PROJECT, because this database is not. `~/.operator/artifacts.db` is ONE global
   *  store for every project on the machine, and the queue was filtered by role alone — so a
   *  `code` lane reporting in `uwazi-app` was announced into the composer of the `operator` lane
   *  of whatever project happened to be open, with a summary about a repo that coordinator has
   *  never seen. Observed: reports #313/#316/#318, all stamped `project_id=uwazi-app-d9bb8dcc`,
   *  announced to a coordinator working in `operator`.
   *
   *  `project_id IS NULL` still passes. A row that could not name its project is unattributable,
   *  not foreign; dropping it from every queue would make it permanently unannounceable, which is
   *  the silence this whole plane exists to remove. A null-project row is the one case where
   *  showing it to the wrong coordinator beats showing it to nobody.
   *
   *  Omitting `projectId` keeps the old unscoped behaviour, for a caller that genuinely has no
   *  project to scope by (there is none in the app today; the parameter is optional so a bridge
   *  that cannot supply it degrades to what it did before rather than returning nothing). */
  undeliveredFor(role: string, limit: number, projectId?: string | null): ArtifactReport[] {
    const scope = projectId ? ' AND (project_id = ? OR project_id IS NULL)' : ''
    const params: unknown[] = projectId ? [role, projectId, limit] : [role, limit]
    const rows = this.db.prepare(
      `SELECT id, at, terminal_id, project_id, role_id, task_id, summary, artifacts, to_role, delivered_at, acked_at
         FROM reports WHERE delivered_at IS NULL AND (to_role = ? OR to_role IS NULL)${scope}
        ORDER BY id ASC LIMIT ?`,
    ).all(...params) as Array<Record<string, unknown>>
    return rows.map(rowToReport)
  }

  insertStatus(at: string, terminalId: string, projectId: string | null, taskId: string, status: string): number {
    const r = this.db.prepare(
      'INSERT INTO task_status (at, terminal_id, project_id, task_id, status) VALUES (?, ?, ?, ?, ?)',
    ).run(at, terminalId, projectId, taskId, status)
    return Number(r.lastInsertRowid)
  }

  listReports(limit: number): ArtifactReport[] {
    const rows = this.db.prepare(
      `SELECT id, at, terminal_id, project_id, role_id, task_id, summary, artifacts, to_role, delivered_at, acked_at
         FROM reports ORDER BY id DESC LIMIT ?`,
    ).all(limit) as Array<Record<string, unknown>>
    return rows.map(rowToReport)
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
