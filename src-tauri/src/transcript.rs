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

use serde_json::Value;
use tauri::{Emitter, Manager};

use crate::backend::{first_line, now_iso, summarize, ActivityEntry, AgentSession, Sessions};
use crate::PtyManager;

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
    summary: Option<String>,
    open_tools: HashSet<String>,
    active_subagents: i32,
    in_sidechain: bool,
    last_tool_name: Option<String>,
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
            summary: None,
            open_tools: HashSet::new(),
            active_subagents: 0,
            in_sidechain: false,
            last_tool_name: None,
            last_stop_reason: None,
            last_was_user_prompt: false,
            started_at: None,
            last_activity_at: now_iso(),
            last_phase: String::new(),
            ended: false,
            dirty: true, // emit once so the session shell shows up promptly
        }
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
            if self.summary.is_none() {
                let line = first_line(&text, 60);
                if !line.is_empty() {
                    self.summary = Some(line);
                    self.dirty = true;
                }
            }
        }
    }

    fn apply_assistant(&mut self, v: &Value, ts: &str) {
        self.last_was_user_prompt = false;
        let msg = match v.get("message") {
            Some(m) => m,
            None => return,
        };
        self.last_stop_reason = msg.get("stop_reason").and_then(|s| s.as_str()).map(|s| s.to_string());
        let blocks = match msg.get("content").and_then(|c| c.as_array()) {
            Some(b) => b,
            None => return,
        };
        for b in blocks {
            if b.get("type").and_then(|t| t.as_str()) != Some("tool_use") {
                continue;
            }
            let name = b.get("name").and_then(|n| n.as_str()).unwrap_or("Tool").to_string();
            let empty = Value::Null;
            let input = b.get("input").unwrap_or(&empty);
            if let Some(id) = b.get("id").and_then(|i| i.as_str()) {
                self.open_tools.insert(id.to_string());
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
        if !self.open_tools.is_empty() {
            return "running";
        }
        if self.last_stop_reason.as_deref() == Some("tool_use") {
            return "running";
        }
        if self.last_was_user_prompt {
            return "running"; // prompt sent, response not started yet
        }
        // Called only while the pty is quiet: the assistant turn has ended and
        // nothing is streaming, so the session is waiting for the user's reply.
        "waiting"
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
            self.active_subagents,
            self.last_tool_name.clone(),
            self.started_at.clone().unwrap_or_else(|| self.last_activity_at.clone()),
            self.last_activity_at.clone(),
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
