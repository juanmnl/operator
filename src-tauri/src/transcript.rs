// Transcript-driven session timeline.
//
// Operator reads each launched session's JSONL transcript
// (`~/.claude/projects/<slug>/<session-id>.jsonl`) and reconstructs the
// orchestration timeline from it. The session id is forced at spawn
// (`claude --session-id <uuid>`), so the mapping terminal → transcript is exact.
// This makes Operator a pure observer of what it launched — no global config,
// nothing installed.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{Emitter, Manager};

use crate::backend::{first_line, now_iso, summarize, ActivityEntry, AgentSession, NarrationEntry, Sessions, TodoItem, TokenUsage};
use crate::chatstore::ChatStore;
use crate::PtyManager;

/// Recent assistant prose entries (answers + thinking) retained per session for
/// the reading panel. Bounds the session:update payload on long sessions.
const NARRATION_CAP: usize = 80;

/// Launch info recorded by `terminal_spawn` so the tailer can find and attribute
/// a transcript. `permission_mode` is carried through to the AgentSession for display.
#[derive(Clone)]
pub struct NewTrack {
    pub claude_session_id: String,
    pub cwd: String,
    pub permission_mode: Option<String>,
}

/// Persistent registry keyed by terminal id. `terminal_spawn` writes it; the
/// tailer reads it to begin watching.
#[derive(Default)]
pub struct TrackRegistry {
    map: Mutex<HashMap<String, NewTrack>>,
}

impl TrackRegistry {
    pub fn register(&self, terminal_id: String, t: NewTrack) {
        self.map.lock().unwrap().insert(terminal_id, t);
    }

    fn snapshot(&self) -> Vec<(String, NewTrack)> {
        self.map.lock().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }
}

/// Per-session parser state, owned by the tailer thread.
struct Track {
    terminal_id: String,
    session_id: String,
    cwd: String,
    permission_mode: Option<String>,
    file: Option<PathBuf>,
    offset: u64,
    activity: Vec<ActivityEntry>,
    /// Assistant prose (answers + thinking) for the reading panel, capped to a
    /// recent tail so the emitted session payload stays bounded.
    narration: Vec<NarrationEntry>,
    /// Monotonic index assigned to EVERY narration entry ever pushed (never rewound
    /// by the tail-cap drain). It's the durable (session_id, seq) key for the chat
    /// store; re-reading the transcript after a relaunch reproduces the same seqs, so
    /// persisting is idempotent (INSERT OR IGNORE).
    narration_seq: u64,
    /// New narration entries not yet flushed to the chat store, drained by the tailer
    /// loop each tick. Separate from `narration` because that Vec gets tail-capped.
    pending: Vec<(u64, NarrationEntry)>,
    /// Reconstructed plan (Plan tab) as (id, item) in order. Built from either a
    /// TodoWrite snapshot OR the harness's incremental TaskCreate/TaskUpdate events.
    tasks: Vec<(String, TodoItem)>,
    /// Next id for TaskCreate — matches the harness's sequential "Task #N" since
    /// the tailer reads the transcript from the start.
    task_n: u32,
    summary: Option<String>,
    open_tools: HashSet<String>,
    active_subagents: i32,
    in_sidechain: bool,
    last_tool_name: Option<String>,
    /// Model from the latest assistant message (the actual running model).
    model: Option<String>,
    /// Cumulative token usage across the session's assistant messages.
    usage: TokenUsage,
    /// Last assistant message id whose usage was counted — one API response is stored
    /// as multiple JSONL records (one per content block) all repeating the same usage,
    /// so only the first record of each id accumulates.
    last_usage_msg_id: Option<String>,
    /// Dispatch directives parsed from assistant text, drained + emitted by the tailer loop.
    pending_dispatches: Vec<DispatchEvent>,
    last_stop_reason: Option<String>,
    last_was_user_prompt: bool,
    started_at: Option<String>,
    last_activity_at: String,
    last_phase: String,
    ended: bool,
    dirty: bool,
}

