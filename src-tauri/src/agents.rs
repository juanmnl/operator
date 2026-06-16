// Agent library (port of agents.ts): read/write Claude Code subagent definition
// files (.claude/agents/*.md) at user (~/.claude) and project scope.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_yaml::Value as Yaml;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefinition {
    pub name: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default)]
    pub prompt: String,
    pub scope: String, // "user" | "project"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    #[serde(default)]
    pub path: String,
}

fn user_agents_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".claude").join("agents")
}

fn split_frontmatter(raw: &str) -> (Yaml, String) {
    if let Some(rest) = raw.strip_prefix("---\n").or_else(|| raw.strip_prefix("---\r\n")) {
        if let Some(end) = rest.find("\n---") {
            let fm = &rest[..end];
            let body = rest[end + 4..].trim_start_matches(['\r', '\n']).to_string();
            let yaml = serde_yaml::from_str::<Yaml>(fm).unwrap_or(Yaml::Null);
            return (yaml, body);
        }
    }
    (Yaml::Null, raw.to_string())
}

fn yaml_str(m: &Yaml, key: &str) -> Option<String> {
    m.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

fn parse_agent(path: &Path, scope: &str, project_path: Option<&str>) -> Option<AgentDefinition> {
    let raw = std::fs::read_to_string(path).ok()?;
    let (fm, body) = split_frontmatter(&raw);
    let name = yaml_str(&fm, "name").filter(|n| !n.trim().is_empty())?;
    let tools = fm.get("tools").and_then(|v| match v {
        Yaml::Sequence(seq) => Some(seq.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()),
        Yaml::String(s) => Some(s.split(',').map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect()),
        _ => None,
    });
    Some(AgentDefinition {
        name,
        description: yaml_str(&fm, "description").unwrap_or_default(),
        model: yaml_str(&fm, "model"),
        tools,
        effort: yaml_str(&fm, "effort"),
        max_turns: fm.get("maxTurns").and_then(|v| v.as_u64()).map(|n| n as u32),
        color: yaml_str(&fm, "color"),
        prompt: body.trim().to_string(),
        scope: scope.to_string(),
        project_path: project_path.map(|s| s.to_string()),
        path: path.to_string_lossy().to_string(),
    })
}

fn read_dir_agents(dir: &Path, scope: &str, project_path: Option<&str>, out: &mut Vec<AgentDefinition>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            read_dir_agents(&p, scope, project_path, out);
        } else if p.extension().map(|e| e == "md").unwrap_or(false) {
            if let Some(a) = parse_agent(&p, scope, project_path) {
                out.push(a);
            }
        }
    }
}

pub fn list_agents(project_path: Option<&str>) -> Vec<AgentDefinition> {
    let mut out = vec![];
    read_dir_agents(&user_agents_dir(), "user", None, &mut out);
    if let Some(pp) = project_path {
        let dir = Path::new(pp).join(".claude").join("agents");
        read_dir_agents(&dir, "project", Some(pp), &mut out);
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

fn file_stem(name: &str) -> String {
    let s: String = name.trim().to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' }).collect();
    let s = s.trim_matches('-').to_string();
    if s.is_empty() { "agent".into() } else { s }
}

fn serialize_agent(def: &AgentDefinition) -> String {
    let mut map = serde_yaml::Mapping::new();
    map.insert("name".into(), def.name.clone().into());
    map.insert("description".into(), def.description.clone().into());
    if let Some(m) = &def.model { if !m.is_empty() { map.insert("model".into(), m.clone().into()); } }
    if let Some(t) = &def.tools { if !t.is_empty() { map.insert("tools".into(), Yaml::Sequence(t.iter().map(|s| s.clone().into()).collect())); } }
    if let Some(e) = &def.effort { if !e.is_empty() { map.insert("effort".into(), e.clone().into()); } }
    if let Some(n) = def.max_turns { map.insert("maxTurns".into(), (n as u64).into()); }
    if let Some(c) = &def.color { if !c.is_empty() { map.insert("color".into(), c.clone().into()); } }
    let yaml = serde_yaml::to_string(&Yaml::Mapping(map)).unwrap_or_default();
    format!("---\n{}---\n\n{}\n", yaml, def.prompt.trim())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub fn save_agent(def: &AgentDefinition, original_path: Option<&str>) -> SaveResult {
    if def.name.trim().is_empty() {
        return SaveResult { ok: false, path: None, error: Some("Agent name is required".into()) };
    }
    if def.description.trim().is_empty() {
        return SaveResult { ok: false, path: None, error: Some("Description is required".into()) };
    }
    let dir = if def.scope == "project" {
        match &def.project_path {
            Some(pp) => Path::new(pp).join(".claude").join("agents"),
            None => return SaveResult { ok: false, path: None, error: Some("Project path is required for a project agent".into()) },
        }
    } else {
        user_agents_dir()
    };
    let target = dir.join(format!("{}.md", file_stem(&def.name)));
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return SaveResult { ok: false, path: None, error: Some(e.to_string()) };
    }
    if let Err(e) = std::fs::write(&target, serialize_agent(def)) {
        return SaveResult { ok: false, path: None, error: Some(e.to_string()) };
    }
    if let Some(orig) = original_path {
        if !orig.is_empty() && Path::new(orig) != target && Path::new(orig).exists() {
            let _ = std::fs::remove_file(orig);
        }
    }
    SaveResult { ok: true, path: Some(target.to_string_lossy().to_string()), error: None }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OkResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub fn delete_agent(path: &str) -> OkResult {
    match std::fs::remove_file(path) {
        Ok(_) => OkResult { ok: true, error: None },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => OkResult { ok: true, error: None },
        Err(e) => OkResult { ok: false, error: Some(e.to_string()) },
    }
}
