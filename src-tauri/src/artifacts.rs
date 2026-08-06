// THE ARTIFACT PLANE'S STORE — dev/briefs/2026-08-05-artifact-plane.md, phase 1.
//
// The defect this exists to remove: **artifacts are addressed by filesystem path, and each lane
// has a different filesystem.** A `*-RESULT.md` written inside a worktree is invisible to the
// coordinator and to every other lane, by construction. Tonight's audit found 20 such files,
// three of them RESULTs believed never written.
//
// So the store lives OUTSIDE every worktree and outside git: `~/.operator/artifacts.db`, beside
// the durable state that already works this way (`sessions.json`, `projects.json`, `chat.db`).
//
// A SIBLING OF `chat.db`, NOT A TABLE INSIDE IT. The brief allows either. Separate wins because
// two processes write here that never touch chat.db — the app AND a short-lived MCP server
// spawned per lane — and `chat.db` has a migration/backup history (`chatstore.rs`'s
// `.pre-v1.bak`) that should not acquire a second concurrent writer. A new file has no such
// history to protect.
//
// APPEND-ONLY, AND THAT IS THE CONCURRENCY DESIGN. The MCP server only ever INSERTs; the app only
// ever reads and marks rows applied. Neither updates a row the other might be writing, so the two
// processes never contend for the same bytes — which is also why `task_status` does not write
// `projects.json` directly. `projects.json` has exactly one writer (the renderer) and gains
// nothing from a second one racing it; a status arrives here as an EVENT and the renderer applies
// it on its next poll, keeping the single-writer rule that store already depends on.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use serde::Serialize;

pub fn artifacts_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    Path::new(&home).join(".operator").join("artifacts.db")
}

/// A lane's report, as Operator reads it back.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub id: i64,
    pub at: String,
    pub terminal_id: String,
    pub project_id: Option<String>,
    pub role_id: Option<String>,
    pub task_id: Option<String>,
    pub summary: String,
    /// Named blobs, JSON-encoded `[{name, content}]`. CONTENT, never a path into the caller's
    /// worktree — a path is the thing this whole plane exists to stop shipping.
    pub artifacts: String,
}

/// A completion signal, before the app has applied it.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StatusEvent {
    pub id: i64,
    pub at: String,
    pub terminal_id: String,
    pub project_id: Option<String>,
    pub task_id: String,
    pub status: String,
}

pub fn open() -> Result<Connection, String> {
    let path = artifacts_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    init(&conn)?;
    Ok(conn)
}

pub fn init(conn: &Connection) -> Result<(), String> {
    // WAL so the app can read while a lane's server is mid-write. Without it a reader takes a
    // lock that makes an unrelated lane's `operator__report` fail — a report lost to a lock is
    // the same outcome as a report lost to a worktree.
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS reports (
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
         CREATE INDEX IF NOT EXISTS task_status_applied ON task_status (applied, id);",
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn insert_report(
    conn: &Connection,
    at: &str,
    terminal_id: &str,
    project_id: Option<&str>,
    role_id: Option<&str>,
    task_id: Option<&str>,
    summary: &str,
    artifacts_json: &str,
) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO reports (at, terminal_id, project_id, role_id, task_id, summary, artifacts)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![at, terminal_id, project_id, role_id, task_id, summary, artifacts_json],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

pub fn insert_status(
    conn: &Connection,
    at: &str,
    terminal_id: &str,
    project_id: Option<&str>,
    task_id: &str,
    status: &str,
) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO task_status (at, terminal_id, project_id, task_id, status)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![at, terminal_id, project_id, task_id, status],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

/// Most recent reports first. `limit` bounds it because this feeds a UI list, not a sync.
pub fn list_reports(conn: &Connection, limit: u32) -> Result<Vec<Report>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, at, terminal_id, project_id, role_id, task_id, summary, artifacts
             FROM reports ORDER BY id DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![limit], |r| {
            Ok(Report {
                id: r.get(0)?,
                at: r.get(1)?,
                terminal_id: r.get(2)?,
                project_id: r.get(3)?,
                role_id: r.get(4)?,
                task_id: r.get(5)?,
                summary: r.get(6)?,
                artifacts: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Status events the app has not applied yet. Oldest first — two events for one task must be
/// applied in the order the lane emitted them.
pub fn pending_status(conn: &Connection) -> Result<Vec<StatusEvent>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, at, terminal_id, project_id, task_id, status
             FROM task_status WHERE applied = 0 ORDER BY id ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(StatusEvent {
                id: r.get(0)?,
                at: r.get(1)?,
                terminal_id: r.get(2)?,
                project_id: r.get(3)?,
                task_id: r.get(4)?,
                status: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Marked applied only AFTER the renderer has written the task through — so a renderer that dies
/// mid-apply re-applies rather than dropping the signal. Applying twice is harmless (setting a
/// task to `done` twice is the same task); dropping once is the leak this whole tool exists to fix.
pub fn mark_status_applied(conn: &Connection, ids: &[i64]) -> Result<(), String> {
    for id in ids {
        conn.execute("UPDATE task_status SET applied = 1 WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        init(&c).unwrap();
        c
    }

    #[test]
    fn a_report_survives_the_process_that_wrote_it() {
        let c = db();
        insert_report(&c, "2026-08-05T00:00:00Z", "t7", Some("proj"), Some("code"), Some("task-1"),
            "did the thing", r#"[{"name":"notes.md","content":"body"}]"#).unwrap();
        let all = list_reports(&c, 10).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].terminal_id, "t7");
        assert_eq!(all[0].task_id.as_deref(), Some("task-1"));
        // The ARTIFACT IS CONTENT, not a path — the entire point of the plane.
        assert!(all[0].artifacts.contains("body"));
    }

    #[test]
    fn reports_come_back_newest_first_and_bounded() {
        let c = db();
        for i in 0..5 {
            insert_report(&c, "t", "t1", None, None, None, &format!("r{i}"), "[]").unwrap();
        }
        let all = list_reports(&c, 3).unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].summary, "r4");
    }

    #[test]
    fn status_events_are_pending_until_applied_and_replay_if_not() {
        let c = db();
        let a = insert_status(&c, "t", "t1", Some("p"), "task-1", "done").unwrap();
        insert_status(&c, "t", "t1", Some("p"), "task-2", "done").unwrap();
        assert_eq!(pending_status(&c).unwrap().len(), 2);
        mark_status_applied(&c, &[a]).unwrap();
        let left = pending_status(&c).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].task_id, "task-2");
        // A renderer that died before marking sees the event again — dropping one is the leak.
        assert_eq!(pending_status(&c).unwrap().len(), 1);
    }

    #[test]
    fn pending_status_is_oldest_first_so_two_events_for_one_task_apply_in_order() {
        let c = db();
        insert_status(&c, "t", "t1", None, "task-1", "running").unwrap();
        insert_status(&c, "t", "t1", None, "task-1", "done").unwrap();
        let p = pending_status(&c).unwrap();
        assert_eq!(p.iter().map(|e| e.status.as_str()).collect::<Vec<_>>(), vec!["running", "done"]);
    }

    #[test]
    fn opening_an_existing_db_keeps_its_rows() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("artifacts.db");
        {
            let c = Connection::open(&path).unwrap();
            init(&c).unwrap();
            insert_report(&c, "t", "t1", None, None, None, "kept", "[]").unwrap();
        }
        let c = Connection::open(&path).unwrap();
        init(&c).unwrap(); // CREATE TABLE IF NOT EXISTS must be a no-op here
        assert_eq!(list_reports(&c, 10).unwrap().len(), 1);
    }
}