impl Track {
    fn new(terminal_id: String, nt: NewTrack) -> Track {
        Track {
            terminal_id,
            session_id: nt.claude_session_id,
            cwd: nt.cwd,
            permission_mode: nt.permission_mode,
            file: None,
            offset: 0,
            activity: vec![],
            narration: vec![],
            narration_seq: 0,
            pending: vec![],
            tasks: vec![],
            task_n: 0,
            summary: None,
            open_tools: HashSet::new(),
            active_subagents: 0,
            in_sidechain: false,
            last_tool_name: None,
            model: None,
            usage: TokenUsage::default(),
            last_usage_msg_id: None,
            pending_dispatches: vec![],
            last_stop_reason: None,
            last_was_user_prompt: false,
            started_at: None,
            last_activity_at: now_iso(),
            last_phase: String::new(),
            ended: false,
            dirty: true, // emit once so the session shell shows up promptly
        }
    }

    /// Record one narration entry: assign its durable seq, queue it for the chat
    /// store, append to the in-memory tail (capped), and mark dirty. The single choke
    /// point so seq assignment + persistence can't be forgotten at a call site.
    fn push_narration(&mut self, entry: NarrationEntry) {
        let seq = self.narration_seq;
        self.narration_seq += 1;
        self.pending.push((seq, entry.clone()));
        self.narration.push(entry);
        if self.narration.len() > NARRATION_CAP {
            let drop = self.narration.len() - NARRATION_CAP;
            self.narration.drain(0..drop);
        }
        self.dirty = true;
    }

