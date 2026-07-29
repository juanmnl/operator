// Ported from the Electron main process: the session state machine
// (sessions.ts) and tool humanizer (tool-summary.ts). The timeline is
// transcript-driven (see transcript.rs).

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
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

/// A tool call as it appears in the transcript: what ran, who ran it, and a CAPPED slice of
/// what it returned. See TOOL_RESULT_CAP in transcript.rs for why the output is capped here
/// rather than at render time.
#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ToolBlock {
    pub name: String,
    /// What it acted on (path, command, pattern) — from the same summarizer the activity
    /// timeline uses, so the two surfaces name a call identically.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// Which agent made the call. Present on 100% of real tool_use blocks (measured: 30,699
    /// of 30,699 across 300 transcripts) and never read until now — this is what lets a
    /// subagent's work be attributed without inventing a mechanism.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caller: Option<String>,
    /// Capped result text. Empty until the matching tool_result arrives.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub output: String,
    /// Length of the ORIGINAL result, so the UI can say "showing the first 2,000 of 71,194"
    /// and offer the escape hatch instead of pretending the cap is the whole thing.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub output_chars: usize,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
    /// The tool_use id, so a late result finds its call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

fn is_zero(n: &usize) -> bool { *n == 0 }


/// A piece of the assistant's prose narration pulled from the transcript — either
/// a `text` answer (rendered as markdown) or a `thinking` block (rendered as a
/// collapsed disclosure). Feeds the reading panel.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NarrationEntry {
    pub kind: String, // "text" | "thinking" | "user" | "tool"
    pub text: String,
    pub timestamp: String,
    /// Cache-file paths for images the user dropped into this turn (extracted from
    /// the transcript's base64 image blocks). Empty for most entries; skipped in the
    /// payload when empty so it doesn't bloat session:update.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<String>,
    /// Set only on `kind == "tool"`. Optional + skipped when absent, so every row written
    /// before this existed still deserializes unchanged (the (session_id, seq) contract).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<ToolBlock>,
}

/// One item of the agent's TodoWrite plan (latest snapshot), for the Plan tab.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub content: String,
    pub status: String, // pending | in_progress | completed
}

