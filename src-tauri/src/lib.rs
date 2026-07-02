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
#[path = "tray_anim.rs"]
mod tray_anim;
#[path = "gridterm.rs"]
mod gridterm;
mod chatstore;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize, SlavePty};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use backend::{AgentSession, Sessions};

struct Pty {
    /// Input is fed to the pty's writer (which lives on a dedicated thread, see
    /// spawn_writer) through this channel, so terminal_write never holds the ptys
    /// lock across a blocking write and bytes are applied in queue order.
    tx: std::sync::mpsc::Sender<Vec<u8>>,
    master: Box<dyn MasterPty + Send>,
    /// None until the deferred child is actually exec'd (see `terminal_start`): the
    /// pty is opened and sized first, then Claude launches at the final grid width so
    /// classic-mode scrollback never mis-wraps. Set once the child spawns.
    killer: Option<Box<dyn ChildKiller + Send + Sync>>,
    cwd: String,
}

/// A pty that's open + sized but whose command hasn't been exec'd yet. Held between
/// `terminal_spawn` (opens the pty) and `terminal_start` (launches Claude once the pane
/// has reported its real fitted width) so the process starts at the exact grid size.
struct PendingStart {
    cmd: CommandBuilder,
    slave: Box<dyn SlavePty + Send>,
}

/// Recover a Mutex guard even if a previous holder panicked (poisoning). The pty
/// map's invariant (id → handle) survives an unrelated panic, so proceeding with
/// the inner data is far better than letting one panic make every later
/// terminal_write across ALL terminals fail forever.
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Move a pty's writer onto its own thread fed by an mpsc channel. Returns the
/// Sender to store in the Pty. The thread exits when the last Sender drops (on
/// kill/exit). On a write error the pty is treated as gone — emit terminal:exit
/// so the UI reflects it instead of silently dropping input.
fn spawn_writer(
    app: tauri::AppHandle,
    id: String,
    mut writer: Box<dyn Write + Send>,
) -> std::sync::mpsc::Sender<Vec<u8>> {
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        while let Ok(bytes) = rx.recv() {
            if writer.write_all(&bytes).and_then(|_| writer.flush()).is_err() {
                let _ = app.emit("terminal:exit", id.clone());
                break;
            }
        }
    });
    tx
}

#[derive(Default)]
pub struct PtyManager {
    ptys: Mutex<HashMap<String, Pty>>,
    next: AtomicU64,
    /// Last time each terminal produced output — a real-time "actively working"
    /// signal for the status indicator (claude streams while thinking/running).
    activity: Mutex<HashMap<String, Instant>>,
    /// Dev-server port handed to each session via OPERATOR_DEV_PORT, tracked so
    /// parallel worktree agents never grab the same port.
    ports: Mutex<HashMap<String, u16>>,
    /// Rolling tail of each pty's raw output (capped). The Rust backend outlives a
    /// renderer/webview reload, so its ptys keep running — this lets a re-attaching
    /// terminal replay recent scrollback instead of showing a blank pane.
    history: Mutex<HashMap<String, Vec<u8>>>,
    /// Ptys opened but not yet launched — awaiting `terminal_start` (or the fallback
    /// timer) so Claude execs at the pane's final fitted width. See PendingStart.
    pending: Mutex<HashMap<String, PendingStart>>,
}

/// A localhost port counts as free only if it can be bound on BOTH IPv4 (127.0.0.1) and
/// IPv6 (::1) loopback. Checking IPv4 alone missed servers that modern Node/Vite bind to
/// `[::1]` for `localhost` — an orphaned dev server from a prior run, or another app — so
/// Operator would reserve that "free" port and the Preview, loading `localhost:PORT`, would
/// resolve to `[::1]` and show the foreign server. Each test listener is dropped immediately
/// (the session's real server binds a moment later). IPv6 loopback is always present on
/// macOS (this app's only target), so a bind failure there means the port is genuinely busy.
fn port_free(port: u16) -> bool {
    use std::net::{Ipv4Addr, Ipv6Addr, TcpListener};
    TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok()
        && TcpListener::bind((Ipv6Addr::LOCALHOST, port)).is_ok()
}

/// Max bytes of pty output retained per terminal for re-attach replay.
const HISTORY_CAP: usize = 256 * 1024;

impl PtyManager {
    /// Whether a terminal's pty is still open (removed on exit).
    pub fn alive(&self, id: &str) -> bool {
        lock(&self.ptys).contains_key(id)
    }