    /// Read any new transcript lines and fold them into this track's state.
    fn poll(&mut self) {
        if self.file.is_none() {
            self.file = find_transcript(&self.session_id);
        }
        let Some(path) = self.file.clone() else { return };
        let Ok(mut f) = File::open(&path) else { return };
        let len = match f.metadata() {
            Ok(m) => m.len(),
            Err(_) => return,
        };
        if len < self.offset {
            self.offset = 0; // file truncated/rotated — re-read
        }
        if len == self.offset {
            return; // nothing new
        }
        if f.seek(SeekFrom::Start(self.offset)).is_err() {
            return;
        }
        let mut buf = String::new();
        if f.read_to_string(&mut buf).is_err() {
            return;
        }
        let mut consumed: u64 = 0;
        let mut processed = false;
        for chunk in buf.split_inclusive('\n') {
            if !chunk.ends_with('\n') {
                break; // partial trailing line — wait for the rest next tick
            }
            consumed += chunk.len() as u64;
            let line = chunk.trim_end();
            if line.is_empty() {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<Value>(line) {
                self.apply(&v);
                processed = true;
            }
        }
        self.offset += consumed;
        // Any new line can change the derived phase (e.g. a new prompt flips the
        // session to "running"), so always re-emit when the transcript advanced.
        if processed {
            self.dirty = true;
        }
    }

    fn apply(&mut self, v: &Value) {
        let ts = v.get("timestamp").and_then(|t| t.as_str()).unwrap_or("").to_string();
        if !ts.is_empty() {
            if self.started_at.is_none() {
                self.started_at = Some(ts.clone());
            }
            self.last_activity_at = ts.clone();
        }

        // Sidechain transitions synthesize subagent group markers, matching the
        // timeline's nesting model. (Approximate with parallel subagents — the
        // hook-based version had the same limitation.)
        let is_side = v.get("isSidechain").and_then(|b| b.as_bool()).unwrap_or(false);
        if is_side && !self.in_sidechain {
            self.activity.push(ActivityEntry::make("Subagent started".into(), None, ts.clone(), "subagent", Some("running".into())));
            self.active_subagents += 1;
            self.in_sidechain = true;
            self.dirty = true;
        } else if !is_side && self.in_sidechain {
            self.activity.push(ActivityEntry::make("Subagent finished".into(), None, ts.clone(), "subagent", None));
            self.active_subagents = (self.active_subagents - 1).max(0);
            self.in_sidechain = false;
            self.dirty = true;
        }

        match v.get("type").and_then(|t| t.as_str()).unwrap_or("") {
            "user" => self.apply_user(v),
            "assistant" => self.apply_assistant(v, &ts),
            _ => {}
        }
    }

    fn apply_user(&mut self, v: &Value) {
        let content = v.get("message").and_then(|m| m.get("content"));
        // tool_result blocks close the matching open tool call.
        if let Some(arr) = content.and_then(|c| c.as_array()) {
            for b in arr {
                if b.get("type").and_then(|t| t.as_str()) == Some("tool_result") {
                    if let Some(id) = b.get("tool_use_id").and_then(|i| i.as_str()) {
                        self.open_tools.remove(id);
                    }
                }
            }
        }
        // The first genuine human prompt becomes the session summary. Skip
        // sidechain lines and tool-result-only turns.
        let is_side = v.get("isSidechain").and_then(|b| b.as_bool()).unwrap_or(false);
        if is_side {
            return;
        }
        if let Some(text) = user_prompt_text(content) {
            self.last_was_user_prompt = true;
            self.last_stop_reason = None;
            // Skip injected plumbing turns (<local-command-caveat>, <command-name>,
            // <system-reminder>, …) — Claude Code's machinery, not the user's words; they
            // made ugly "<local-command-cavea…" session titles. Matched by exact prefix,
            // NOT a bare '<' — a genuine prompt may start with markup ("<Modal> crashes").
            if self.summary.is_none() && !is_injected_turn(&text) {
                let line = first_line(&text, 60);
                if !line.is_empty() {
                    self.summary = Some(line);
                    self.dirty = true;
                }
            }
            // Capture the human prompt for the Chat panel so it reads as a real
            // conversation (user turn + assistant answer), not a one-sided log.
            // Truncate so a big pasted doc doesn't bloat the session payload.
            let mut prompt = text.clone();
            if prompt.chars().count() > 4000 {
                prompt = prompt.chars().take(4000).collect::<String>() + "…";
            }
            let ts = v.get("timestamp").and_then(|t| t.as_str()).map(|s| s.to_string()).unwrap_or_else(now_iso);
            // Dropped images live as base64 image blocks alongside the text; cache them
            // to files once and carry the (small) paths so the Chat panel can show them.
            let images = extract_user_images(content);
            self.push_narration(NarrationEntry { kind: "user".to_string(), text: prompt, timestamp: ts, images });
        }
    }

    fn apply_assistant(&mut self, v: &Value, ts: &str) {
        self.last_was_user_prompt = false;
        let msg = match v.get("message") {
            Some(m) => m,
            None => return,
        };
        self.last_stop_reason = msg.get("stop_reason").and_then(|s| s.as_str()).map(|s| s.to_string());
        // The assistant message carries the model that produced it — the real running model
        // (even for account-default launches Operator didn't set). Remember the latest, but:
        // skip sidechain (subagent) messages — a Haiku subagent must not relabel an Opus
        // session — and skip "<synthetic>" (Claude Code's API-error placeholder).
        let is_side = v.get("isSidechain").and_then(|b| b.as_bool()).unwrap_or(false);
        if !is_side {
            if let Some(m) = msg.get("model").and_then(|m| m.as_str()) {
                if !m.is_empty() && !m.starts_with('<') {
                    self.model = Some(m.to_string());
                }
            }
        }
        // Accumulate token usage ONCE per API response — its blocks land as separate
        // JSONL records that all repeat the same `usage` under the same message id.
        if let Some(u) = msg.get("usage") {
            let mid = msg.get("id").and_then(|i| i.as_str()).unwrap_or("");
            if !mid.is_empty() && self.last_usage_msg_id.as_deref() != Some(mid) {
                self.last_usage_msg_id = Some(mid.to_string());
                let g = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
                self.usage.input += g("input_tokens") + g("cache_creation_input_tokens");
                self.usage.output += g("output_tokens");
                self.usage.cache_read += g("cache_read_input_tokens");
                self.dirty = true;
            }
        }
        let blocks = match msg.get("content").and_then(|c| c.as_array()) {
            Some(b) => b,
            None => return,
        };
        for b in blocks {
            let btype = b.get("type").and_then(|t| t.as_str()).unwrap_or("");
            // Capture prose for the reading panel: "text" answers + "thinking".
            // ("thinking" carries its prose under `thinking`, not `text`.)
            if btype == "text" || btype == "thinking" {
                let field = if btype == "thinking" { "thinking" } else { "text" };
                if let Some(s) = b.get(field).and_then(|t| t.as_str()) {
                    // Orchestrator dispatch directives (only from a real answer, not thinking).
                    if btype == "text" {
                        for (role, task) in parse_dispatches(s) {
                            let id = dispatch_id(&self.session_id, &role, &task);
                            self.pending_dispatches.push(DispatchEvent {
                                id,
                                session_id: self.session_id.clone(),
                                terminal_id: self.terminal_id.clone(),
                                role,
                                task,
                            });
                            self.dirty = true;
                        }
                    }
                    if !s.trim().is_empty() {
                        self.push_narration(NarrationEntry {
                            kind: btype.to_string(),
                            text: s.to_string(),
                            timestamp: ts.to_string(),
                            images: Vec::new(),
                        });
                    }
                }
                continue;
            }
            if btype != "tool_use" {
                continue;
            }
            let name = b.get("name").and_then(|n| n.as_str()).unwrap_or("Tool").to_string();
            let empty = Value::Null;
            let input = b.get("input").unwrap_or(&empty);
            if let Some(id) = b.get("id").and_then(|i| i.as_str()) {
                self.open_tools.insert(id.to_string());
            }
            // The agent's plan (Plan tab) — two tool models:
            match name.as_str() {
                // Classic: full snapshot each call.
                "TodoWrite" => {
                    if let Some(arr) = input.get("todos").and_then(|t| t.as_array()) {
                        self.tasks = arr
                            .iter()
                            .enumerate()
                            .filter_map(|(i, t)| {
                                let content = t.get("content").and_then(|c| c.as_str())?;
                                let status = t.get("status").and_then(|s| s.as_str()).unwrap_or("pending");
                                Some((i.to_string(), TodoItem { content: content.to_string(), status: status.to_string() }))
                            })
                            .collect();
                        self.dirty = true;
                    }
                }
                // Harness task tools: incremental create + update-by-id.
                "TaskCreate" => {
                    if let Some(subject) = input.get("subject").and_then(|s| s.as_str()) {
                        self.task_n += 1;
                        self.tasks.push((self.task_n.to_string(), TodoItem { content: subject.to_string(), status: "pending".into() }));
                        self.dirty = true;
                    }
                }
                "TaskUpdate" => {
                    if let Some(id) = input.get("taskId").and_then(|t| t.as_str()) {
                        let status = input.get("status").and_then(|s| s.as_str());
                        if status == Some("deleted") {
                            self.tasks.retain(|(tid, _)| tid != id);
                        } else if let Some((_, item)) = self.tasks.iter_mut().find(|(tid, _)| tid == id) {
                            if let Some(s) = status { item.status = s.to_string(); }
                            if let Some(subj) = input.get("subject").and_then(|x| x.as_str()) { item.content = subj.to_string(); }
                        }
                        self.dirty = true;
                    }
                }
                _ => {}
            }
            let summary = summarize(&name, input);
            let is_delegate = name == "Task" || name == "Agent";
            let detail = if is_delegate { summary.preview.clone() } else { None };
            let kind = if is_delegate { "delegate" } else { "tool" };
            self.activity.push(ActivityEntry::make(name.clone(), summary.target.clone(), ts.to_string(), kind, detail));
            self.last_tool_name = Some(name);
            self.dirty = true;
        }
    }

    fn phase(&self) -> &'static str {
        derive_phase(
            !self.open_tools.is_empty(),
            self.last_stop_reason.as_deref(),
            self.last_was_user_prompt,
        )
    }

