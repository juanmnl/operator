// Tauri 2 backend for Operator. Multi-terminal pty manager + transcript-driven
// session tracking (see transcript.rs / core.rs).

#[path = "core.rs"]
mod backend;
#[path = "worktree.rs"]
mod worktree;
#[path = "agents.rs"]
mod agents;
#[path = "usage.rs"]
mod usage;
#[path = "folderprefs.rs"]
mod folderprefs;
#[path = "transcript.rs"]
mod transcript;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{Emitter, Manager, State};

use backend::{AgentSession, Sessions};

struct Pty {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    cwd: String,
}

#[derive(Default)]
pub struct PtyManager {
    ptys: Mutex<HashMap<String, Pty>>,
    next: AtomicU64,
    /// Last time each terminal produced output — a real-time "actively working"
    /// signal for the status indicator (claude streams while thinking/running).
    activity: Mutex<HashMap<String, Instant>>,
}

impl PtyManager {
    /// Whether a terminal's pty is still open (removed on exit).
    pub fn alive(&self, id: &str) -> bool {
        self.ptys.lock().unwrap().contains_key(id)
    }

    pub fn note_activity(&self, id: &str) {
        self.activity.lock().unwrap().insert(id.to_string(), Instant::now());
    }

    /// Did this terminal emit output within `dur`? (i.e. is it actively working)
    pub fn active_within(&self, id: &str, dur: Duration) -> bool {
        self.activity.lock().unwrap().get(id).map(|t| t.elapsed() < dur).unwrap_or(false)
    }
}

#[derive(Clone, Serialize)]
struct TerminalDataPayload {
    id: String,
    data: Vec<u8>,
}

// --- Terminal commands ------------------------------------------------------

#[tauri::command]
fn terminal_spawn(
    app: tauri::AppHandle,
    cwd: String,
    args: Vec<String>,
    session_id: String,
    permission_mode: Option<String>,
    mgr: State<Arc<PtyManager>>,
    reg: State<transcript::TrackRegistry>,
) -> Result<String, String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows: 30, cols: 100, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let id = format!("t{}", mgr.next.fetch_add(1, Ordering::Relaxed));

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let inner = std::iter::once("claude".to_string())
        .chain(args)
        .map(|a| shell_quote(&a))
        .collect::<Vec<_>>()
        .join(" ");
    let mut cmd = CommandBuilder::new(&shell);
    cmd.args(["-ilc", &inner]);
    cmd.cwd(&cwd);
    cmd.env("OPERATOR_TERMINAL_ID", &id);
    cmd.env("FORCE_COLOR", "1");
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // Claude Code gates its inline "prompt suggestions" (ghost-text you accept
    // with Tab/Enter) on recognising the host terminal via TERM_PROGRAM, which a
    // bare pty leaves unset. Identify as iTerm so the feature turns on; xterm.js
    // handles the common iTerm sequences, and we only ever paste image *paths*
    // (never the inline-image protocol), so impersonating it is safe here.
    cmd.env("TERM_PROGRAM", "iTerm.app");

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let killer = child.clone_killer();
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    mgr.ptys.lock().unwrap().insert(
        id.clone(),
        Pty { writer, master: pair.master, killer, cwd: cwd.clone() },
    );

    // Register so the transcript tailer watches this session's JSONL.
    // session_id is the forced `--session-id` (or the resumed id), so the
    // transcript mapping is exact.
    reg.register(
        id.clone(),
        transcript::NewTrack { claude_session_id: session_id, cwd: cwd.clone(), permission_mode },
    );

    let emit_id = id.clone();
    let mgr_arc = mgr.inner().clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    mgr_arc.note_activity(&emit_id);
                    let _ = app.emit("terminal:data", TerminalDataPayload { id: emit_id.clone(), data: buf[..n].to_vec() });
                }
            }
        }
        mgr_arc.ptys.lock().unwrap().remove(&emit_id);
        let _ = app.emit("terminal:exit", emit_id.clone());
    });

    Ok(id)
}

#[tauri::command]
fn terminal_write(id: String, data: String, mgr: State<Arc<PtyManager>>) {
    if let Some(p) = mgr.ptys.lock().unwrap().get_mut(&id) {
        let _ = p.writer.write_all(data.as_bytes());
        let _ = p.writer.flush();
    }
}

#[tauri::command]
fn terminal_resize(id: String, cols: u16, rows: u16, mgr: State<Arc<PtyManager>>) {
    if let Some(p) = mgr.ptys.lock().unwrap().get(&id) {
        let _ = p.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
    }
}

#[tauri::command]
fn terminal_kill(id: String, mgr: State<Arc<PtyManager>>) {
    if let Some(mut p) = mgr.ptys.lock().unwrap().remove(&id) {
        let _ = p.killer.kill();
    }
}

#[derive(Serialize)]
struct TerminalInfo {
    id: String,
    cwd: String,
}

#[tauri::command]
fn terminal_list(mgr: State<Arc<PtyManager>>) -> Vec<TerminalInfo> {
    mgr.ptys.lock().unwrap().iter().map(|(id, p)| TerminalInfo { id: id.clone(), cwd: p.cwd.clone() }).collect()
}

// --- Sessions command -------------------------------------------------------

#[tauri::command]
fn get_sessions(sessions: State<Sessions>) -> Vec<AgentSession> {
    sessions.get_active()
}

// --- Worktree commands ------------------------------------------------------

#[tauri::command]
fn inspect_repo(cwd: String) -> worktree::RepoInfo {
    worktree::inspect_repo(&cwd)
}

