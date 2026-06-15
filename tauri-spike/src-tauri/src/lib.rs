// Tauri 2 backend for Operator. Multi-terminal pty manager + the hook decision
// pipeline / session tracking / rules engine (ported in core.rs).

#[path = "core.rs"]
mod backend;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{Emitter, Manager, State};

use backend::{
    evaluate_rules, is_auto_approved, load_rules, make_request, response, rules_add, rules_list,
    rules_remove, summarize, AgentSession, HookEvent, OperatorRequest, Rule, Sessions,
};

const HOOK_PORT: u16 = 47821;

struct Pty {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    cwd: String,
}

#[derive(Default)]
struct PtyManager {
    ptys: Mutex<HashMap<String, Pty>>,
    next: AtomicU64,
}

#[derive(Default)]
struct HookState {
    pending: Mutex<HashMap<String, Sender<bool>>>,
    queue: Mutex<Vec<OperatorRequest>>,
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
    mgr: State<Arc<PtyManager>>,
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
    // So operator-hook.sh forwards this session's events to us.
    cmd.env("OPERATOR_TERMINAL_ID", &id);
    cmd.env("FORCE_COLOR", "1");
    cmd.env("TERM", "xterm-256color");

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let killer = child.clone_killer();
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    mgr.ptys.lock().unwrap().insert(
        id.clone(),
        Pty { writer, master: pair.master, killer, cwd: cwd.clone() },
    );

    let emit_id = id.clone();
    let mgr_arc = mgr.inner().clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
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

// --- Sessions / queue / rules commands --------------------------------------

#[tauri::command]
fn get_sessions(sessions: State<Sessions>) -> Vec<AgentSession> {
    sessions.get_active()
}

#[tauri::command]
fn get_queue(hook: State<HookState>) -> Vec<OperatorRequest> {
    hook.queue.lock().unwrap().clone()
}

#[tauri::command]
fn rules_list_cmd() -> Vec<Rule> {
    rules_list()
}

#[tauri::command]
fn rules_add_cmd(tool: String, pattern: Option<String>, scope: Option<String>, action: String) -> Rule {
    rules_add(tool, pattern, scope, action)
}

#[tauri::command]
fn rules_remove_cmd(id: String) {
    rules_remove(&id)
}

/// Resolve a blocking hook request the UI was prompted about.
#[tauri::command]
fn respond(id: String, approve: bool, hook: State<HookState>) {
    if let Some(tx) = hook.pending.lock().unwrap().remove(&id) {
        let _ = tx.send(approve);
    }
}

// --- Hook server (port of server.ts /hook) ----------------------------------

fn start_hook_server(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let server = match tiny_http::Server::http(("127.0.0.1", HOOK_PORT)) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("hook server failed to bind :{HOOK_PORT}: {e}");
                return;
            }
        };
        println!("Operator (tauri) hook server on http://127.0.0.1:{HOOK_PORT}");
        for mut req in server.incoming_requests() {
            if req.url() == "/health" {
                let _ = req.respond(tiny_http::Response::from_string("{\"status\":\"ok\"}"));
                continue;
            }
            let app = app.clone();
            std::thread::spawn(move || {
                let mut body = String::new();
                let _ = req.as_reader().read_to_string(&mut body);
                let decision = handle_hook(&app, &body);
                let _ = req.respond(tiny_http::Response::from_string(decision));
            });
        }
    });
}

fn handle_hook(app: &tauri::AppHandle, body: &str) -> String {
    let mut event: HookEvent = match serde_json::from_str(body) {
        Ok(e) => e,
        Err(_) => return "{\"status\":\"ok\"}".into(),
    };
    if event.hook_event_name.is_empty() || event.hook_event_name == "unknown" {
        if event.tool_name.is_some() {
            event.hook_event_name = "PreToolUse".into();
        }
    }

    let sessions = app.state::<Sessions>();
    let perm_mode = sessions.record_event(&event);
    let _ = app.emit("session:update", sessions.get_active());

    if event.hook_event_name != "PreToolUse" {
        return "{\"status\":\"ok\"}".into();
    }

    let tool = event.tool_name.as_deref();

    if is_auto_approved(tool) {
        return "{\"decision\":\"approve\"}".into();
    }
    if matches!(perm_mode.as_deref(), Some("auto") | Some("bypassPermissions")) {
        return "{\"decision\":\"approve\"}".into();
    }
    if let Some(action) = evaluate_rules(&load_rules(), tool.unwrap_or(""), event.tool_input.as_ref().unwrap_or(&serde_json::Value::Null), event.cwd.as_deref()) {
        return format!("{{\"decision\":\"{}\"}}", if action == "approve" { "approve" } else { "deny" });
    }

    // Blocking permission flow.
    let summary = summarize(tool.unwrap_or("Tool"), event.tool_input.as_ref().unwrap_or(&serde_json::Value::Null));
    let id = format!("op-{}", now_counter());
    let request = make_request(&event, &summary, id.clone());

    if let Some(sid) = &event.session_id {
        sessions.track_request(sid, &request);
    }

    let hook = app.state::<HookState>();
    let (tx, rx) = channel::<bool>();
    hook.pending.lock().unwrap().insert(id.clone(), tx);
    hook.queue.lock().unwrap().push(request.clone());

    let _ = app.emit("hook:new-request", request.clone());
    let _ = app.emit("session:update", sessions.get_active());

    let approve = rx.recv_timeout(Duration::from_secs(300)).unwrap_or(true);

    hook.pending.lock().unwrap().remove(&id);
    hook.queue.lock().unwrap().retain(|r| r.id != id);
    sessions.resolve_request(&id, response(approve));
    let _ = app.emit("session:update", sessions.get_active());

    format!("{{\"decision\":\"{}\"}}", if approve { "approve" } else { "deny" })
}

fn now_counter() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(PtyManager::default()))
        .manage(HookState::default())
        .manage(Sessions::default())
        .setup(|app| {
            start_hook_server(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            terminal_spawn,
            terminal_write,
            terminal_resize,
            terminal_kill,
            terminal_list,
            get_sessions,
            get_queue,
            rules_list_cmd,
            rules_add_cmd,
            rules_remove_cmd,
            respond
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