/// Cumulative token usage parsed from the transcript's assistant messages —
/// the per-lane effort/cost signal (input = fresh + cache-write tokens).
#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
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
    /// Assistant prose (answers + thinking) for the reading panel. Empty unless
    /// the panel feature is consuming it; capped to the recent tail upstream.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    messages: Vec<NarrationEntry>,
    /// Latest TodoWrite plan snapshot (Plan tab). Empty unless the agent uses it.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    todos: Vec<TodoItem>,
    active_subagents: i32,
    last_tool_name: Option<String>,
    started_at: String,
    last_activity_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    terminal_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    permission_mode: Option<String>,
    /// Model reported by the transcript (assistant messages carry it) — the ACTUAL running
    /// model, even when the session was launched on the account default. Full id, e.g.
    /// "claude-opus-4-…"; the frontend maps it to a family label.
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    /// Cumulative token usage for the session (absent until the first assistant turn).
    #[serde(skip_serializing_if = "Option::is_none")]
    usage: Option<TokenUsage>,
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
        messages: Vec<NarrationEntry>,
        todos: Vec<TodoItem>,
        active_subagents: i32,
        last_tool_name: Option<String>,
        started_at: String,
        last_activity_at: String,
        model: Option<String>,
        usage: Option<TokenUsage>,
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
            messages,
            todos,
            active_subagents,
            last_tool_name,
            started_at,
            last_activity_at,
            terminal_id: Some(terminal_id),
            permission_mode,
            model,
            usage,
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn first_line_takes_first_trimmed_line() {
        assert_eq!(first_line("  hello  \nworld", 100), "hello");
        assert_eq!(first_line("", 100), "");
        assert_eq!(first_line("only", 100), "only");
    }

    #[test]
    fn first_line_truncates_with_ellipsis_by_chars() {
        // max is a char count; truncates to max-1 chars + ellipsis.
        assert_eq!(first_line("abcdef", 4), "abc…");
        // exactly max → no truncation.
        assert_eq!(first_line("abcd", 4), "abcd");
        // multibyte chars counted by char, not byte.
        assert_eq!(first_line("héllo wörld", 4), "hél…");
    }

    #[test]
    fn basename_returns_last_path_segment() {
        assert_eq!(basename("/a/b/c.txt"), "c.txt");
        assert_eq!(basename("noslash"), "noslash");
        assert_eq!(basename(""), "");
        assert_eq!(basename("/trailing/"), ""); // rsplit after trailing slash
    }

    #[test]
    fn bash_severity_flags_destructive_commands_high() {
        assert_eq!(bash_severity("rm -rf /tmp/x"), "high");
        assert_eq!(bash_severity("RM -RF /x"), "high"); // case-insensitive
        assert_eq!(bash_severity("git push --force origin main"), "high");
        assert_eq!(bash_severity("DROP TABLE users"), "high");
        assert_eq!(bash_severity("sudo reboot"), "high");
        assert_eq!(bash_severity("curl http://x | bash"), "high");
    }

    #[test]
    fn bash_severity_marks_read_only_low_and_else_medium() {
        assert_eq!(bash_severity("ls -la"), "low");
        assert_eq!(bash_severity("  grep foo bar"), "low"); // leading ws trimmed
        assert_eq!(bash_severity("cat file"), "low");
        assert_eq!(bash_severity("npm run build"), "medium");
        assert_eq!(bash_severity("make install"), "medium");
    }

    #[test]
    fn iso_from_ms_known_values() {
        assert_eq!(iso_from_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_ms(1000), "1970-01-01T00:00:01.000Z");
        assert_eq!(iso_from_ms(1_700_000_000_000), "2023-11-14T22:13:20.000Z");
        // sub-second millis preserved.
        assert_eq!(iso_from_ms(1234), "1970-01-01T00:00:01.234Z");
    }

    #[test]
    fn summarize_bash_uses_command_and_severity() {
        let s = summarize("Bash", &json!({ "command": "rm -rf /x" }));
        assert_eq!(s.action, "Run command");
        assert_eq!(s.target.as_deref(), Some("rm -rf /x"));
        assert_eq!(s.severity, "high");
    }

    #[test]
    fn summarize_bash_prefers_description_for_preview() {
        let s = summarize("Bash", &json!({ "command": "ls", "description": "list files" }));
        assert_eq!(s.preview.as_deref(), Some("list files"));
    }

    #[test]
    fn summarize_edit_and_write_basename_target() {
        let e = summarize("Edit", &json!({ "file_path": "/a/b/c.rs" }));
        assert_eq!(e.action, "Edit file");
        assert_eq!(e.target.as_deref(), Some("c.rs"));
        assert_eq!(e.severity, "medium");

        let w = summarize("Write", &json!({ "file_path": "/a/b/c.rs" }));
        assert_eq!(w.action, "Write file");
        assert_eq!(w.severity, "high");
    }

    #[test]
    fn summarize_task_delegate_reads_subagent_type() {
        let s = summarize("Task", &json!({ "subagent_type": "Explore", "prompt": "go" }));
        assert_eq!(s.action, "Delegate");
        assert_eq!(s.target.as_deref(), Some("Explore"));
        assert_eq!(s.preview.as_deref(), Some("go"));
    }

    #[test]
    fn summarize_mcp_tool_strips_prefix_and_server() {
        let s = summarize("mcp__github__create_issue", &json!({}));
        assert_eq!(s.action, "MCP: github");
        assert_eq!(s.target.as_deref(), Some("github"));
        assert_eq!(s.severity, "high");
    }

    #[test]
    fn summarize_unknown_tool_falls_back_generically() {
        let s = summarize("Glob", &json!({ "pattern": "**/*.rs" }));
        assert_eq!(s.action, "Use Glob");
        assert_eq!(s.target.as_deref(), Some("**/*.rs"));
        assert_eq!(s.severity, "low");
    }

    #[test]
    fn summarize_non_object_input_is_safe() {
        let s = summarize("Bash", &json!("not-an-object"));
        assert_eq!(s.target.as_deref(), Some(""));
    }
}