#[tauri::command]
fn worktree_create(cwd: String) -> Result<worktree::WorktreeCreateResult, String> {
    worktree::create_worktree(&cwd)
}

#[tauri::command]
fn worktree_status(path: String) -> worktree::WorktreeStatus {
    worktree::worktree_status(&path)
}

#[tauri::command]
fn worktree_diff(path: String) -> worktree::WorktreeDiff {
    worktree::worktree_diff(&path)
}

#[tauri::command]
fn worktree_remove(path: String, source_root: String) -> Result<(), String> {
    worktree::remove_worktree(&path, &source_root)
}

#[tauri::command]
fn worktree_commit(path: String, message: String) -> Result<String, String> {
    worktree::commit_all(&path, &message)
}

#[tauri::command]
fn worktree_merge(worktree_path: String, source_root: String, branch: String, base_branch: String) -> worktree::MergeResult {
    worktree::merge_branch(&worktree_path, &source_root, &branch, &base_branch)
}

#[tauri::command]
fn worktree_discard(worktree_path: String, source_root: String, branch: String) -> Result<(), String> {
    worktree::discard_branch(&worktree_path, &source_root, &branch)
}

// --- Durable session snapshot (~/.operator/sessions.json) --------------------
// A crash-safe source of truth for "continue where you left off", written
// synchronously (atomic temp+rename) on every change — unlike webview
// localStorage, which can lazily persist and lose the last writes on a hard kill.

fn sessions_file() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    std::path::Path::new(&home).join(".operator").join("sessions.json")
}

#[tauri::command]
fn save_sessions(sessions: serde_json::Value) {
    let path = sessions_file();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(s) = serde_json::to_string_pretty(&sessions) {
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, s).is_ok() {
            let _ = std::fs::rename(&tmp, &path); // atomic swap
        }
    }
}

#[tauri::command]
fn load_sessions() -> serde_json::Value {
    std::fs::read_to_string(sessions_file())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::Value::Array(vec![]))
}

// --- Agents / usage / folder-prefs commands ---------------------------------

#[tauri::command]
fn agents_list(project_path: Option<String>) -> Vec<agents::AgentDefinition> {
    agents::list_agents(project_path.as_deref())
}

#[tauri::command]
fn agent_save(def: agents::AgentDefinition, original_path: Option<String>) -> agents::SaveResult {
    agents::save_agent(&def, original_path.as_deref())
}

#[tauri::command]
fn agent_delete(path: String) -> agents::OkResult {
    agents::delete_agent(&path)
}

#[tauri::command]
async fn get_usage_stats(days: Option<i64>) -> Result<usage::UsageStats, String> {
    // Heavy transcript scan — run off the main thread so the UI stays responsive.
    tauri::async_runtime::spawn_blocking(move || usage::compute_usage(days.unwrap_or(30)))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_usage_insights(days: Option<i64>) -> Result<usage::Insights, String> {
    tauri::async_runtime::spawn_blocking(move || usage::compute_insights(days.unwrap_or(7)))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn folder_prefs_load(project_path: String) -> folderprefs::FolderPreferences {
    folderprefs::load_folder_preferences(&project_path)
}

#[tauri::command]
fn folder_prefs_load_global() -> folderprefs::FolderPreferences {
    folderprefs::load_global_preferences()
}

#[tauri::command]
fn folder_prefs_save_settings(path: String, settings: serde_json::Value) {
    folderprefs::save_settings_file(&path, settings)
}

#[tauri::command]
fn folder_prefs_save_md(path: String, content: String) {
    folderprefs::save_md_file(&path, &content)
}

#[tauri::command]
fn folder_prefs_create_file(path: String, kind: String) {
    folderprefs::create_file(&path, &kind)
}

#[tauri::command]
fn get_mcp_servers(project_path: String) -> folderprefs::McpServersResult {
    folderprefs::get_mcp_servers(&project_path)
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

// Menu-bar tray icon: the dot-circle logo (no count). Clicking it opens a menu
// listing the active sessions and their states — rebuilt by the transcript
// tailer via transcript::refresh_tray_menu. Clicking an item focuses the app.
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::image::Image;
    use tauri::menu::MenuBuilder;
    use tauri::tray::TrayIconBuilder;

    let h = app.handle();
    let menu = MenuBuilder::new(h).text("show", "Show Operator").separator().quit().build()?;
    let icon = Image::from_bytes(include_bytes!("../icons/tray.png"))?;

    TrayIconBuilder::with_id("operator")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Operator")
        .menu(&menu)
        .show_menu_on_left_click(true) // click → show active sessions + states
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == "show" || id.starts_with("session:") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        })
        .build(h)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Persist + restore the window's size/position across launches.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(Arc::new(PtyManager::default()))
        .manage(Sessions::default())
        .manage(transcript::TrackRegistry::default())
        .setup(|app| {
            transcript::start_tailer(app.handle().clone());
            build_tray(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            terminal_spawn,
            terminal_write,
            terminal_resize,
            terminal_kill,
            terminal_list,
            get_sessions,
            inspect_repo,
            worktree_create,
            worktree_status,
            worktree_diff,
            worktree_remove,
            worktree_commit,
            worktree_merge,
            worktree_discard,
            agents_list,
            agent_save,
            agent_delete,
            get_usage_stats,
            get_usage_insights,
            folder_prefs_load,
            folder_prefs_load_global,
            folder_prefs_save_settings,
            folder_prefs_save_md,
            folder_prefs_create_file,
            get_mcp_servers,
            save_sessions,
            load_sessions
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
