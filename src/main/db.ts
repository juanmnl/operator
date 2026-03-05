import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { AuditEntry, OperatorRequest, OperatorResponse } from '../shared/types'

let db: Database.Database

export function initDb(): void {
  const dbPath = join(app.getPath('userData'), 'audit.db')
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit (
      id TEXT PRIMARY KEY,
      request TEXT NOT NULL,
      response TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
}

export function logEntry(request: OperatorRequest, response: OperatorResponse): void {
  db.prepare('INSERT INTO audit (id, request, response) VALUES (?, ?, ?)').run(
    request.id,
    JSON.stringify(request),
    JSON.stringify(response)
  )
}

export function getHistory(limit = 50): AuditEntry[] {
  const rows = db
    .prepare('SELECT id, request, response FROM audit ORDER BY created_at DESC LIMIT ?')
    .all(limit) as { id: string; request: string; response: string }[]

  return rows.map((row) => ({
    id: row.id,
    request: JSON.parse(row.request),
    response: JSON.parse(row.response)
  }))
}