    pub fn note_activity(&self, id: &str) {
        lock(&self.activity).insert(id.to_string(), Instant::now());
    }

    /// Did this terminal emit output within `dur`? (i.e. is it actively working)
    pub fn active_within(&self, id: &str, dur: Duration) -> bool {
        lock(&self.activity).get(id).map(|t| t.elapsed() < dur).unwrap_or(false)
    }

    /// Reserve a free localhost port for this session's dev server. Scans up from
    /// 1420, skipping ports already handed to a sibling session and any the OS
    /// reports busy right now (bind-test, dropped immediately — the dev server
    /// binds a moment later). Returns None if the whole range is exhausted.
    pub fn alloc_port(&self, id: &str) -> Option<u16> {
        let mut ports = lock(&self.ports);
        let taken: std::collections::HashSet<u16> = ports.values().copied().collect();
        for port in 1420u16..1520 {
            if taken.contains(&port) {
                continue;
            }
            if port_free(port) {
                ports.insert(id.to_string(), port);
                return Some(port);
            }
        }
        None
    }

    /// Hand the port back when its session ends, so it can be reused.
    pub fn release_port(&self, id: &str) {
        lock(&self.ports).remove(id);
    }

    /// Snapshot of every live session's dev port (terminal id → port).
    pub fn dev_ports(&self) -> HashMap<String, u16> {
        lock(&self.ports).clone()
    }

    /// Append pty output to the re-attach replay buffer. Trims lazily — only once
    /// the buffer grows past 2×HISTORY_CAP, back down to HISTORY_CAP — so the O(n)
    /// front-drain runs about once per HISTORY_CAP of output instead of on every
    /// chunk (avoids write amplification during heavy streaming). The front-trim may
    /// clip a partial sequence on the oldest line — harmless, it's scrolled-away.
    pub fn push_history(&self, id: &str, bytes: &[u8]) {
        let mut h = lock(&self.history);
        let buf = h.entry(id.to_string()).or_default();
        buf.extend_from_slice(bytes);
        if buf.len() > HISTORY_CAP * 2 {
            let drop = buf.len() - HISTORY_CAP;
            buf.drain(0..drop);
        }
    }

    /// Base64 of a terminal's retained output, for replay on re-attach ("" if none).
    pub fn history_b64(&self, id: &str) -> String {
        use base64::Engine;
        lock(&self.history)
            .get(id)
            .map(|b| base64::engine::general_purpose::STANDARD.encode(b))
            .unwrap_or_default()
    }

    pub fn clear_history(&self, id: &str) {
        lock(&self.history).remove(id);
    }

}

#[derive(Clone, Serialize)]
struct TerminalDataPayload {
    id: String,
    /// pty output as base64. Shipping raw `Vec<u8>` over Tauri's JSON event
    /// channel expands each byte to "NNN," (~4 chars) and makes V8 parse every
    /// number — brutal at Claude Code's redraw volume. base64 is ~1.33 chars/byte
    /// and decodes via native atob, so the hot path stays cheap.
    data: String,
}

// --- Terminal commands ------------------------------------------------------

/// Strip env vars that mark a process as running INSIDE another Claude Code
/// session. If Operator itself was launched from a Claude session (e.g. `npm run
/// tauri dev` started from a chat), these leak in and make the `claude` WE spawn
/// behave as a nested "child" session — which does NOT write a normal project
/// transcript, so the transcript observer (and the reading panel / activity
/// timeline) sees nothing. A session Operator launches must be a clean top-level
/// session. No-op when Operator was launched normally (vars unset).
fn strip_nested_session_env(cmd: &mut CommandBuilder) {
    for k in [
        "CLAUDECODE",
        "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_CODE_CHILD_SESSION",
        "CLAUDE_CODE_EXECPATH",
    ] {
        cmd.env_remove(k);
    }
}