    fn to_session(&self, phase: &str) -> AgentSession {
        AgentSession::from_transcript(
            self.session_id.clone(),
            self.terminal_id.clone(),
            self.cwd.clone(),
            self.permission_mode.clone(),
            self.summary.clone(),
            self.ended,
            phase,
            self.activity.clone(),
            self.narration.clone(),
            self.tasks.iter().map(|(_, item)| item.clone()).collect(),
            self.active_subagents,
            self.last_tool_name.clone(),
            self.started_at.clone().unwrap_or_else(|| self.last_activity_at.clone()),
            self.last_activity_at.clone(),
            self.model.clone(),
            // Absent until anything accumulated (keeps pre-first-turn payloads lean).
            if self.usage.output > 0 || self.usage.input > 0 { Some(self.usage) } else { None },
        )
    }
}

/// The session id is globally unique, so locate its transcript by scanning the
/// project dirs rather than reconstructing Claude Code's cwd→slug rule.
fn find_transcript(session_id: &str) -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let projects = PathBuf::from(home).join(".claude").join("projects");
    for entry in std::fs::read_dir(&projects).ok()?.flatten() {
        let p = entry.path().join(format!("{session_id}.jsonl"));
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// Derive the session phase from the three signals the tailer tracks. Pure so it
/// can be unit-tested without constructing a whole `Track`. "running" wins if a
/// tool is open, the last assistant stop was a tool_use, or a user prompt was just
/// sent (response not started); otherwise the turn has ended → "waiting".
fn derive_phase(running_tools: bool, last_stop_reason: Option<&str>, last_was_user_prompt: bool) -> &'static str {
    if running_tools {
        return "running";
    }
    if last_stop_reason == Some("tool_use") {
        return "running";
    }
    if last_was_user_prompt {
        return "running"; // prompt sent, response not started yet
    }
    // Called only while the pty is quiet: the assistant turn has ended and
    // nothing is streaming, so the session is waiting for the user's reply.
    "waiting"
}

