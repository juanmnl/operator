// Ported from the Electron main process: the session state machine
// (sessions.ts) and tool humanizer (tool-summary.ts). The timeline is
// transcript-driven (see transcript.rs).

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;

// --- UI-facing types (camelCase to match shared/types.ts) -------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEntry {
    tool_name: String,
    target: Option<String>,
    timestamp: String,
    status: String, // approved | denied | pending | auto
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<String>, // tool | delegate | subagent
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

impl ActivityEntry {
    /// Construct a timeline entry sourced from a transcript line.
    pub fn make(tool_name: String, target: Option<String>, timestamp: String, kind: &str, detail: Option<String>) -> ActivityEntry {
        ActivityEntry { tool_name, target, timestamp, status: "auto".into(), kind: Some(kind.to_string()), detail }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    id: String,
    agent_id: String,
    working_directory: String,
    project_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<String>,
    status: String, // active | ended
    phase: String,  // idle | running | compacting | waiting
    activity: Vec<ActivityEntry>,
    active_subagents: i32,
    last_tool_name: Option<String>,
    started_at: String,
    last_activity_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    terminal_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    permission_mode: Option<String>,
}

pub fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis();
    iso_from_ms(ms)
}

// Minimal epoch-ms -> ISO 8601 (UTC) without external crates.
pub fn iso_from_ms(ms: u128) -> String {
    let secs = (ms / 1000) as i64;
    let millis = (ms % 1000) as u32;
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Civil date from days since 1970 (Howard Hinnant's algorithm).
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    format!("{year:04}-{month:02}-{d:02}T{h:02}:{m:02}:{s:02}.{millis:03}Z")
}

// --- Tool humanizer (port of tool-summary.ts) -------------------------------

pub struct ToolSummary {
    #[allow(dead_code)] // produced by summarize() for completeness; the timeline uses target/preview
    pub action: String,
    pub target: Option<String>,
    pub preview: Option<String>,
    #[allow(dead_code)] // produced by summarize() for completeness; the timeline uses target/preview
    pub severity: String,
}

pub fn first_line(s: &str, max: usize) -> String {
    let line = s.lines().next().unwrap_or("").trim();
    if line.chars().count() > max {
        format!("{}…", line.chars().take(max - 1).collect::<String>())
    } else {
        line.to_string()
    }
}

fn basename(p: &str) -> String {
    p.rsplit('/').next().unwrap_or(p).to_string()
}

fn str_field<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input.get(key).and_then(|v| v.as_str())
}

fn bash_severity(c: &str) -> &'static str {
    let c = c.to_lowercase();
    if c.contains("rm -rf") || c.contains("rm -fr") || c.contains("git push -f") || c.contains("git push --force") || c.contains("drop table") || c.contains("drop database") {
        return "high";
    }
    if c.contains("sudo ") || c.contains("curl ") && c.contains("| sh") || c.contains("| bash") {
        return "high";
    }
    let head = c.trim_start();
    for r in ["ls", "cat", "pwd", "echo", "which", "whoami", "date", "head", "tail", "grep", "wc", "find", "file", "stat"] {
        if head.starts_with(r) {
            return "low";
        }
    }
    "medium"
}

pub fn summarize(name: &str, input: &Value) -> ToolSummary {
    let empty = Value::Null;
    let input = if input.is_object() { input } else { &empty };
    match name {
        "Bash" => {
            let command = str_field(input, "command").unwrap_or("");
            ToolSummary {
                action: "Run command".into(),
                target: Some(first_line(command, 100)),
                preview: str_field(input, "description").map(|s| s.to_string()).or_else(|| Some(first_line(command, 240))),
                severity: bash_severity(command).into(),
            }
        }
        "Edit" | "MultiEdit" => ToolSummary {
            action: "Edit file".into(),
            target: str_field(input, "file_path").map(basename),
            preview: str_field(input, "file_path").map(|p| p.to_string()),
            severity: "medium".into(),
        },
        "Write" => ToolSummary {
            action: "Write file".into(),
            target: str_field(input, "file_path").map(basename),
            preview: str_field(input, "file_path").map(|p| p.to_string()),
            severity: "high".into(),
        },
        "Task" | "Agent" => {
            let st = str_field(input, "subagent_type").or_else(|| str_field(input, "agent_type")).unwrap_or("agent");
            ToolSummary {
                action: "Delegate".into(),
                target: Some(st.to_string()),
                preview: str_field(input, "description").or_else(|| str_field(input, "prompt")).map(|s| first_line(s, 200)),
                severity: "medium".into(),
            }
        }
        "WebFetch" => ToolSummary { action: "Fetch URL".into(), target: str_field(input, "url").map(|s| s.to_string()), preview: None, severity: "low".into() },
        "WebSearch" => ToolSummary { action: "Search the web".into(), target: str_field(input, "query").map(|s| first_line(s, 100)), preview: None, severity: "low".into() },
        _ => {
            if let Some(rest) = name.strip_prefix("mcp__") {
                let mut parts = rest.split("__");
                let server = parts.next().unwrap_or(rest);
                return ToolSummary { action: format!("MCP: {server}"), target: Some(server.to_string()), preview: None, severity: "high".into() };
            }
            let target = ["file_path", "command", "path", "pattern", "description", "prompt"].iter().find_map(|k| str_field(input, k));
            ToolSummary { action: format!("Use {name}"), target: target.map(|s| first_line(s, 100)), preview: None, severity: "low".into() }
        }
    }
}

// --- Session manager (port of sessions.ts) ----------------------------------

#[derive(Default)]
pub struct Sessions {
    map: Mutex<HashMap<String, AgentSession>>,
}

#[allow(clippy::too_many_arguments)]
impl AgentSession {
    /// Build a session from parsed transcript state. The timeline is now
    /// transcript-driven (see transcript.rs), so this is the only constructor.
    pub fn from_transcript(
        id: String,
        terminal_id: String,
        cwd: String,
        permission_mode: Option<String>,
        summary: Option<String>,
        ended: bool,
        phase: &str,
        activity: Vec<ActivityEntry>,
        active_subagents: i32,
        last_tool_name: Option<String>,
        started_at: String,
        last_activity_at: String,
    ) -> AgentSession {
        let project_name = cwd.rsplit('/').next().unwrap_or(&cwd).to_string();
        AgentSession {
            id,
            agent_id: "claude-code".into(),
            project_name,
            working_directory: cwd,
            summary,
            status: if ended { "ended".into() } else { "active".into() },
            phase: phase.to_string(),
            activity,
            active_subagents,
            last_tool_name,
            started_at,
            last_activity_at,
            terminal_id: Some(terminal_id),
            permission_mode,
        }
    }
}

impl Sessions {
    /// Insert or replace a session (the transcript tailer owns the entry).
    pub fn upsert(&self, s: AgentSession) {
        self.map.lock().unwrap().insert(s.id.clone(), s);
    }

    pub fn get_active(&self) -> Vec<AgentSession> {
        let mut v: Vec<AgentSession> = self.map.lock().unwrap().values().filter(|s| s.status == "active").cloned().collect();
        v.sort_by(|a, b| b.last_activity_at.cmp(&a.last_activity_at));
        v
    }
}
