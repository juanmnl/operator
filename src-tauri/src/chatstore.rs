// Durable chat store for the reading panel. The transcript tailer accumulates the
// agent's answers (crate::backend::NarrationEntry) but only keeps a bounded tail in
// memory (NARRATION_CAP) and re-derives everything from the transcript on each launch.
// This persists every entry to SQLite (~/.operator/chat.db) so the full history
// survives restarts + transcript rotation, and the panel can load it directly instead
// of re-parsing a re-sent tail every session:update.
//
// Idempotency: each entry is keyed by (session_id, seq) where seq is a per-session
// monotonic counter assigned in transcript order. The tailer re-reads the transcript
// from the start on every launch, reproducing the same (session_id, seq) pairs, so
// `INSERT OR IGNORE` makes re-persisting a no-op — no duplicates.

use crate::backend::{NarrationEntry, ToolBlock};
use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::Mutex;

pub struct ChatStore {
    // rusqlite::Connection isn't Sync; a Mutex lets the tailer thread (writes) and
    // command handlers (reads) share one connection. Writes are tiny + infrequent.
    conn: Mutex<Connection>,
}

impl ChatStore {
    /// Open (or create) the store at `path`. Falls back to an in-memory database if
    /// the file can't be opened, so the app always has a working store (just not
    /// durable) rather than failing to launch.
    pub fn open(path: &Path) -> ChatStore {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let conn = Connection::open(path).unwrap_or_else(|_| {
            Connection::open_in_memory().expect("in-memory sqlite always opens")
        });
        // WAL keeps reads from blocking the tailer's writes.
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        let _ = conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS messages (
                 session_id TEXT NOT NULL,
                 seq        INTEGER NOT NULL,
                 kind       TEXT NOT NULL,
                 text       TEXT NOT NULL,
                 ts         TEXT NOT NULL,
                 images     TEXT,
                 tool       TEXT,
                 PRIMARY KEY (session_id, seq)
             );",
        );
        // Migrate DBs created before the `images` column (dropped-image paths, JSON).
        // Errors harmlessly if the column already exists.
        let _ = conn.execute("ALTER TABLE messages ADD COLUMN images TEXT", []);
        // Same additive migration for the structured tool block. Rows written before it keep
        // loading — the column is NULL and `tool` deserializes to None.
        let _ = conn.execute("ALTER TABLE messages ADD COLUMN tool TEXT", []);
        purge_injected_rows(&conn, path);
        ChatStore {
            conn: Mutex::new(conn),
        }
    }

    /// Append narration entries idempotently. `entries` is (seq, entry) pairs; the
    /// `INSERT OR IGNORE` on the (session_id, seq) primary key drops rows already
    /// persisted (e.g. re-read after a relaunch).
    pub fn append(&self, session_id: &str, entries: &[(u64, NarrationEntry)]) {
        if entries.is_empty() {
            return;
        }
        let Ok(mut conn) = self.conn.lock() else { return };
        let Ok(tx) = conn.transaction() else { return };
        {
            let Ok(mut stmt) = tx.prepare_cached(
                // UPSERT, not INSERT OR IGNORE: a tool row is written when the CALL is seen and
                // rewritten when its RESULT arrives (the output attaches later), so
                // ignore-on-conflict silently dropped every captured result. Re-persisting an
                // identical row is still a no-op in effect, so the idempotency the tailer
                // relies on is unchanged.
                "INSERT INTO messages (session_id, seq, kind, text, ts, images, tool)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(session_id, seq) DO UPDATE SET
                   kind = excluded.kind, text = excluded.text, ts = excluded.ts,
                   images = excluded.images, tool = excluded.tool",
            ) else {
                return;
            };
            for (seq, e) in entries {
                // Store image paths as a JSON array; NULL when there are none.
                let images: Option<String> = if e.images.is_empty() {
                    None
                } else {
                    serde_json::to_string(&e.images).ok()
                };
                let tool: Option<String> = e.tool.as_ref().and_then(|t| serde_json::to_string(t).ok());
                let _ = stmt.execute(params![session_id, *seq as i64, e.kind, e.text, e.timestamp, images, tool]);
            }
        }
        let _ = tx.commit();
    }

    /// All persisted entries for a session, in transcript order.
    pub fn load(&self, session_id: &str) -> Vec<NarrationEntry> {
        let Ok(conn) = self.conn.lock() else { return Vec::new() };
        let Ok(mut stmt) = conn.prepare_cached(
            "SELECT kind, text, ts, images, tool FROM messages WHERE session_id = ?1 ORDER BY seq ASC",
        ) else {
            return Vec::new();
        };
        let rows = stmt.query_map(params![session_id], |r| {
            let images = r
                .get::<_, Option<String>>(3)?
                .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
                .unwrap_or_default();
            let tool = r
                .get::<_, Option<String>>(4)?
                .and_then(|s| serde_json::from_str::<ToolBlock>(&s).ok());
            Ok(NarrationEntry {
                kind: r.get(0)?,
                text: r.get(1)?,
                timestamp: r.get(2)?,
                images,
                tool,
            })
        });
        match rows {
            Ok(it) => it.filter_map(|r| r.ok()).collect(),
            Err(_) => Vec::new(),
        }
    }
}