/// Extract base64 image blocks from a user message's content, write each to a
/// dedup'd cache file (`~/.operator/img-cache/<hash>.<ext>`), and return the paths.
/// Keeps the ~500KB base64 OUT of the session payload — only the path travels.
fn extract_user_images(content: Option<&Value>) -> Vec<String> {
    let arr = match content.and_then(|c| c.as_array()) {
        Some(a) => a,
        None => return Vec::new(),
    };
    let mut out = Vec::new();
    for b in arr {
        if b.get("type").and_then(|t| t.as_str()) != Some("image") {
            continue;
        }
        let src = match b.get("source") {
            Some(s) => s,
            None => continue,
        };
        if src.get("type").and_then(|t| t.as_str()) != Some("base64") {
            continue;
        }
        let data = match src.get("data").and_then(|d| d.as_str()) {
            Some(d) => d,
            None => continue,
        };
        let media = src.get("media_type").and_then(|m| m.as_str()).unwrap_or("image/png");
        if let Some(path) = cache_image(data, media) {
            out.push(path);
        }
    }
    out
}

/// Decode a base64 image and write it to `~/.operator/img-cache/<hash>.<ext>` (once,
/// keyed by content hash so re-tailing the transcript is idempotent). Returns the path.
fn cache_image(b64: &str, media: &str) -> Option<String> {
    use base64::Engine;
    use std::hash::{Hash, Hasher};
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .ok()?;
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    let ext = match media {
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "jpg",
    };
    let home = std::env::var("HOME").ok()?;
    let dir = std::path::Path::new(&home).join(".operator").join("img-cache");
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join(format!("{:016x}.{}", h.finish(), ext));
    if !path.exists() {
        std::fs::write(&path, &bytes).ok()?;
    }
    Some(path.to_string_lossy().into_owned())
}

// --- Orchestrator dispatch ------------------------------------------------------------------
// A lead ("orchestrator") agent hands work to another lane by emitting a directive line in its
// answer: `OPERATOR-DISPATCH [<role-id>] <task>`. The tailer detects these and the frontend
// routes each to the target lane (send to its live session, or queue it as a task). This is
// the cheap-but-real dispatch loop — the model prints a marker, Operator does the routing.

/// An emitted dispatch directive. `id` is a stable content hash so the frontend can dedupe
/// re-reads of the transcript (relaunch) without double-dispatching.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DispatchEvent {
    id: String,
    session_id: String,
    terminal_id: String,
    role: String,
    task: String,
}

/// Parse `OPERATOR-DISPATCH [<role>] <task>` directives out of an assistant text block.
/// Returns (role, task) pairs; ignores malformed lines. Kept liberal on the role charset so
/// a hand-named role id still routes (the frontend validates against the live roster).
fn parse_dispatches(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let l = line.trim();
        let rest = match l.strip_prefix("OPERATOR-DISPATCH") {
            Some(r) => r.trim_start(),
            None => continue,
        };
        if !rest.starts_with('[') {
            continue;
        }
        let close = match rest.find(']') {
            Some(i) => i,
            None => continue,
        };
        let role = rest[1..close].trim().to_string();
        let task = rest[close + 1..].trim().trim_start_matches(':').trim().to_string();
        if !role.is_empty() && !task.is_empty() {
            out.push((role, task));
        }
    }
    out
}

