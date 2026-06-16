// Ported from the Electron main process: the hook decision pipeline
// (server.ts), session state machine (sessions.ts), tool humanizer
// (tool-summary.ts), and auto-approve rules (rules.ts).

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

// --- Hook event (incoming JSON from operator-hook.sh) -----------------------

#[allow(dead_code)] // several fields are deserialized for completeness but unused post permission-only hook
#[derive(Debug, Default, Deserialize)]
pub struct HookEvent {
    #[serde(default)]
    pub hook_event_name: String,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub tool_name: Option<String>,
    pub tool_input: Option<Value>,
    pub terminal_id: Option<String>,
    pub permission_mode: Option<String>,
    pub agent_id: Option<String>,
    pub agent_type: Option<String>,
    pub prompt: Option<String>,
    pub user_prompt: Option<String>,
    pub message: Option<String>,
}

// --- UI-facing types (camelCase to match shared/types.ts) -------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestContext {
    pub working_directory: String,
    pub target: Option<String>,
    pub preview: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperatorRequest {
    pub id: String,
    pub agent_id: String,
    pub action: String,
    pub tool_name: Option<String>,
    pub message: String,
    pub context: RequestContext,
    pub severity: String,
    pub expires_in: u32,
    pub timestamp: String,
    pub session_id: Option<String>,
    pub terminal_id: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperatorResponse {
    pub approved: bool,
    pub value: String,
    pub modified_context: Option<Value>,
    pub responded_at: String,
    pub responded_by: String,
}

#[allow(dead_code)] // entries is always empty now that activity is transcript-driven
#[derive(Clone, Serialize)]
struct SessionEntry {
    request: OperatorRequest,
    response: Option<OperatorResponse>,
}

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
    phase: String,  // idle | running | compacting
    entries: Vec<SessionEntry>,
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
    pub action: String,
    pub target: Option<String>,
    pub preview: Option<String>,
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

fn summary_message(s: &ToolSummary) -> String {
    let verb = s.action.to_lowercase();
    match &s.target {
        Some(t) => format!("Claude wants to {verb}: {t}"),
        None => format!("Claude wants to {verb}"),
    }
}

// --- Auto-approve rules (port of rules.ts) ----------------------------------

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub id: String,
    pub tool: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    pub action: String, // approve | deny
    pub created_at: String,
}

fn rules_path() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    std::path::Path::new(&home).join(".operator").join("rules.json")
}

pub fn load_rules() -> Vec<Rule> {
    std::fs::read_to_string(rules_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_rules(rules: &[Rule]) {
    let p = rules_path();
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(s) = serde_json::to_string_pretty(rules) {
        let _ = std::fs::write(p, s);
    }
}

fn glob_match(pattern: &str, value: &str) -> bool {
    // Simple `*` wildcard matcher.
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return pattern == value;
    }
    let mut pos = 0usize;
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        if i == 0 {
            if !value[pos..].starts_with(part) {
                return false;
            }
            pos += part.len();
        } else if i == parts.len() - 1 {
            return value[pos..].ends_with(part);
        } else if let Some(idx) = value[pos..].find(part) {
            pos += idx + part.len();
        } else {
            return false;
        }
    }
    true
}

fn path_within(scope: &str, cwd: &str) -> bool {
    cwd == scope || cwd.starts_with(&format!("{scope}/"))
}

fn primary_input(tool: &str, input: &Value) -> String {
    if tool == "Bash" {
        return str_field(input, "command").unwrap_or("").to_string();
    }
    ["file_path", "path", "pattern", "url", "command", "query"]
        .iter()
        .find_map(|k| str_field(input, k))
        .unwrap_or("")
        .to_string()
}

pub fn evaluate_rules(rules: &[Rule], tool: &str, input: &Value, cwd: Option<&str>) -> Option<String> {
    for r in rules {
        if r.tool != "*" && r.tool != tool {
            continue;
        }
        if let Some(scope) = &r.scope {
            match cwd {
                Some(c) if path_within(scope, c) => {}
                _ => continue,
            }
        }
        if let Some(pat) = &r.pattern {
            if !glob_match(pat, &primary_input(tool, input)) {
                continue;
            }
        }
        return Some(r.action.clone());
    }
    None
}

// --- Session manager (port of sessions.ts) ----------------------------------

#[derive(Default)]
pub struct Sessions {
    map: Mutex<HashMap<String, AgentSession>>,
}

pub const AUTO_APPROVED: &[&str] = &[
    "Read", "Glob", "Grep", "Skill", "ToolSearch", "LSP", "TodoWrite", "EnterPlanMode",
    "ExitPlanMode", "TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "TaskOutput",
    "TaskStop", "WebFetch", "WebSearch", "PushNotification", "ScheduleWakeup",
];

pub fn is_auto_approved(tool: Option<&str>) -> bool {
    tool.map(|t| AUTO_APPROVED.contains(&t)).unwrap_or(false)
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
            entries: vec![],
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

// --- helpers used by the hook handler ---------------------------------------

pub fn make_request(e: &HookEvent, summary: &ToolSummary, id: String) -> OperatorRequest {
    OperatorRequest {
        id,
        agent_id: e.agent_id.clone().unwrap_or_else(|| "claude-code".into()),
        action: summary.action.clone(),
        tool_name: e.tool_name.clone(),
        message: summary_message(summary),
        context: RequestContext {
            working_directory: e.cwd.clone().unwrap_or_default(),
            target: summary.target.clone(),
            preview: summary.preview.clone(),
        },
        severity: summary.severity.clone(),
        expires_in: 300,
        timestamp: now_iso(),
        session_id: e.session_id.clone(),
        terminal_id: e.terminal_id.clone(),
    }
}

#[allow(dead_code)] // permission-entry scaffolding; entries are no longer tracked per-session
pub fn response(approved: bool) -> OperatorResponse {
    OperatorResponse {
        approved,
        value: if approved { "approve".into() } else { "deny".into() },
        modified_context: None,
        responded_at: now_iso(),
        responded_by: "user".into(),
    }
}

// Rules commands

pub fn rules_list() -> Vec<Rule> {
    load_rules()
}

pub fn rules_add(tool: String, pattern: Option<String>, scope: Option<String>, action: String) -> Rule {
    let mut rules = load_rules();
    let rule = Rule {
        id: format!("rule-{}", now_iso()),
        tool,
        pattern: pattern.filter(|p| !p.is_empty()),
        scope: scope.filter(|s| !s.is_empty()),
        action,
        created_at: now_iso(),
    };
    rules.push(rule.clone());
    save_rules(&rules);
    rule
}

pub fn rules_remove(id: &str) {
    let mut rules = load_rules();
    rules.retain(|r| r.id != id);
    save_rules(&rules);
}
