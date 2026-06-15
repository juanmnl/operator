// Tauri 2 migration spike. Proves the two risky pieces from docs/tauri-migration.md:
//   1. A Rust pty (portable-pty) streaming raw bytes to xterm.js in the webview.
//   2. A blocking local HTTP "hook" server that round-trips an approve/deny
//      decision back to the renderer (the heart of Operator's permission flow).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::time::Duration;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::{Emitter, Manager, State};

const HOOK_PORT: u16 = 47822; // 47821 belongs to the running Electron app; avoid clashing.

#[derive(Default)]
struct PtyState {
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
}

#[derive(Default)]
struct HookState {
    pending: Mutex<HashMap<String, Sender<bool>>>,
    next_id: AtomicU64,
}

// --- Pty (risk #2) ----------------------------------------------------------

#[tauri::command]
fn pty_spawn(app: tauri::AppHandle, state: State<PtyState>) -> Result<(), String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows: 30, cols: 100, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    // Interactive login shell so the user's real PATH is loaded (the Finder-PATH fix).
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = CommandBuilder::new(shell);
    cmd.args(["-il"]);
    if let Ok(home) = std::env::var("HOME") {
        cmd.cwd(home);
    }
    let _child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    *state.writer.lock().unwrap() = Some(writer);
    *state.master.lock().unwrap() = Some(pair.master);

    // Stream raw bytes — no lossy UTF-8 decode, so multibyte chars split across
    // reads stay intact; xterm.js decodes the Uint8Array itself.
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let _ = app.emit("pty-data", buf[..n].to_vec());
                }
            }
        }
        let _ = app.emit("pty-exit", ());
    });
    Ok(())
}

#[tauri::command]
fn pty_write(data: String, state: State<PtyState>) -> Result<(), String> {
    if let Some(w) = state.writer.lock().unwrap().as_mut() {
        w.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        w.flush().ok();
    }
    Ok(())
}

#[tauri::command]
fn pty_resize(rows: u16, cols: u16, state: State<PtyState>) -> Result<(), String> {
    if let Some(m) = state.master.lock().unwrap().as_ref() {
        m.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// --- Blocking hook server (risk #1) -----------------------------------------

#[tauri::command]
fn respond(id: String, approve: bool, state: State<HookState>) {
    if let Some(tx) = state.pending.lock().unwrap().remove(&id) {
        let _ = tx.send(approve);
    }
}

fn start_hook_server(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let server = match tiny_http::Server::http(("127.0.0.1", HOOK_PORT)) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("hook server failed to bind :{HOOK_PORT}: {e}");
                return;
            }
        };
        println!("spike hook server on http://127.0.0.1:{HOOK_PORT}");
        for mut req in server.incoming_requests() {
            if req.url() == "/health" {
                let _ = req.respond(tiny_http::Response::from_string("{\"status\":\"ok\"}"));
                continue;
            }
            // Each request blocks until the user decides, so handle it on its own
            // thread to keep accepting (mirrors the per-request oneshot in the plan).
            let app = app.clone();
            std::thread::spawn(move || {
                let mut body = String::new();
                let _ = req.as_reader().read_to_string(&mut body);

                let id = {
                    let st = app.state::<HookState>();
                    let n = st.next_id.fetch_add(1, Ordering::Relaxed);
                    format!("req-{n}")
                };
                let (tx, rx) = channel::<bool>();
                app.state::<HookState>().pending.lock().unwrap().insert(id.clone(), tx);

                let _ = app.emit("hook-request", serde_json::json!({ "id": id, "body": body }));

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PtyState::default())
        .manage(HookState::default())
        .setup(|app| {
            start_hook_server(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![pty_spawn, pty_write, pty_resize, respond])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