/// Stable id for a dispatch, so a re-read of the same transcript line doesn't re-fire it.
fn dispatch_id(session_id: &str, role: &str, task: &str) -> String {
    // Cheap FNV-1a over the tuple — deterministic across relaunches.
    let mut h: u64 = 0xcbf29ce484222325;
    for b in session_id.bytes().chain(b"|".iter().copied()).chain(role.bytes()).chain(b"|".iter().copied()).chain(task.bytes()) {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

/// Claude Code's injected plumbing turns that masquerade as user prompts. Mirrors the
/// frontend filter in lib/format.ts (isInjectedTurn) — keep the two prefix lists in sync.
fn is_injected_turn(text: &str) -> bool {
    const PREFIXES: [&str; 7] = [
        "<local-command-", "<command-name>", "<command-message>", "<command-args>",
        "<system-reminder>", "<task-notification>", "<synthetic>",
    ];
    let t = text.trim_start();
    PREFIXES.iter().any(|p| t.starts_with(p))
}

fn user_prompt_text(content: Option<&Value>) -> Option<String> {
    match content {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Array(arr)) => {
            // A real prompt has text blocks and no tool_result.
            if arr.iter().any(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result")) {
                return None;
            }
            let mut out = String::new();
            for b in arr {
                if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                    if let Some(s) = b.get("text").and_then(|t| t.as_str()) {
                        out.push_str(s);
                    }
                }
            }
            if out.trim().is_empty() {
                None
            } else {
                Some(out)
            }
        }
        _ => None,
    }
}

/// Background thread: every second, pick up newly-launched terminals, fold any
/// new transcript lines into their sessions, and emit `session:update`.
pub fn start_tailer(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut tracks: HashMap<String, Track> = HashMap::new();
        let mut last_tray_entries: Vec<(String, String)> = Vec::new();
        loop {
            std::thread::sleep(Duration::from_secs(1));

            for (tid, nt) in app.state::<TrackRegistry>().snapshot() {
                tracks.entry(tid.clone()).or_insert_with(|| Track::new(tid, nt));
            }

            let mgr = app.state::<Arc<PtyManager>>();
            let sessions = app.state::<Sessions>();
            let mut any_dirty = false;

            for t in tracks.values_mut() {
                if t.ended {
                    continue;
                }
                let alive = mgr.alive(&t.terminal_id);
                t.poll();
                // Persist any new answers to the durable chat store (append-only,
                // idempotent by (session_id, seq)) before they can be dropped from the
                // in-memory tail cap.
                if !t.pending.is_empty() {
                    app.state::<Arc<ChatStore>>().append(&t.session_id, &t.pending);
                    t.pending.clear();
                }
                // Emit any orchestrator dispatch directives; the frontend dedupes by id and
                // routes each to its target lane (send to a live session, or queue a task).
                if !t.pending_dispatches.is_empty() {
                    for d in t.pending_dispatches.drain(..) {
                        let _ = app.emit("operator:dispatch", &d);
                    }
                }
                if !alive {
                    t.ended = true;
                    t.dirty = true;
                }
                // Effective phase: the terminal streaming output right now is the
                // real-time signal that the agent is working; the transcript
                // phase covers quiet stretches (e.g. a long-running tool).
                let pty_active = !t.ended && mgr.active_within(&t.terminal_id, Duration::from_millis(1500));
                let phase = if pty_active { "running" } else { t.phase() };
                let phase_changed = t.last_phase != phase;
                if t.dirty || phase_changed {
                    t.last_phase = phase.to_string();
                    sessions.upsert(t.to_session(phase));
                    t.dirty = false;
                    any_dirty = true;
                }
            }

            // Tray menu: one item per OPEN session (pty still alive) + its state.
            // Keyed on pty liveness, not turn-ended, so a closed/killed session
            // drops off the moment its pty is gone. Sorted + diffed so we only
            // rebuild the menu when the set or a label actually changes.
            let mut entries: Vec<(String, String)> = tracks
                .values()
                .filter(|t| mgr.alive(&t.terminal_id))
                .map(|t| {
                    let proj = t.cwd.rsplit('/').next().unwrap_or(&t.cwd);
                    (format!("session:{}", t.terminal_id), format!("{}  ·  {}", proj, t.last_phase))
                })
                .collect();
            entries.sort();
            if entries != last_tray_entries {
                refresh_tray_menu(&app, &entries);
                last_tray_entries = entries;
            }

            // Aggregate signal for the animated tray icon (crate::tray_anim):
            // any session working → busy; else any awaiting the user → your-turn;
            // nothing open → idle.
            let mut busy = false;
            let mut waiting = false;
            for t in tracks.values() {
                if !mgr.alive(&t.terminal_id) {
                    continue;
                }
                match t.last_phase.as_str() {
                    "running" => busy = true,
                    "waiting" => waiting = true,
                    _ => {}
                }
            }
            let tray_state = if busy {
                crate::tray_anim::BUSY
            } else if waiting {
                crate::tray_anim::YOUR_TURN
            } else {
                crate::tray_anim::IDLE
            };
            app.state::<crate::tray_anim::TrayState>().set(tray_state);

            if any_dirty {
                let _ = app.emit("session:update", sessions.get_active());
            }
        }
    });
}

