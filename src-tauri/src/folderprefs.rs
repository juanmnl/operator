// Folder preferences (port of folder-prefs.ts): read/write Claude Code settings
// JSON + CLAUDE.md files at global/project scope, and discover MCP servers.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};

fn claude_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".claude")
}

fn read_json(path: &Path) -> Value {
    std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_else(|| json!({}))
}

fn read_text(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsFile {
    pub path: String,
    pub label: String,
    pub scope: String,
    pub read_only: bool,
    pub exists: bool,
    pub settings: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeMdFile {
    pub path: String,
    pub label: String,
    pub scope: String,
    pub exists: bool,
    pub content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderPreferences {
    pub project_path: String,
    pub project_name: String,
    pub settings_files: Vec<SettingsFile>,
    pub md_files: Vec<ClaudeMdFile>,
}

fn sf(path: PathBuf, label: &str, scope: &str, read_only: bool) -> SettingsFile {
    let exists = path.exists();
    SettingsFile { settings: read_json(&path), path: path.to_string_lossy().to_string(), label: label.into(), scope: scope.into(), read_only, exists }
}

fn global_settings_files() -> Vec<SettingsFile> {
    let d = claude_dir();
    vec![
        sf(d.join("managed-settings.json"), "Managed (Organization)", "managed", true),
        sf(d.join("settings.json"), "Global User", "global", false),
        sf(d.join("settings.local.json"), "Global Local", "global-local", false),
    ]
}

fn md(path: PathBuf, label: &str, scope: &str) -> ClaudeMdFile {
    let exists = path.exists();
    ClaudeMdFile { content: read_text(&path), path: path.to_string_lossy().to_string(), label: label.into(), scope: scope.into(), exists }
}

fn global_md_files() -> Vec<ClaudeMdFile> {
    vec![md(claude_dir().join("CLAUDE.md"), "Global (~/.claude/CLAUDE.md)", "global")]
}

pub fn load_global_preferences() -> FolderPreferences {
    FolderPreferences {
        project_path: claude_dir().to_string_lossy().to_string(),
        project_name: "Global Claude".into(),
        settings_files: global_settings_files(),
        md_files: global_md_files(),
    }
}

pub fn load_folder_preferences(project_path: &str) -> FolderPreferences {
    let p = Path::new(project_path);
    let mut settings_files = global_settings_files();
    settings_files.push(sf(p.join(".claude").join("settings.json"), "Project (shared)", "project", false));
    settings_files.push(sf(p.join(".claude").join("settings.local.json"), "Project Local", "project-local", false));

    let mut md_files = global_md_files();
    md_files.push(md(p.join(".claude").join("CLAUDE.md"), "Project (.claude/CLAUDE.md)", "project-nested"));
    md_files.push(md(p.join("CLAUDE.md"), "Project Root (CLAUDE.md)", "project"));

    FolderPreferences {
        project_path: project_path.to_string(),
        project_name: p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| project_path.to_string()),
        settings_files,
        md_files,
    }
}

pub fn save_settings_file(path: &str, updates: Value) {
    let p = Path::new(path);
    let mut existing = if p.exists() { read_json(p) } else { json!({}) };
    if let (Some(base), Some(up)) = (existing.as_object_mut(), updates.as_object()) {
        for (k, v) in up {
            base.insert(k.clone(), v.clone());
        }
    } else {
        existing = updates;
    }
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(s) = serde_json::to_string_pretty(&existing) {
        let _ = std::fs::write(p, format!("{s}\n"));
    }
}

pub fn save_md_file(path: &str, content: &str) -> Result<(), String> {
    let p = Path::new(path);
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    }
    std::fs::write(p, content).map_err(|e| format!("write {}: {e}", p.display()))
}

pub fn create_file(path: &str, kind: &str) {
    let p = Path::new(path);
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let content = if kind == "settings" { "{}\n" } else { "" };
    let _ = std::fs::write(p, content);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub source: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServersResult {
    pub servers: Vec<McpServerInfo>,
}

fn collect_mcp(data: &Value, source: &str, out: &mut Vec<McpServerInfo>) {
    if let Some(map) = data.get("mcpServers").and_then(|v| v.as_object()) {
        for (name, cfg) in map {
            let kind = cfg.get("type").and_then(|v| v.as_str()).unwrap_or("stdio").to_string();
            out.push(McpServerInfo { name: name.clone(), kind, source: source.into() });
        }
    }
}

pub fn get_mcp_servers(project_path: &str) -> McpServersResult {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut servers = vec![];

    let user_json = read_json(&Path::new(&home).join(".claude.json"));
    collect_mcp(&user_json, "~/.claude.json", &mut servers);
    if let Some(cloud) = user_json.get("claudeAiMcpEverConnected").and_then(|v| v.as_array()) {
        for name in cloud.iter().filter_map(|v| v.as_str()) {
            servers.push(McpServerInfo { name: name.to_string(), kind: "cloud".into(), source: "cloud".into() });
        }
    }
    collect_mcp(&read_json(&Path::new(project_path).join(".mcp.json")), ".mcp.json", &mut servers);

    McpServersResult { servers }
}