#[tauri::command]
fn terminal_spawn(
    app: tauri::AppHandle,
    cwd: String,
    args: Vec<String>,
    session_id: String,
    permission_mode: Option<String>,
    tui_mode: Option<String>,
    color_scheme: Option<String>,
    grid: Option<bool>,
    term_bg: Option<String>,
    term_fg: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    mgr: State<Arc<PtyManager>>,
    reg: State<transcript::TrackRegistry>,
) -> Result<String, String> {
    // Open the pty at the size the pane will ACTUALLY fit to (measured on the frontend
    // and passed in), not a fixed default. Claude Code draws its welcome box wrapped to
    // whatever width the pty reports at startup; if that width is wrong, the pane's first
    // fit SIGWINCHes Claude to a new width and the reflow of the already-drawn box (plus
    // the replay of the retained, wrong-width scrollback into the resized grid) overprints
    // — the garbled header/announcement seen on session open. Matching the size up front
    // means Claude draws at the final width from byte one, so the fit is a no-op. Clamp to
    // sane bounds and fall back to the historical 100×30 when the frontend can't measure.
    let cols = cols.filter(|c| (20..=500).contains(c)).unwrap_or(100);
    let rows = rows.filter(|r| (5..=200).contains(r)).unwrap_or(30);
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let id = format!("t{}", mgr.next.fetch_add(1, Ordering::Relaxed));

    // Grid renderer: stand up the alacritty parser core NOW (matching the pty size)
    // so it parses and answers Claude's queries (background colour, device attributes)
    // from the very first byte — its OSC background query arrives before the pane mounts.
    if grid.unwrap_or(false) {
        let bg = term_bg.as_deref().and_then(parse_hex_rgb).unwrap_or((11, 13, 16));
        let fg = term_fg.as_deref().and_then(parse_hex_rgb).unwrap_or((230, 230, 230));
        gridterm::create(&id, cols as usize, rows as usize, bg, fg);
    }

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());

    // Reserve a unique localhost port for this session up front. The whole point
    // of Operator's port bookkeeping is that parallel sessions don't fight over
    // the same dev-server port — so we both hand the port to the dev tooling
    // (OPERATOR_DEV_PORT / PORT) and *tell the agent about it* (below).
    let dev_port = mgr.alloc_port(&id);
    // Ports other live sessions already hold, so we can warn this agent off them.
    let others: Vec<u16> = {
        let mut v: Vec<u16> = mgr
            .dev_ports()
            .into_iter()
            .filter(|(tid, _)| tid != &id)
            .map(|(_, p)| p)
            .collect();
        v.sort_unstable();
        v
    };

    // Pick Claude Code's TUI renderer for this session. 'default' = classic streaming
    // renderer (accumulates scrollback; its in-place status redraws can ghost/garble in
    // the DOM xterm). 'fullscreen' = alt-screen fixed viewport (absolute positioning, no
    // scrollback → structurally can't ghost) — historically blanked/garbled in the DOM
    // xterm (2026-06-23, xterm 6 + Unicode11), but a replay of the real fullscreen byte
    // stream renders clean on the current unicode-graphemes stack, so it's exposed as an
    // opt-in setting (default stays 'default' until confirmed in the live app). The inline
    // --settings override wins over the user's global ~/.claude/settings.json without
    // touching it, and only for sessions Operator spawns.
    let tui = match tui_mode.as_deref() {
        Some("fullscreen") => "fullscreen",
        _ => "default",
    };
    let mut prefix: Vec<String> = vec![
        "claude".to_string(),
        "--settings".to_string(),
        format!(r#"{{"tui":"{tui}"}}"#),
    ];
    // Inform the agent of its reserved port and the ports other live sessions
    // hold, so any dev server it starts avoids collisions. An appended system
    // prompt is the reliable channel: most dev servers (Vite, etc.) won't honour
    // a PORT env var on their own, and Claude won't read OPERATOR_DEV_PORT — but
    // it WILL follow an instruction to bind a specific port.
    if let Some(port) = dev_port {
        let taken = if others.is_empty() {
            "none".to_string()
        } else {
            others
                .iter()
                .map(|p| p.to_string())
                .collect::<Vec<_>>()
                .join(", ")
        };
        prefix.push("--append-system-prompt".to_string());
        prefix.push(format!(
            "Operator (this session's manager) reserves a localhost port per session to avoid \
             collisions between parallel agents. Your reserved dev-server port is {port}; start any \
             local/dev server on it (pass `--port {port}`, or read it from the PORT env var). Ports \
             already in use by other Operator sessions: {taken} — do NOT bind those. If you need \
             more than one port, pick free ones outside that set."
        ));
    }

    let inner = prefix
        .into_iter()
        .chain(args)
        .map(|a| shell_quote(&a))
        .collect::<Vec<_>>()
        .join(" ");
    let mut cmd = CommandBuilder::new(&shell);
    cmd.args(["-ilc", &inner]);
    cmd.cwd(&cwd);
    strip_nested_session_env(&mut cmd);
    cmd.env("OPERATOR_TERMINAL_ID", &id);
    // Hand the reserved port to the dev tooling too: OPERATOR_DEV_PORT (read by
    // this repo's vite/tauri config) and PORT (honoured by Next.js, CRA, many
    // Node servers) so frameworks that respect it bind correctly without the
    // agent doing anything.
    if let Some(port) = dev_port {
        cmd.env("OPERATOR_DEV_PORT", port.to_string());
        cmd.env("PORT", port.to_string());
    }
    cmd.env("FORCE_COLOR", "1");
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // Tell Claude Code the terminal's light/dark background. It can't OSC-query our
    // grid renderer, so without this it assumes dark and renders dark content onto a
    // light pane (the dark/white split). COLORFGBG "fg;bg" as palette indices —
    // bg 0 = dark terminal, 15 = light.
    if let Some(scheme) = color_scheme.as_deref() {
        cmd.env("COLORFGBG", if scheme == "light" { "0;15" } else { "15;0" });
    }
    // Claude Code gates its inline "prompt suggestions" (ghost-text you accept
    // with Tab/Enter) on recognising the host terminal via TERM_PROGRAM, which a
    // bare pty leaves unset. Identify as iTerm so the feature turns on; xterm.js
    // handles the common iTerm sequences, and we only ever paste image *paths*
    // (never the inline-image protocol), so impersonating it is safe here.
    cmd.env("TERM_PROGRAM", "iTerm.app");

    // DEFERRED LAUNCH (see PendingStart / terminal_start): open + wire the pty now, but
    // exec Claude LATER — once the pane has mounted, fitted, and resized this pty to the
    // real grid width. In classic mode Claude wraps its output (and its whole --resume
    // reprint) to the pty width at startup and never reflows it, so if the pty width ≠ the
    // grid width every line mis-wraps (the cascading-margin corruption). Launching after
    // the resize guarantees pty width == grid width from Claude's first byte. Reader/writer
    // attach immediately; the reader thread just blocks until the child produces output.
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let tx = spawn_writer(app.clone(), id.clone(), writer);
    lock(&mgr.ptys).insert(
        id.clone(),
        Pty { tx, master: pair.master, killer: None, cwd: cwd.clone() },
    );
    lock(&mgr.pending).insert(id.clone(), PendingStart { cmd, slave: pair.slave });

    // Fallback: if the frontend never calls terminal_start (older webview / a race), launch
    // anyway after a short grace so the session isn't left dark. Idempotent with the explicit
    // call — whichever fires first consumes `pending`.
    {
        let mgr_timer = mgr.inner().clone();
        let id_timer = id.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(3000));
            start_pending(&mgr_timer, &id_timer);
        });
    }

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
                    mgr_arc.push_history(&emit_id, &buf[..n]);
                    // Grid handshake: write alacritty's replies (colour/device/cursor) back.
                    let resp = gridterm::feed(&app, &emit_id, &buf[..n], n < buf.len());
                    if !resp.is_empty() {
                        if let Some(p) = lock(&mgr_arc.ptys).get(&emit_id) { let _ = p.tx.send(resp); }
                    }
                    use base64::Engine;
                    let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = app.emit("terminal:data", TerminalDataPayload { id: emit_id.clone(), data });
                }
            }
        }
        lock(&mgr_arc.ptys).remove(&emit_id);
        mgr_arc.release_port(&emit_id);
        mgr_arc.clear_history(&emit_id);
        gridterm::dispose(&emit_id);
        let _ = app.emit("terminal:exit", emit_id.clone());
    });

    Ok(id)
}