/// Rebuild the tray's menu to list the active sessions and their states.
fn refresh_tray_menu(app: &tauri::AppHandle, sessions: &[(String, String)]) {
    use tauri::menu::MenuBuilder;
    let Some(tray) = app.tray_by_id("operator") else { return };
    let mut b = MenuBuilder::new(app).text("show", "Show Operator").separator();
    if sessions.is_empty() {
        b = b.text("none", "No active sessions").separator();
    } else {
        for (id, label) in sessions {
            b = b.text(id, label);
        }
        b = b.separator();
    }
    if let Ok(menu) = b.quit().build() {
        let _ = tray.set_menu(Some(menu));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn derive_phase_running_when_tool_open() {
        assert_eq!(derive_phase(true, None, false), "running");
    }

    #[test]
    fn parse_dispatches_extracts_role_and_task() {
        let text = "Here is the plan.\nOPERATOR-DISPATCH [code] Fix the login button alignment\nOPERATOR-DISPATCH [research]: why is the list slow?\nnot a directive";
        let d = parse_dispatches(text);
        assert_eq!(d, vec![
            ("code".to_string(), "Fix the login button alignment".to_string()),
            ("research".to_string(), "why is the list slow?".to_string()),
        ]);
    }

    #[test]
    fn parse_dispatches_ignores_malformed() {
        assert!(parse_dispatches("OPERATOR-DISPATCH no brackets").is_empty());
        assert!(parse_dispatches("OPERATOR-DISPATCH [code]").is_empty()); // no task
        assert!(parse_dispatches("OPERATOR-DISPATCH [] task").is_empty()); // no role
        assert!(parse_dispatches("just prose about OPERATOR-DISPATCH mid-line").is_empty());
    }

    #[test]
    fn dispatch_id_is_stable_and_distinct() {
        let a = dispatch_id("s1", "code", "task");
        assert_eq!(a, dispatch_id("s1", "code", "task"));
        assert_ne!(a, dispatch_id("s1", "code", "task2"));
        assert_ne!(a, dispatch_id("s2", "code", "task"));
    }

    #[test]
    fn derive_phase_running_on_tool_use_stop() {
        assert_eq!(derive_phase(false, Some("tool_use"), false), "running");
    }

    #[test]
    fn derive_phase_running_after_user_prompt() {
        assert_eq!(derive_phase(false, Some("end_turn"), true), "running");
    }

    #[test]
    fn derive_phase_waiting_when_turn_ended() {
        assert_eq!(derive_phase(false, Some("end_turn"), false), "waiting");
        assert_eq!(derive_phase(false, None, false), "waiting");
    }

    #[test]
    fn user_prompt_text_string_content() {
        let v = json!("hello there");
        assert_eq!(user_prompt_text(Some(&v)), Some("hello there".to_string()));
    }

    #[test]
    fn user_prompt_text_concatenates_text_blocks() {
        let v = json!([
            { "type": "text", "text": "hi" },
            { "type": "image" },
            { "type": "text", "text": " there" }
        ]);
        assert_eq!(user_prompt_text(Some(&v)), Some("hi there".to_string()));
    }

    #[test]
    fn user_prompt_text_skips_tool_result_arrays() {
        let v = json!([{ "type": "tool_result", "content": "x" }]);
        assert_eq!(user_prompt_text(Some(&v)), None);
    }

    #[test]
    fn user_prompt_text_none_for_empty_or_non_text() {
        assert_eq!(user_prompt_text(None), None);
        assert_eq!(user_prompt_text(Some(&json!(42))), None);
        let blank = json!([{ "type": "text", "text": "   " }]);
        assert_eq!(user_prompt_text(Some(&blank)), None);
    }
}