/// Schema/data version. Bump when a one-time data migration is added below.
const SCHEMA_VERSION: i32 = 1;

/// The same prefixes as `transcript::is_injected_turn` — keep the two lists in sync. Written
/// as SQL patterns so the delete matches exactly what the parser and the renderer filter.
const INJECTED_PREFIXES: [&str; 7] = [
    "<local-command-%", "<command-name>%", "<command-message>%", "<command-args>%",
    "<system-reminder>%", "<task-notification>%", "<synthetic>%",
];

/// ONE-TIME cleanup of Claude Code's plumbing turns that were persisted before the parser
/// learned to drop them (measured on a real store: 191 rows across 33 sessions).
///
/// The renderer filters these anyway — `lib/chat-turns.isRenderableTurn` — so this is about the
/// store, not about correctness on screen; both guards stay. Deleting them here means the rows
/// stop being loaded, searched and shipped to the renderer on every session open.
///
/// Guarded by `PRAGMA user_version` so it runs exactly once per database, and it takes a FILE
/// BACKUP first: this is the only destructive statement in the app, and a bad prefix would eat
/// real conversation. The backup is written beside the db as `chat.db.pre-v1.bak` and is never
/// cleaned up automatically — it is the user's undo.
///
/// Deleting rows leaves gaps in `seq`. That is safe: `load` orders by seq and never assumes it
/// is dense, and the next seq comes from the tracker's own counter, not from the store.
fn purge_injected_rows(conn: &Connection, path: &Path) {
    let version: i32 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap_or(0);
    if version >= SCHEMA_VERSION {
        return;
    }
    let where_sql = INJECTED_PREFIXES
        .iter()
        .map(|_| "text LIKE ?")
        .collect::<Vec<_>>()
        .join(" OR ");
    let params: Vec<&dyn rusqlite::ToSql> = INJECTED_PREFIXES.iter().map(|p| p as &dyn rusqlite::ToSql).collect();

    // Count first — a backup is only worth writing if there is something to lose.
    let doomed: i64 = conn
        .query_row(&format!("SELECT COUNT(*) FROM messages WHERE {where_sql}"), params.as_slice(), |r| r.get(0))
        .unwrap_or(0);
    if doomed > 0 && path != Path::new(":memory:") {
        // Checkpoint first, or the backup copy misses everything still sitting in the WAL.
        let _ = conn.pragma_update(None, "wal_checkpoint", "TRUNCATE");
        let backup = path.with_extension("db.pre-v1.bak");
        if std::fs::copy(path, &backup).is_err() {
            // No backup, no delete. Leaving the rows is harmless (the renderer hides them);
            // deleting them without an undo is not.
            return;
        }
    }
    if doomed > 0 {
        let _ = conn.execute(&format!("DELETE FROM messages WHERE {where_sql}"), params.as_slice());
    }
    let _ = conn.pragma_update(None, "user_version", SCHEMA_VERSION);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::NarrationEntry;

    fn entry(kind: &str, text: &str, ts: &str) -> NarrationEntry {
        NarrationEntry { kind: kind.into(), text: text.into(), timestamp: ts.into(), images: Vec::new() , tool: None}
    }

    /// The durability contract: a row written before the `tool` column existed must still
    /// load. Simulated by writing through the pre-migration schema and reading after it.
    /// The one-time purge: plumbing rows go, real conversation stays, and it runs once.
    #[test]
    fn injected_rows_are_purged_once() {
        let store = ChatStore::open(Path::new(":memory:"));
        store.append("s1", &[
            (0, entry("user", "<local-command-caveat>Caveat: …</local-command-caveat>", "t0")),
            (1, entry("user", "<command-name>/compact</command-name>", "t1")),
            (2, entry("user", "<task-notification>done</task-notification>", "t2")),
            (3, entry("user", "<system-reminder>plan mode</system-reminder>", "t3")),
            (4, entry("user", "hi", "t4")),
            (5, entry("text", "Done.", "t5")),
            // A genuine prompt that merely STARTS with markup must survive — the prefixes are
            // exact, not "anything in angle brackets".
            (6, entry("user", "<Modal> crashes on mount", "t6")),
        ]);
        {
            let conn = store.conn.lock().unwrap();
            // The store was opened before these rows existed, so run the purge now.
            conn.pragma_update(None, "user_version", 0).unwrap();
            purge_injected_rows(&conn, Path::new(":memory:"));
        }
        let got = store.load("s1");
        assert_eq!(got.iter().map(|e| e.text.as_str()).collect::<Vec<_>>(),
                   vec!["hi", "Done.", "<Modal> crashes on mount"]);

        // Idempotent: a second open must not re-run (and must not touch newly arrived rows).
        store.append("s1", &[(7, entry("user", "<system-reminder>later</system-reminder>", "t7"))]);
        {
            let conn = store.conn.lock().unwrap();
            purge_injected_rows(&conn, Path::new(":memory:"));
        }
        assert_eq!(store.load("s1").len(), 4, "purge must run once, not on every open");
    }

    #[test]
    fn rows_written_before_the_tool_column_still_load() {
        let store = ChatStore::open(Path::new(":memory:"));
        {
            let conn = store.conn.lock().unwrap();
            conn.execute("DROP TABLE messages", []).unwrap();
            conn.execute(
                "CREATE TABLE messages (session_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
                 text TEXT NOT NULL, ts TEXT NOT NULL, images TEXT, PRIMARY KEY (session_id, seq))", []).unwrap();
            conn.execute("INSERT INTO messages VALUES ('s1', 0, 'user', 'old row', 't0', NULL)", []).unwrap();
            // The migration the constructor performs on an existing db.
            conn.execute("ALTER TABLE messages ADD COLUMN tool TEXT", []).unwrap();
        }
        let got = store.load("s1");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].text, "old row");
        assert!(got[0].tool.is_none());
    }

    #[test]
    fn tool_blocks_roundtrip() {
        let store = ChatStore::open(Path::new(":memory:"));
        let mut e = entry("tool", "Bash npm test", "t0");
        e.tool = Some(ToolBlock {
            name: "Bash".into(),
            target: Some("npm test".into()),
            caller: Some("subagent-7".into()),
            output: "ok".into(),
            output_chars: 2,
            truncated: false,
            id: Some("tu_1".into()),
        });
        store.append("s1", &[(0, e)]);
        let got = store.load("s1");
        let tb = got[0].tool.as_ref().expect("tool block lost in the store");
        assert_eq!(tb.name, "Bash");
        assert_eq!(tb.caller.as_deref(), Some("subagent-7"));
        assert_eq!(tb.output_chars, 2);
    }

    #[test]
    fn append_then_load_roundtrips_in_order() {
        let store = ChatStore::open(Path::new(":memory:"));
        store.append(
            "s1",
            &[
                (0, entry("user", "hello", "t0")),
                (1, entry("text", "hi there", "t1")),
            ],
        );
        let got = store.load("s1");
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].text, "hello");
        assert_eq!(got[1].kind, "text");
    }

    #[test]
    fn append_is_idempotent_on_session_seq() {
        let store = ChatStore::open(Path::new(":memory:"));
        let batch = [(0, entry("text", "once", "t0"))];
        store.append("s1", &batch);
        store.append("s1", &batch); // re-read after relaunch — must not duplicate
        assert_eq!(store.load("s1").len(), 1);
    }

    #[test]
    fn images_roundtrip() {
        let store = ChatStore::open(Path::new(":memory:"));
        let mut e = entry("user", "[Image #1] look at this", "t0");
        e.images = vec!["/x/img-cache/abc.jpg".into(), "/x/img-cache/def.png".into()];
        store.append("s1", &[(0, e), (1, entry("text", "answer", "t1"))]);
        let got = store.load("s1");
        assert_eq!(got[0].images, vec!["/x/img-cache/abc.jpg".to_string(), "/x/img-cache/def.png".to_string()]);
        assert!(got[1].images.is_empty()); // text answers carry no images
    }

    #[test]
    fn sessions_are_isolated() {
        let store = ChatStore::open(Path::new(":memory:"));
        store.append("a", &[(0, entry("text", "a-msg", "t0"))]);
        store.append("b", &[(0, entry("text", "b-msg", "t0"))]);
        assert_eq!(store.load("a").len(), 1);
        assert_eq!(store.load("a")[0].text, "a-msg");
        assert_eq!(store.load("b")[0].text, "b-msg");
    }
}