/// Launch a pending pty's command (Claude) if it hasn't started yet. Idempotent: no-op if
/// there's no pending entry for `id` (already launched, or unknown). Called by
/// `terminal_start` once the pane has fitted, and by the fallback timer.
fn start_pending(mgr: &Arc<PtyManager>, id: &str) {
    let Some(PendingStart { cmd, slave }) = lock(&mgr.pending).remove(id) else { return };
    match slave.spawn_command(cmd) {
        Ok(child) => {
            let killer = child.clone_killer();
            drop(slave);
            if let Some(p) = lock(&mgr.ptys).get_mut(id) {
                p.killer = Some(killer);
            }
            // `child` drops here; the process keeps running (killer holds the kill capability).
        }
        Err(e) => eprintln!("[operator] failed to launch deferred pty {id}: {e}"),
    }
}

/// Launch a deferred session at the pane's fitted size (see terminal_spawn's DEFERRED
/// LAUNCH note). Resizes the pty to cols×rows and execs in one step so there's no race
/// between the async resize and start invokes — Claude sees the final width from byte one.
/// Safe to call more than once (start is idempotent).
#[tauri::command]
fn terminal_start(id: String, cols: Option<u16>, rows: Option<u16>, mgr: State<Arc<PtyManager>>) {
    if let (Some(c), Some(r)) = (cols, rows) {
        if c > 0 && r > 0 {
            if let Some(p) = lock(&mgr.ptys).get(&id) {
                let _ = p.master.resize(PtySize { rows: r, cols: c, pixel_width: 0, pixel_height: 0 });
            }
        }
    }
    start_pending(mgr.inner(), &id);
}

