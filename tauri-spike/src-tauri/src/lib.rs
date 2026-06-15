// Tauri 2 backend for Operator (Phase 1). Multi-terminal pty manager + the
// blocking hook HTTP server. Other backend modules (sessions, rules, worktree,
// agents, usage, folder-prefs) are ported incrementally on top of this.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{Emitter, Manager, State};

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
    next_id: AtomicU64,
}

#[derive(Clone, Serialize)]
struct TerminalDataPayload {
    id: String,
    data: Vec<u8>,
}

// --- Terminal commands ------------------------------------------------------

/// Spawn a pty running `claude` (with args) through an interactive login shell.
/// Returns the new terminal id. Output streams via the `terminal:data` event.
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

    // `zsh -ilc 'claude <args>'` — login shell loads the real PATH (Finder fix).
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let inner = std::iter::once("claude".to_string())
        .chain(args.into_iter())
        .map(|a| shell_quote(&a))
        .collect::<Vec<_>>()
        .join(" ");
    let mut cmd = CommandBuilder::new(&shell);
    cmd.args(["-ilc", &inner]);
    cmd.cwd(&cwd);

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let killer = child.clone_killer();
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let id = format!("t{}", mgr.next.fetch_add(1, Ordering::Relaxed));
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
                    let _ = app.emit(
                        "terminal:data",
                        TerminalDataPayload { id: emit_id.clone(), data: buf[..n].to_vec() },
                    );
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
    mgr.ptys
        .lock()
        .unwrap()
        .iter()
        .map(|(id, p)| TerminalInfo { id: id.clone(), cwd: p.cwd.clone() })
        .collect()
}

// --- Misc commands ----------------------------------------------------------

#[tauri::command]
fn respond(id: String, approve: bool, state: State<HookState>) {
    if let Some(tx) = state.pending.lock().unwrap().remove(&id) {
        let _ = tx.send(approve);
    }
}

// --- Hook server ------------------------------------------------------------

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
                let id = {
                    let st = app.state::<HookState>();
                    format!("req-{}", st.next_id.fetch_add(1, Ordering::Relaxed))
                };
                let (tx, rx) = channel::<bool>();
                app.state::<HookState>().pending.lock().unwrap().insert(id.clone(), tx);
                let _ = app.emit("hook:request", serde_json::json!({ "id": id, "body": body }));
                let approve = rx.recv_timeout(Duration::from_secs(300)).unwrap_or(true);
                app.state::<HookState>().pending.lock().unwrap().remove(&id);
                let decision = if approve { "approve" } else { "deny" };
                let _ = req.respond(tiny_http::Response::from_string(format!(
                    "{{\"decision\":\"{decision}\"}}"
                )));
            });
        }
    });
}

/// Single-quote a shell argument, escaping embedded single quotes.
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
            respond
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
