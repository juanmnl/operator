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

use crate::backend::NarrationEntry;
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
                 PRIMARY KEY (session_id, seq)
             );",
        );
        // Migrate DBs created before the `images` column (dropped-image paths, JSON).
        // Errors harmlessly if the column already exists.
        let _ = conn.execute("ALTER TABLE messages ADD COLUMN images TEXT", []);
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
                "INSERT OR IGNORE INTO messages (session_id, seq, kind, text, ts, images)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
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
                let _ = stmt.execute(params![session_id, *seq as i64, e.kind, e.text, e.timestamp, images]);
            }
        }
        let _ = tx.commit();
    }

    /// All persisted entries for a session, in transcript order.
    pub fn load(&self, session_id: &str) -> Vec<NarrationEntry> {
        let Ok(conn) = self.conn.lock() else { return Vec::new() };
        let Ok(mut stmt) = conn.prepare_cached(
            "SELECT kind, text, ts, images FROM messages WHERE session_id = ?1 ORDER BY seq ASC",
        ) else {
            return Vec::new();
        };
        let rows = stmt.query_map(params![session_id], |r| {
            let images = r
                .get::<_, Option<String>>(3)?
                .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
                .unwrap_or_default();
            Ok(NarrationEntry {
                kind: r.get(0)?,
                text: r.get(1)?,
                timestamp: r.get(2)?,
                images,
            })
        });
        match rows {
            Ok(it) => it.filter_map(|r| r.ok()).collect(),
            Err(_) => Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::NarrationEntry;

    fn entry(kind: &str, text: &str, ts: &str) -> NarrationEntry {
        NarrationEntry { kind: kind.into(), text: text.into(), timestamp: ts.into(), images: Vec::new() }
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