/// Spawn a plain interactive login shell in `cwd` — a scratch terminal for pure
/// shell work, opened from the session toolbar, separate from the Claude session.
/// Reuses the same pty machinery + `terminal:data`/`terminal:exit` events (so the
/// frontend renders it with the usual TerminalPane and writes/resizes/kills it via
/// the existing `terminal_*` commands), but registers NO transcript track and
/// reserves NO dev port — it never appears in the session list or tray.
#[tauri::command]
fn shell_spawn(
    app: tauri::AppHandle,
    cwd: String,
    mgr: State<Arc<PtyManager>>,
) -> Result<String, String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows: 30, cols: 100, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let id = format!("sh{}", mgr.next.fetch_add(1, Ordering::Relaxed));
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());

    let mut cmd = CommandBuilder::new(&shell);
    cmd.args(["-il"]); // interactive login shell, no command — a plain prompt
    cmd.cwd(&cwd);
    strip_nested_session_env(&mut cmd);
    cmd.env("FORCE_COLOR", "1");
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "iTerm.app");

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let killer = child.clone_killer();
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let tx = spawn_writer(app.clone(), id.clone(), writer);
    lock(&mgr.ptys).insert(
        id.clone(),
        Pty { tx, master: pair.master, killer: Some(killer), cwd: cwd.clone() },
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
                    mgr_arc.push_history(&emit_id, &buf[..n]);
                    // Grid handshake: write alacritty's replies (colour/device/cursor) back.
                    let resp = gridterm::feed(&app, &emit_id, &buf[..n], n < buf.len());
                    if !resp.is_empty() {
                        if let Some(p) = lock(&mgr_arc.ptys).get(&emit_id) { let _ = p.tx.send(resp); }
                    }
                    use base64::Engine;
                    let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = app.emit("terminal:data", TerminalDataPayload { id: emit_id.clone(), data });
                }
            }
        }
        lock(&mgr_arc.ptys).remove(&emit_id);
        mgr_arc.clear_history(&emit_id);
        gridterm::dispose(&emit_id);
        let _ = app.emit("terminal:exit", emit_id.clone());
    });

    Ok(id)
}

#[tauri::command]
fn terminal_write(id: String, data: String, mgr: State<Arc<PtyManager>>) -> Result<(), String> {
    // Hold the lock only long enough to clone the channel handle — never across
    // the write itself (which happens on the writer thread).
    let tx = {
        let ptys = lock(&mgr.ptys);
        match ptys.get(&id) {
            Some(p) => p.tx.clone(),
            None => return Err("terminal not found".into()),
        }
    };
    tx.send(data.into_bytes()).map_err(|_| "terminal write channel closed".into())
}

#[tauri::command]
fn terminal_resize(id: String, cols: u16, rows: u16, mgr: State<Arc<PtyManager>>) {
    if let Some(p) = lock(&mgr.ptys).get(&id) {
        let _ = p.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
    }
}

// ---- grid terminal (our own, non-native — see gridterm.rs) ------------------

/// Parse "#rrggbb" (or "rrggbb") to an RGB triple for the grid terminal's colour replies.
fn parse_hex_rgb(s: &str) -> Option<(u8, u8, u8)> {
    let s = s.trim().trim_start_matches('#');
    if s.len() != 6 { return None }
    Some((
        u8::from_str_radix(&s[0..2], 16).ok()?,
        u8::from_str_radix(&s[2..4], 16).ok()?,
        u8::from_str_radix(&s[4..6], 16).ok()?,
    ))
}

#[tauri::command]
fn gridterm_set_theme(id: String, bg: String, fg: String) {
    let bg = parse_hex_rgb(&bg).unwrap_or((11, 13, 16));
    let fg = parse_hex_rgb(&fg).unwrap_or((230, 230, 230));
    gridterm::set_theme(&id, bg, fg);
}

#[tauri::command]
fn gridterm_attach(app: AppHandle, id: String, cols: usize, rows: usize, mgr: State<Arc<PtyManager>>) {
    // Size the pty to match so Claude Code lays out at the pane's real width, not the
    // 80×24 it was spawned with.
    if let Some(p) = lock(&mgr.ptys).get(&id) {
        let _ = p.master.resize(PtySize { rows: rows as u16, cols: cols as u16, pixel_width: 0, pixel_height: 0 });
    }
    gridterm::attach(&app, &id, cols, rows);
}

/// Resize both the pty and the alacritty grid so they stay in lockstep.
#[tauri::command]
fn gridterm_resize(app: AppHandle, id: String, cols: usize, rows: usize, mgr: State<Arc<PtyManager>>) {
    if let Some(p) = lock(&mgr.ptys).get(&id) {
        let _ = p.master.resize(PtySize { rows: rows as u16, cols: cols as u16, pixel_width: 0, pixel_height: 0 });
    }
    gridterm::resize_term(&app, &id, cols, rows);
}

#[tauri::command]
fn gridterm_scroll(app: AppHandle, id: String, delta: i32, mgr: State<Arc<PtyManager>>) {
    // In fullscreen apps this returns SGR mouse-wheel bytes to forward to the pty so
    // the app scrolls its own view; otherwise it scrolls the grid and returns nothing.
    let resp = gridterm::scroll(&app, &id, delta);
    if !resp.is_empty() {
        if let Some(p) = lock(&mgr.ptys).get(&id) { let _ = p.tx.send(resp); }
    }
}

#[tauri::command]
fn gridterm_detach(id: String) {
    gridterm::detach(&id);
}

#[tauri::command]
fn terminal_kill(id: String, mgr: State<Arc<PtyManager>>) {
    lock(&mgr.pending).remove(&id); // drop an un-launched command so nothing execs later
    if let Some(mut p) = lock(&mgr.ptys).remove(&id) {
        if let Some(k) = p.killer.as_mut() { let _ = k.kill(); }
    }
    mgr.release_port(&id);
    mgr.clear_history(&id);
}

/// Base64 of a terminal's retained output tail, for replaying scrollback when a
/// pane re-attaches to a pty that survived a renderer reload ("" if none).
#[tauri::command]
fn terminal_history(id: String, mgr: State<Arc<PtyManager>>) -> String {
    mgr.history_b64(&id)
}

#[derive(Serialize)]
struct TerminalInfo {
    id: String,
    cwd: String,
    dev_port: Option<u16>,
}

#[tauri::command]
fn terminal_list(mgr: State<Arc<PtyManager>>) -> Vec<TerminalInfo> {
    let ports = mgr.dev_ports();
    lock(&mgr.ptys).iter()
        .map(|(id, p)| TerminalInfo { id: id.clone(), cwd: p.cwd.clone(), dev_port: ports.get(id).copied() })
        .collect()
}

/// Every live session's allocated dev port (terminal id → port) — the registry
/// Operator uses so it's aware of every dev server it's handed out.
#[tauri::command]
fn get_dev_ports(mgr: State<Arc<PtyManager>>) -> HashMap<String, u16> {
    mgr.dev_ports()
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

fn chat_db_file() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    std::path::Path::new(&home).join(".operator").join("chat.db")
}

/// Read a cached dropped-image file and return it as a `data:` URL for an <img> in
/// the Chat panel. Scoped to `~/.operator/img-cache` so it can't read arbitrary files.
#[tauri::command]
fn image_data_url(path: String) -> Result<String, String> {
    use base64::Engine;
    let home = std::env::var("HOME").unwrap_or_default();
    let cache = std::path::Path::new(&home).join(".operator").join("img-cache");
    let p = std::path::Path::new(&path);
    // Canonicalize and confirm the resolved path stays inside the cache dir.
    let real = std::fs::canonicalize(p).map_err(|e| e.to_string())?;
    let cache_real = std::fs::canonicalize(&cache).map_err(|e| e.to_string())?;
    if !real.starts_with(&cache_real) {
        return Err("path outside image cache".into());
    }
    let bytes = std::fs::read(&real).map_err(|e| e.to_string())?;
    let media = match real.extension().and_then(|e| e.to_str()) {
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        _ => "image/jpeg",
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", media, b64))
}

/// Full durable chat history for a session (the reading-panel answers), from the
/// SQLite store. The panel loads this on open so it can show the WHOLE conversation
/// — not just the bounded tail the transcript tailer keeps in memory.
#[tauri::command]
fn chat_history(
    store: tauri::State<Arc<chatstore::ChatStore>>,
    id: String,
) -> Vec<backend::NarrationEntry> {
    store.load(&id)
}

/// Delete pasted-image temp files older than 3 days. Nothing else ever cleans
/// $TMPDIR/operator-pastes and macOS's tmp reaper is unreliable, so dragged
/// screenshots (100s of KB each) pile up indefinitely. The path is consumed the
/// moment the image is dropped (handed straight to the agent), so anything this old
/// is dead weight. Runs off-thread at launch; best-effort (ignores all errors).
fn prune_pasted_images() {
    let dir = std::env::temp_dir().join("operator-pastes");
    let cutoff = std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(3 * 24 * 60 * 60));
    let Some(cutoff) = cutoff else { return };
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    for entry in entries.flatten() {
        if let Ok(modified) = entry.metadata().and_then(|m| m.modified()) {
            if modified < cutoff {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/// Write a pasted image (base64) to a temp file and return its path, so the UI
/// can hand the agent a path reference instead of inlining raw bytes — the same
/// shape as a dropped file. Lives under $TMPDIR/operator-pastes.
#[tauri::command]
fn save_pasted_image(data: String, ext: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| e.to_string())?;
    let dir = std::env::temp_dir().join("operator-pastes");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let safe_ext = if !ext.is_empty() && ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        ext
    } else {
        "png".to_string()
    };
    let path = dir.join(format!("paste-{nanos}.{safe_ext}"));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
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

// --- Dock icon selector (macOS) ---------------------------------------------
// Swap the live dock/app icon between the light (cream) and dark variants. This
// only overrides the *running* app's icon (NSApplication's applicationIconImage),
// not the bundle's static .icns — so the frontend re-applies the saved choice on
// every launch. No-op off macOS.

#[cfg(target_os = "macos")]
fn apply_dock_icon(variant: &str) {
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;

    let bytes: &[u8] = match variant {
        "dark" => include_bytes!("../icons/dock-dark.png").as_slice(),
        _ => include_bytes!("../icons/dock-light.png").as_slice(),
    };
    let Some(mtm) = MainThreadMarker::new() else { return };
    let data = NSData::with_bytes(bytes);
    let image = NSImage::initWithData(NSImage::alloc(), &data);
    if let Some(image) = image {
        let nsapp = NSApplication::sharedApplication(mtm);
        unsafe { nsapp.setApplicationIconImage(Some(&image)) };
    }
}

/// Set the running app's dock icon to the `light` or `dark` variant. Hops to the
/// main thread (AppKit requires it).
#[tauri::command]
fn set_dock_icon(app: tauri::AppHandle, variant: String) {
    #[cfg(target_os = "macos")]
    {
        let _ = app.run_on_main_thread(move || apply_dock_icon(&variant));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, variant);
}

/// Called by the renderer once it has painted its first frame. The main window
/// launches hidden (tauri.conf.json → "visible": false) so the user never sees
/// it grow in from the corner mid-render; here we close the launch splash and
/// reveal the now-rendered main window.
#[tauri::command]
fn app_ready(app: tauri::AppHandle) {
    if let Some(splash) = app.get_webview_window("splashscreen") {
        let _ = splash.close();
    }
    if let Some(main) = app.get_webview_window("main") {
        // The window stayed truly hidden (config visible:false, plugin no longer
        // forcing VISIBLE) at its restored geometry, so this reveal is a clean show
        // at full size + saved position — no corner grow.
        let _ = main.show();
        let _ = main.set_focus();
    }
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
// --- Renderer stall watchdog -------------------------------------------------
// The WKWebView JS main thread can hang in a non-terminating loop (a ghostty
// resize/render hang, a runaway reconcile, …). NOTHING inside the webview can
// recover a hung JS thread — an injected `location.reload()` just queues behind the
// loop. But the native backend keeps running, so it detects the stall (missed
// heartbeats) and KILLS the pegged WebContent; WKWebView respawns it and reloads the
// app (the terminal replays retained scrollback — sessions are backend-owned). The
// renderer pings `renderer_heartbeat` ~1/s; when those stop AND a WebContent is truly
// pegged, we recover. This makes any main-thread freeze a ~few-second self-heal.

#[tauri::command]
fn renderer_heartbeat(hb: State<Arc<Mutex<Instant>>>) {
    *lock(&hb) = Instant::now();
}

/// Kill the highest-CPU `com.apple.WebKit.WebContent` process IF it's actually pegged
/// (our hung renderer). The >80% gate is critical: a napped/suspended webview also
/// stops heart-beating (paused timers) but sits IDLE — it must NOT be killed.
fn recover_hung_webview() -> bool {
    let out = match std::process::Command::new("ps")
        .args(["-Ao", "pid=,%cpu=,comm="])
        .output()
    {
        Ok(o) => o,
        Err(_) => return false,
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut best: Option<(i32, f32)> = None;
    for line in text.lines() {
        if !line.contains("WebContent") {
            continue;
        }
        let mut it = line.split_whitespace();
        let pid = it.next().and_then(|s| s.parse::<i32>().ok());
        let cpu = it.next().and_then(|s| s.parse::<f32>().ok());
        if let (Some(pid), Some(cpu)) = (pid, cpu) {
            if best.map_or(true, |(_, c)| cpu > c) {
                best = Some((pid, cpu));
            }
        }
    }
    match best {
        Some((pid, cpu)) if cpu > 80.0 => {
            eprintln!("[watchdog] renderer stalled — killing pegged WebContent {pid} ({cpu}%) to force a reload");
            let _ = std::process::Command::new("kill")
                .args(["-9", &pid.to_string()])
                .status();
            true
        }
        _ => false,
    }
}

/// Background watchdog: recovers the app if the renderer main thread hangs.
fn start_stall_watchdog(hb: Arc<Mutex<Instant>>) {
    std::thread::spawn(move || {
        let mut ever_alive = false;
        let mut last_recovery = Instant::now() - Duration::from_secs(60);
        loop {
            // Poll fast (heartbeat is 1/s) so a hang is caught in ~3s, not ~9s — a
            // 9s "recover" still reads as a freeze to the user.
            std::thread::sleep(Duration::from_millis(500));
            let elapsed = lock(&hb).elapsed();
            if elapsed < Duration::from_millis(1500) {
                ever_alive = true; // fresh heartbeats → renderer healthy
                continue;
            }
            if !ever_alive {
                continue; // renderer hasn't booted / heart-beat yet
            }
            if elapsed < Duration::from_secs(3) {
                continue; // brief stall — 3 missed pings before we act
            }
            if last_recovery.elapsed() < Duration::from_secs(12) {
                continue; // cooldown so a reload that re-hangs isn't thrashed
            }
            if recover_hung_webview() {
                last_recovery = Instant::now();
            }
        }
    });
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Persist + restore the window's size/position across launches. The
        // splash is transient (fixed size, centered, closed on ready) — keep it
        // out of the saved state so it never restores stale geometry.
        //
        // CRITICAL: exclude VISIBLE from the restored flags. The default flags
        // (StateFlags::all()) restore visibility, so the plugin re-SHOWS the main
        // window at startup (it was visible at last quit) — overriding the config's
        // `visible: false`. That made the window appear + grow from the desktop's
        // top-left corner BEFORE app_ready could reveal it centered. We restore only
        // geometry; visibility stays owned by the config + app_ready.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_denylist(&["splashscreen"])
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED
                        | tauri_plugin_window_state::StateFlags::FULLSCREEN,
                )
                .build(),
        )
        .manage(Arc::new(PtyManager::default()))
        .manage(Sessions::default())
        .manage(transcript::TrackRegistry::default())
        .manage(tray_anim::TrayState::default())
        .manage(Arc::new(chatstore::ChatStore::open(&chat_db_file())))
        // Last renderer heartbeat time; the stall watchdog reads it (see below).
        .manage(Arc::new(Mutex::new(Instant::now())))
        .setup(|app| {
            std::thread::spawn(prune_pasted_images);
            transcript::start_tailer(app.handle().clone());
            build_tray(app)?;
            tray_anim::start(app.handle().clone());
            // Auto-recover a hung renderer (see start_stall_watchdog).
            start_stall_watchdog(app.state::<Arc<Mutex<Instant>>>().inner().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            terminal_spawn,
            terminal_start,
            shell_spawn,
            terminal_write,
            terminal_resize,
            gridterm_attach,
            gridterm_resize,
            gridterm_scroll,
            gridterm_set_theme,
            gridterm_detach,
            terminal_kill,
            terminal_list,
            terminal_history,
            get_dev_ports,
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
            load_sessions,
            save_pasted_image,
            set_dock_icon,
            chat_history,
            image_data_url,
            renderer_heartbeat,
            app_ready
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quote_wraps_in_single_quotes() {
        assert_eq!(shell_quote("foo"), "'foo'");
        assert_eq!(shell_quote(""), "''");
        assert_eq!(shell_quote("/a/b c/d"), "'/a/b c/d'");
    }

    #[test]
    fn shell_quote_escapes_embedded_single_quotes() {
        // it's  ->  'it'\''s'
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
    }
}
