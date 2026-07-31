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
#[path = "planlimits.rs"]
mod planlimits;
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

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize, SlavePty};
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
    /// The pty child's pid (the login shell). Root of the process tree we walk to
    /// find which listening ports belong to THIS session — see `session_ports`.
    /// None until the deferred child execs, same as `killer`.
    pid: Option<u32>,
    /// The child itself, kept so the reader thread can ask whether a failed read
    /// actually means the session ended (`child_state` → `reader_action`). A killer
    /// can only end a process, not report on it. None until the deferred child execs.
    child: Option<Arc<Mutex<Box<dyn Child + Send + Sync>>>>,
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

/// The read that just came back from a pty master, classified.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReadOutcome {
    /// `Ok(n)`, n > 0 — output in hand.
    Bytes(usize),
    /// `Ok(0)` — nothing more to read from this side of the pty.
    Eof,
    /// `ErrorKind::Interrupted` — a signal landed mid-read. Not a failure at all.
    Interrupted,
    /// Any other `Err`.
    Failed,
}

/// What we know about a pty's child at this instant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChildState {
    /// `try_wait` says it is still running.
    Alive,
    /// `try_wait` returned an exit status — the session really is over.
    Exited,
    /// No child handle yet (deferred launch hasn't exec'd), or `try_wait` itself
    /// failed. Treated exactly like `Alive`: never end a session we cannot prove
    /// is over.
    Unknown,
}

/// What the reader thread should do with one read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReaderAction {
    /// Bytes are in hand — emit them.
    Deliver,
    /// The session is not over: read again.
    Retry,
    /// The child is confirmed gone — clean up, nothing left to kill.
    Teardown,
    /// The pty is unrecoverable but the child was NOT proven dead. Tear down AND kill it:
    /// we're about to stop reading its output forever, so leaving it running would orphan
    /// a live `claude` exactly the way the original bug did.
    KillAndTeardown,
}

/// How many consecutive fruitless reads (EOF or error) we tolerate while the child still
/// looks alive before giving up on the pty itself. Reaching this means the fd is broken in
/// a way that isn't recovering — a slave that closed while the child lingers, EBADF — and
/// without the cap the reader would spin for the life of the app while the lane could never
/// be cleaned up. Generous on purpose: a genuinely transient hiccup clears on the next read.
const MAX_TRANSIENT_READ_RETRIES: u32 = 100;
/// Backoff between those retries, so a tight EOF loop can't burn a core.
const READ_RETRY_BACKOFF: Duration = Duration::from_millis(50);

/// Classify a `read` result. Split out from the policy so both halves are testable.
fn classify_read(res: &std::io::Result<usize>) -> ReadOutcome {
    match res {
        Ok(0) => ReadOutcome::Eof,
        Ok(n) => ReadOutcome::Bytes(*n),
        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => ReadOutcome::Interrupted,
        Err(_) => ReadOutcome::Failed,
    }
}

/// The pty reader's teardown policy, as a pure function — the reader thread itself can't be
/// tested, but this can.
///
/// The bug it exists for: the loop used to `break` on `Ok(0) | Err(_)`, so ANY read error
/// was taken as the child dying. One transient hiccup removed the ptys entry and emitted
/// `terminal:exit`, the frontend marked the lane ended — while the real `claude` process was
/// still running, now orphaned with nothing reading its output. A read error is evidence
/// about the READ, not about the CHILD; only the child's own status ends a session.
fn reader_action(read: ReadOutcome, child: ChildState, consecutive_retries: u32) -> ReaderAction {
    match read {
        ReadOutcome::Bytes(_) => ReaderAction::Deliver,
        // POSIX says retry, and a signal says nothing about the child — so this never
        // counts toward the cap either.
        ReadOutcome::Interrupted => ReaderAction::Retry,
        ReadOutcome::Eof | ReadOutcome::Failed => match child {
            ChildState::Exited => ReaderAction::Teardown,
            ChildState::Alive | ChildState::Unknown => {
                if consecutive_retries >= MAX_TRANSIENT_READ_RETRIES {
                    ReaderAction::KillAndTeardown
                } else {
                    ReaderAction::Retry
                }
            }
        },
    }
}

/// Ask a pty's child whether it is still running. `Unknown` when there is no child yet or
/// when `try_wait` fails — see `ChildState`.
fn child_state(mgr: &Arc<PtyManager>, id: &str) -> ChildState {
    // Clone the handle out from under the ptys lock, then wait on it OUTSIDE that lock:
    // try_wait is a syscall, and the ptys map is taken by every other terminal command.
    let child = {
        let ptys = lock(&mgr.ptys);
        match ptys.get(id) {
            // No entry at all: `terminal_kill` removed it and already fired the killer, so
            // this session is over by definition. Reporting `Unknown` here would make the
            // reader retry for the whole backoff budget after an explicit close.
            None => return ChildState::Exited,
            Some(p) => p.child.clone(),
        }
    };
    // Entry present but no child yet — the deferred launch hasn't exec'd.
    let Some(child) = child else { return ChildState::Unknown };
    let status = lock(&child).try_wait();
    match status {
        Ok(Some(_)) => ChildState::Exited,
        Ok(None) => ChildState::Alive,
        Err(_) => ChildState::Unknown,
    }
}

/// Pump one pty's output to the frontend until its child is gone, then tear the session
/// down (drop the handle, free the port, emit `terminal:exit`). Shared by the agent-session
/// and scratch-shell spawn paths so the retry policy above can't drift between them.
fn pump_pty(
    app: tauri::AppHandle,
    mgr: Arc<PtyManager>,
    id: String,
    mut reader: Box<dyn Read + Send>,
) {
    let mut buf = [0u8; 8192];
    let mut retries: u32 = 0;
    loop {
        let res = reader.read(&mut buf);
        let outcome = classify_read(&res);
        // Only ask about the child when the read gave us nothing: the hot path (bytes in
        // hand) must not pay for a lock plus a waitpid per chunk. `reader_action` ignores
        // the child state for `Bytes` anyway.
        let child = match outcome {
            ReadOutcome::Bytes(_) => ChildState::Alive,
            _ => child_state(&mgr, &id),
        };
        match reader_action(outcome, child, retries) {
            ReaderAction::Teardown => break,
            ReaderAction::KillAndTeardown => {
                // Give up on the fd, but not before ending the process behind it: from
                // here nothing will ever read its output again.
                kill_and_reap(&mgr, &id);
                break;
            }
            ReaderAction::Retry => {
                if outcome != ReadOutcome::Interrupted {
                    retries += 1;
                    std::thread::sleep(READ_RETRY_BACKOFF);
                }
                continue;
            }
            ReaderAction::Deliver => {}
        }
        retries = 0;
        let ReadOutcome::Bytes(n) = outcome else { continue };
        mgr.note_activity(&id);
        mgr.push_history(&id, &buf[..n]);
        // Grid handshake: write alacritty's replies (colour/device/cursor) back.
        let resp = gridterm::feed(&app, &id, &buf[..n], n < buf.len());
        if !resp.is_empty() {
            if let Some(p) = lock(&mgr.ptys).get(&id) { let _ = p.tx.send(resp); }
        }
        use base64::Engine;
        let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
        let _ = app.emit("terminal:data", TerminalDataPayload { id: id.clone(), data });
    }
    // `remove` returning None means `terminal_kill` already tore this lane down (it removes
    // the entry, fires the killer, frees the port and clears history). Emitting
    // `terminal:exit` again would run the frontend's exit path a second time — and that path
    // completes the lane's running tasks, so a close would capture diffs and re-run check
    // commands twice. Clean up what's ours and stay quiet.
    let was_live = lock(&mgr.ptys).remove(&id).is_some();
    gridterm::dispose(&id);
    if !was_live { return }
    mgr.release_port(&id); // no-op for a scratch shell, which reserves none
    mgr.clear_history(&id);
    let _ = app.emit("terminal:exit", id.clone());
}

/// End a pty's child and reap it, without waiting on the caller's thread. Used when the
/// reader gives up on an unrecoverable fd: the process must not outlive the only thing
/// that was reading it.
fn kill_and_reap(mgr: &Arc<PtyManager>, id: &str) {
    let child = lock(&mgr.ptys).get(id).and_then(|p| p.child.clone());
    let Some(child) = child else { return };
    // Reaping happens on its own thread: `wait` blocks, and this runs on the reader thread
    // during teardown.
    std::thread::spawn(move || {
        let mut c = lock(&child);
        let _ = c.kill();
        let _ = c.wait();
    });
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
    /// parallel worktree agents never grab the same port. Keyed terminal id →
    /// (canonical cwd, port): the cwd is what makes SHARING possible — lanes in the
    /// same directory serve the same code and get the same port (see alloc_port).
    ports: Mutex<HashMap<String, (String, u16)>>,
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

/// Normalize a working directory into a port-sharing key, so `/a/b`, `/a/b/` and a
/// path through a symlink all agree on whether two lanes are "in the same place".
///
/// The dir may not exist yet at spawn time (a worktree not checked out). A plain
/// `canonicalize`-or-literal fallback would then split two lanes in the SAME dir: the
/// lane that spawns before the dir exists keys on the literal `/tmp/proj`, the one that
/// spawns after keys on the resolved `/private/tmp/proj` (macOS `/tmp` → `/private/tmp`),
/// they don't match, and each starts its own server — the exact redundancy this prevents.
/// So resolve the nearest EXISTING ancestor and re-append the missing tail, yielding the
/// same key both before and after the dir exists.
fn canonical_cwd(cwd: &str) -> String {
    if let Ok(p) = std::fs::canonicalize(cwd) {
        return p.to_string_lossy().into_owned();
    }
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = std::path::Path::new(cwd);
    loop {
        if let Ok(base) = std::fs::canonicalize(cur) {
            let mut resolved = base;
            for comp in tail.iter().rev() {
                resolved.push(comp);
            }
            return resolved.to_string_lossy().into_owned();
        }
        match (cur.file_name(), cur.parent()) {
            (Some(name), Some(parent)) => {
                tail.push(name.to_os_string());
                cur = parent;
            }
            // Reached the root with nothing resolvable — fall back to the trimmed literal.
            _ => return cwd.trim_end_matches('/').to_string(),
        }
    }
}

/// Parse `ps -Ao pid=,ppid=` into a parent → children map, then collect every
/// descendant of `root` (inclusive). A session's dev server is a grandchild at best
/// — zsh → claude → npm → vite — so a direct-children check would miss it.
///
/// Split out from `descendants` so the tree walk is testable without spawning `ps`.
fn descendants_from(ps_output: &str, root: u32) -> Vec<u32> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for line in ps_output.lines() {
        let mut it = line.split_whitespace();
        if let (Some(Ok(pid)), Some(Ok(ppid))) = (
            it.next().map(str::parse::<u32>),
            it.next().map(str::parse::<u32>),
        ) {
            children.entry(ppid).or_default().push(pid);
        }
    }
    // Breadth-first from the root. `seen` guards against a cycle in a malformed
    // table — a pid loop would otherwise hang the walk forever.
    let mut seen: std::collections::HashSet<u32> = std::collections::HashSet::new();
    let mut out = Vec::new();
    let mut queue = vec![root];
    while let Some(pid) = queue.pop() {
        if !seen.insert(pid) {
            continue;
        }
        out.push(pid);
        if let Some(kids) = children.get(&pid) {
            queue.extend(kids);
        }
    }
    out
}

/// Every pid in this process's tree, root included.
fn descendants(root: u32) -> Vec<u32> {
    let out = std::process::Command::new("ps")
        .args(["-Ao", "pid=,ppid="])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    descendants_from(&out, root)
}

/// Pull the listening TCP ports out of `lsof -F n` output (one `n<name>` field per
/// socket, e.g. `n*:5173`, `n127.0.0.1:3000`, `n[::1]:8080`). Deduped + sorted, so a
/// server listening on both loopback families reports one port, not two.
///
/// Split out from `listening_ports` so the parsing is testable without spawning `lsof`.
fn listening_ports_from(lsof_output: &str) -> Vec<u16> {
    let mut ports: Vec<u16> = lsof_output
        .lines()
        .filter_map(|l| l.strip_prefix('n'))
        // The port is whatever follows the LAST colon — `[::1]:5173` has several.
        .filter_map(|name| name.rsplit_once(':'))
        .filter_map(|(_, port)| port.parse::<u16>().ok())
        .collect();
    ports.sort_unstable();
    ports.dedup();
    ports
}

/// TCP ports these pids are LISTENING on. Empty when nothing is serving (or when
/// `lsof` is unavailable) — a best-effort signal, never an error path.
fn listening_ports(pids: &[u32]) -> Vec<u16> {
    if pids.is_empty() {
        return Vec::new();
    }
    let list = pids.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
    let out = std::process::Command::new("lsof")
        // -a ANDs the filters: these pids AND tcp AND listening. -nP skips DNS +
        // service-name lookups (both slow); -F n emits just the socket names.
        .args(["-nP", "-a", "-p", &list, "-iTCP", "-sTCP:LISTEN", "-F", "n"])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    listening_ports_from(&out)
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

    /// Reserve a localhost dev-server port for this session, keyed on its working
    /// directory.
    ///
    /// Sharing rule: **same cwd → same port; different cwd → different port.** A
    /// worktree lane has its own checkout, so it must have its own server — otherwise
    /// lanes would be reviewing each other's build, which is the whole reason the port
    /// bookkeeping exists. But lanes sharing the project root serve *identical* code,
    /// and giving each its own port just spawns redundant servers (and the second one
    /// usually loses the bind race anyway). Keying on cwd gives worktree isolation for
    /// free, since a worktree's path differs from the root's.
    ///
    /// Returns `(port, shared)` — `shared` meaning a sibling in the same directory
    /// already holds it, so a server may already be live there.
    ///
    /// On a fresh cwd, scans up from 1420, skipping ports held by another directory
    /// and any the OS reports busy right now (bind-test, dropped immediately — the dev
    /// server binds a moment later). Returns None if the whole range is exhausted.
    pub fn alloc_port(&self, id: &str, cwd: &str) -> Option<(u16, bool)> {
        let key = canonical_cwd(cwd);
        let mut ports = lock(&self.ports);
        // A live sibling in the same directory already has one — join it.
        if let Some((_, port)) = ports.values().find(|(c, _)| c == &key) {
            let port = *port;
            ports.insert(id.to_string(), (key, port));
            return Some((port, true));
        }
        let taken: std::collections::HashSet<u16> = ports.values().map(|(_, p)| *p).collect();
        for port in 1420u16..1520 {
            if taken.contains(&port) {
                continue;
            }
            if port_free(port) {
                ports.insert(id.to_string(), (key, port));
                return Some((port, false));
            }
        }
        None
    }

    /// Hand the port back when its session ends, so it can be reused.
    pub fn release_port(&self, id: &str) {
        lock(&self.ports).remove(id);
    }

    /// Snapshot of every live session's dev port (terminal id → port). Sessions
    /// sharing a directory report the same port.
    pub fn dev_ports(&self) -> HashMap<String, u16> {
        lock(&self.ports).iter().map(|(id, (_, p))| (id.clone(), *p)).collect()
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

// True when something already listens on the reserved port — i.e. a lane in this cwd has
// the project's dev server up. Probed at spawn time so the hint can say "use it" outright:
// prompt-only "check first" wording still lost races (simultaneously launched lanes each
// saw the port down and started a server, and Vite silently falls back to port+1 when the
// bind is taken — which is exactly how per-agent servers multiplied).
fn dev_port_is_live(port: u16) -> bool {
    use std::net::{Ipv6Addr, SocketAddr, TcpStream};
    use std::time::Duration;
    // BOTH loopbacks: Vite (via Node's localhost resolution) binds [::1] ONLY on this
    // machine, so a v4-only probe reads a live server as down — the "ALREADY LIVE" hint
    // never fires and a second server gets started on the v4 side of the same port.
    let addrs = [
        SocketAddr::from(([127, 0, 0, 1], port)),
        SocketAddr::from((Ipv6Addr::LOCALHOST, port)),
    ];
    addrs
        .iter()
        .any(|a| TcpStream::connect_timeout(a, Duration::from_millis(150)).is_ok())
}

// The appended-system-prompt note teaching an agent its dev-server port etiquette. Three
// cases: the port already serves (use it, never start another) · shared with live siblings
// but not serving yet · exclusively reserved. The not-live branches demand strict-port
// binding so a lost bind race surfaces as "use the winner's server", not a drifted port.
fn dev_port_note(port: u16, shared: bool, live: bool, others: &[u16]) -> String {
    let taken = if others.is_empty() {
        "none".to_string()
    } else {
        others
            .iter()
            .map(|p| p.to_string())
            .collect::<Vec<_>>()
            .join(", ")
    };
    let own = if live {
        format!(
            "The project's dev server is ALREADY LIVE on port {port} — it serves this same code, \
             so use it for previews and checks. Do NOT start another dev server and do NOT bind \
             that port yourself."
        )
    } else if shared {
        format!(
            "Your dev-server port is {port}, SHARED with the other Operator sessions working in \
             this same directory — you all serve identical code, so one server is enough. Check \
             whether it is already live (e.g. `curl -s -o /dev/null localhost:{port}`) BEFORE \
             starting anything: if it responds, just use it. Only if it is down should you start \
             the dev server yourself, on that port (pass `--port {port}`, or read it from the \
             PORT env var). Bind EXACTLY that port with strict-port semantics (e.g. Vite \
             `--strictPort`); if the bind fails because the port is taken, another session just \
             started the project's server — use theirs, never fall back to a different port."
        )
    } else {
        format!(
            "Your reserved dev-server port is {port}; start any local/dev server on it (pass \
             `--port {port}`, or read it from the PORT env var). Bind EXACTLY that port with \
             strict-port semantics (e.g. Vite `--strictPort`); if the bind fails because the \
             port is taken, a server for this project is already up — use it, never fall back \
             to a different port."
        )
    };
    format!(
        "Operator (this session's manager) reserves a localhost port per working directory to \
         avoid collisions between parallel agents. {own} Ports already in use by other Operator \
         sessions: {taken} — do NOT bind those. If you need more than one port, pick free ones \
         outside that set."
    )
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
    // Orchestration awareness note — appended to the system prompt so an agent knows its
    // role + its sibling lanes in the project (see the frontend roster).
    orchestration_note: Option<String>,
    // The project this session belongs to. The tailer stamps it on any OPERATOR-REPLY the
    // session posts, so the reply lands in the right project's channel. Passed in rather than
    // derived: project ids are the frontend's canonical-repo-root scheme, and a second
    // implementation here would be free to drift from it.
    project_id: Option<String>,
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
    // `shared` = a sibling lane in this same directory already holds this port, so a
    // dev server may already be serving this exact code (see alloc_port).
    let (dev_port, port_shared) = match mgr.alloc_port(&id, &cwd) {
        Some((p, shared)) => (Some(p), shared),
        None => (None, false),
    };
    // Ports other live sessions already hold, so we can warn this agent off them.
    // Our own port is excluded even when a sibling shares it — otherwise a shared
    // lane would be told to bind a port and avoid it in the same breath.
    let others: Vec<u16> = {
        let mut v: Vec<u16> = mgr
            .dev_ports()
            .into_iter()
            .filter(|(tid, p)| tid != &id && Some(*p) != dev_port)
            .map(|(_, p)| p)
            .collect();
        v.sort_unstable();
        v.dedup();
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
    // Collect all appended-system-prompt notes into ONE flag (Claude Code takes a single
    // --append-system-prompt reliably): the port-collision hint + the orchestration note.
    let mut sys_notes: Vec<String> = Vec::new();
    if let Some(port) = dev_port {
        sys_notes.push(dev_port_note(port, port_shared, dev_port_is_live(port), &others));
    }
    if let Some(note) = orchestration_note.filter(|s| !s.trim().is_empty()) {
        sys_notes.push(note);
    }
    if !sys_notes.is_empty() {
        prefix.push("--append-system-prompt".to_string());
        prefix.push(sys_notes.join("\n\n"));
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
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let tx = spawn_writer(app.clone(), id.clone(), writer);
    lock(&mgr.ptys).insert(
        id.clone(),
        // Deferred launch: pid + child arrive in `start_pending`.
        Pty { tx, master: pair.master, killer: None, pid: None, child: None, cwd: cwd.clone() },
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
        transcript::NewTrack {
            claude_session_id: session_id,
            cwd: cwd.clone(),
            permission_mode,
            project_id: project_id.unwrap_or_default(),
        },
    );

    let emit_id = id.clone();
    let mgr_arc = mgr.inner().clone();
    std::thread::spawn(move || pump_pty(app, mgr_arc, emit_id, reader));

    Ok(id)
}

/// Launch a pending pty's command (Claude) if it hasn't started yet. Idempotent: no-op if
/// there's no pending entry for `id` (already launched, or unknown). Called by
/// `terminal_start` once the pane has fitted, and by the fallback timer.
fn start_pending(mgr: &Arc<PtyManager>, id: &str) {
    let Some(PendingStart { cmd, slave }) = lock(&mgr.pending).remove(id) else { return };
    match slave.spawn_command(cmd) {
        Ok(mut child) => {
            drop(slave);
            let mut ptys = lock(&mgr.ptys);
            match ptys.get_mut(id) {
                Some(p) => {
                    p.killer = Some(child.clone_killer());
                    p.pid = child.process_id();
                    // Kept (not dropped as it used to be) so the reader thread can ask whether
                    // a failed read means this child actually died — see `reader_action`.
                    p.child = Some(Arc::new(Mutex::new(child)));
                }
                None => {
                    // RACE: `terminal_kill` ran between the `pending` take above and this
                    // exec — it removed the ptys entry and fired a killer that was still
                    // None, so nothing reached this process. It would be left running with
                    // no handle, no reader, and no way to ever kill it. End it here instead.
                    // Reaping goes on its own thread: `wait` blocks and this may be a
                    // command thread.
                    drop(ptys);
                    eprintln!("[operator] pty {id} was killed mid-launch; reaping the child");
                    std::thread::spawn(move || {
                        let _ = child.kill();
                        let _ = child.wait();
                    });
                }
            }
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
    let pid = child.process_id();
    drop(pair.slave);

    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let tx = spawn_writer(app.clone(), id.clone(), writer);
    lock(&mgr.ptys).insert(
        id.clone(),
        Pty {
            tx, master: pair.master, killer: Some(killer), pid,
            child: Some(Arc::new(Mutex::new(child))), cwd: cwd.clone(),
        },
    );

    let emit_id = id.clone();
    let mgr_arc = mgr.inner().clone();
    std::thread::spawn(move || pump_pty(app, mgr_arc, emit_id, reader));

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

/// Every TCP port this session is actually LISTENING on, discovered by walking its
/// pty's process tree (zsh → claude → npm → vite → …) rather than probing localhost.
///
/// Attribution is the whole point. Probing common dev ports from the renderer can't
/// tell whose server answered — a sibling lane (or an unrelated app) on :5173 would be
/// shown as this session's app. Walking the tree only ever reports servers this
/// session's own processes opened.
///
/// Best-effort: an empty vec means "nothing serving yet", never an error. A session
/// whose child hasn't exec'd (deferred launch) has no pid, so it reports nothing.
#[tauri::command]
fn session_ports(id: String, mgr: State<Arc<PtyManager>>) -> Vec<u16> {
    let Some(pid) = lock(&mgr.ptys).get(&id).and_then(|p| p.pid) else { return Vec::new() };
    listening_ports(&descendants(pid))
}

// --- Sessions command -------------------------------------------------------

#[tauri::command]
fn get_sessions(sessions: State<Sessions>) -> Vec<AgentSession> {
    sessions.get_active()
}

// --- Verification gate ------------------------------------------------------
// Run the project's configured check command (e.g. "npm test") in a lane's working
// dir when a task completes — "done" becomes "done and green". Async (spawn_blocking
// equivalent via std thread inside tauri's async runtime) with a hard timeout so a
// hung test suite can't wedge the app or leak the child.

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckResult {
    ok: bool,
    code: Option<i32>,
    /// Combined stdout+stderr tail (bounded — enough to see the failure).
    output: String,
}

#[tauri::command]
async fn run_check(cwd: String, command: String) -> CheckResult {
    tauri::async_runtime::spawn_blocking(move || {
        use std::process::{Command, Stdio};
        let child = Command::new("/bin/sh")
            .args(["-lc", &command])
            .current_dir(&cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();
        let mut child = match child {
            Ok(c) => c,
            Err(e) => return CheckResult { ok: false, code: None, output: format!("failed to start: {e}") },
        };
        // Drain pipes on their own threads — a chatty child would otherwise fill the
        // pipe buffer and block forever while we poll (classic piped-wait deadlock).
        let drain = |r: Option<Box<dyn std::io::Read + Send>>| {
            std::thread::spawn(move || {
                let mut buf = Vec::new();
                if let Some(mut r) = r {
                    let _ = r.read_to_end(&mut buf);
                }
                buf
            })
        };
        let so = drain(child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>));
        let se = drain(child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>));
        // Poll with a 10-minute cap; kill on timeout so nothing leaks.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(600);
        let status = loop {
            match child.try_wait() {
                Ok(Some(st)) => break st,
                Ok(None) => {
                    if std::time::Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        return CheckResult { ok: false, code: None, output: "check timed out after 10 minutes".into() };
                    }
                    std::thread::sleep(std::time::Duration::from_millis(250));
                }
                Err(e) => return CheckResult { ok: false, code: None, output: format!("wait failed: {e}") },
            }
        };
        let mut text = String::from_utf8_lossy(&so.join().unwrap_or_default()).to_string();
        text.push_str(&String::from_utf8_lossy(&se.join().unwrap_or_default()));
        // Keep the TAIL — failures print last.
        const CAP: usize = 4000;
        if text.len() > CAP {
            let cut = text.len() - CAP;
            let safe = (cut..text.len()).find(|i| text.is_char_boundary(*i)).unwrap_or(text.len());
            text = format!("…{}", &text[safe..]);
        }
        CheckResult { ok: status.success(), code: status.code(), output: text.trim().to_string() }
    })
    .await
    .unwrap_or(CheckResult { ok: false, code: None, output: "check task panicked".into() })
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
fn worktree_diff(path: String, base: Option<String>) -> worktree::WorktreeDiff {
    worktree::worktree_diff(&path, base.as_deref())
}

#[tauri::command]
fn branch_diff(source_root: String, branch: String, base_branch: String) -> worktree::WorktreeDiff {
    worktree::branch_diff(&source_root, &branch, &base_branch)
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

// --- Durable project store (~/.operator/projects.json) -----------------------
// Same crash-safe atomic-write pattern as sessions.json. A Project = a folder/repo (its
// canonical git root) that owns many sessions over time — see the frontend `Project` type.

fn projects_file() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    std::path::Path::new(&home).join(".operator").join("projects.json")
}

#[tauri::command]
fn save_projects(projects: serde_json::Value) {
    let path = projects_file();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(s) = serde_json::to_string_pretty(&projects) {
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, s).is_ok() {
            let _ = std::fs::rename(&tmp, &path); // atomic swap
        }
    }
}

#[tauri::command]
fn load_projects() -> serde_json::Value {
    std::fs::read_to_string(projects_file())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::Value::Array(vec![]))
}

// --- Global role defaults (~/.operator/role-defaults.json) -------------------
// The user-owned layer over the built-in `rolePresets()`: per-role-id model / effort /
// permission mode that EVERY project inherits. Same opaque-JSON, atomic tmp+rename contract as
// projects.json — the shape lives in the frontend (`GlobalRoleDefaults`), so there is no schema
// here to drift out of sync with it.
//
// A file rather than localStorage on purpose: the launch path reads it, and it has to survive a
// profile reset the same way a project does.

fn role_defaults_file() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    std::path::Path::new(&home).join(".operator").join("role-defaults.json")
}

#[tauri::command]
fn save_role_defaults(defaults: serde_json::Value) {
    let path = role_defaults_file();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(s) = serde_json::to_string_pretty(&defaults) {
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, s).is_ok() {
            let _ = std::fs::rename(&tmp, &path); // atomic swap
        }
    }
}

#[tauri::command]
fn load_role_defaults() -> serde_json::Value {
    std::fs::read_to_string(role_defaults_file())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        // An OBJECT, not an array: this is keyed by role id. An empty one means "inherit
        // everything", which is exactly the state before the user has configured anything.
        .unwrap_or_else(|| serde_json::Value::Object(serde_json::Map::new()))
}

/// Copy `projects.json` to `~/.operator/backups/projects-<stamp>.json` before a migration
/// rewrites rosters. Returns the backup path, or an error — the caller must treat a failed
/// backup as a reason NOT to write ("no backup, no delete", as in chatstore's purge).
#[tauri::command]
fn backup_projects(stamp: String) -> Result<String, String> {
    if !safe_segment(&stamp) {
        return Err("invalid stamp".into());
    }
    let src = projects_file();
    if !src.exists() {
        return Err("no projects.json to back up".into());
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let dir = std::path::Path::new(&home).join(".operator").join("backups");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(format!("projects-{stamp}.json"));
    std::fs::copy(&src, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

/// A single path segment is safe (no `/`, `..`, or exotic chars) so it can't escape its
/// parent dir. Used to validate project ids and moodboard filenames (traversal guard, same
/// containment spirit as image_data_url).
fn safe_segment(s: &str) -> bool {
    !s.is_empty()
        && !s.contains("..")
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Lazily create + return `~/.operator/projects/<id>/` — the per-project asset dir the
/// moodboard/context builds on. `id` is validated so it can't escape the projects dir.
#[tauri::command]
fn project_asset_dir(id: String) -> Result<String, String> {
    if !safe_segment(&id) {
        return Err("invalid project id".into());
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let dir = std::path::Path::new(&home).join(".operator").join("projects").join(&id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

// --- Moodboard (~/.operator/projects/<id>/moodboard/) ------------------------
// A project-scoped board of inspiration images the user drops in over time. Bytes are
// COPIED into the project (unlike the terminal image drop, which references a temp path),
// so the board survives independently of the source files.

fn moodboard_dir(id: &str) -> Result<std::path::PathBuf, String> {
    if !safe_segment(id) {
        return Err("invalid project id".into());
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let dir = std::path::Path::new(&home)
        .join(".operator").join("projects").join(id).join("moodboard");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Add an image (base64) to a project's moodboard; returns the stored filename.
#[tauri::command]
fn moodboard_add(id: String, data: String, ext: String) -> Result<String, String> {
    use base64::Engine;
    let dir = moodboard_dir(&id)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| e.to_string())?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let safe_ext = if !ext.is_empty() && ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        ext
    } else {
        "png".to_string()
    };
    // Nanos-prefixed name sorts chronologically (see moodboard_list).
    let name = format!("shot-{nanos}.{safe_ext}");
    std::fs::write(dir.join(&name), &bytes).map_err(|e| e.to_string())?;
    Ok(name)
}

/// List a project's moodboard image filenames, newest first.
#[tauri::command]
fn moodboard_list(id: String) -> Result<Vec<String>, String> {
    let dir = moodboard_dir(&id)?;
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|e| e.path().is_file())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| !n.starts_with('.'))
        .collect();
    names.sort(); // nanos-embedded names sort chronologically
    names.reverse(); // newest first
    Ok(names)
}

/// Data URL for one moodboard image (name validated; can't escape the board dir).
#[tauri::command]
fn moodboard_image(id: String, name: String) -> Result<String, String> {
    use base64::Engine;
    if !safe_segment(&name) {
        return Err("invalid image name".into());
    }
    let path = moodboard_dir(&id)?.join(&name);
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let media = match path.extension().and_then(|e| e.to_str()) {
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        _ => "image/jpeg",
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", media, b64))
}

/// Remove one moodboard image.
#[tauri::command]
fn moodboard_remove(id: String, name: String) -> Result<(), String> {
    if !safe_segment(&name) {
        return Err("invalid image name".into());
    }
    let path = moodboard_dir(&id)?.join(&name);
    std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    Ok(())
}

// --- Preview inspector (Stage 3, spike) -----------------------------------------------------
// A separate webview window loading the running app's URL, with an inspector script injected
// at document-start (Operator owns this webview, so unlike the cross-origin preview iframe the
// script CAN read the DOM). Slice 1: outline the element under the cursor on hover. Slices 2+
// add click-to-capture (selector + component@file:line) reported back over IPC, then embedding.
const INSPECTOR_JS: &str = r#"
(function () {
  if (window.__operatorInspector) return; window.__operatorInspector = true;
  var box, label;
  function mk() {
    box = document.createElement('div');
    box.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #7ee787;background:rgba(126,231,135,0.12);border-radius:2px;display:none;transition:all 45ms ease-out';
    label = document.createElement('div');
    label.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;font:600 11px ui-monospace,SFMono-Regular,Menlo,monospace;background:#0b0d10;color:#7ee787;padding:2px 6px;border-radius:4px;display:none;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.4)';
    document.documentElement.appendChild(box);
    document.documentElement.appendChild(label);
  }
  function name(el) {
    var s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    if (el.className && typeof el.className === 'string') {
      var c = el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (c.length) s += '.' + c.join('.');
    }
    return s;
  }
  function selector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    var parts = [];
    while (el && el.nodeType === 1 && parts.length < 5) {
      if (el.id) { parts.unshift('#' + CSS.escape(el.id)); break; }
      var t = el.tagName.toLowerCase(), sib = el, nth = 1;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === el.tagName) nth++;
      parts.unshift(t + ':nth-of-type(' + nth + ')');
      el = el.parentElement;
    }
    return parts.join(' > ');
  }
  function fiber(el) {
    for (var k in el) if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0) return el[k];
    return null;
  }
  function source(el) {
    var f = fiber(el), comp = null, src = null;
    while (f) {
      if (!src && f._debugSource) src = f._debugSource;
      if (!comp && typeof f.type === 'function') comp = f.type.displayName || f.type.name || null;
      if (src && comp) break;
      f = f._debugOwner || f.return;
    }
    return { component: comp, source: src ? (src.fileName + ':' + src.lineNumber) : null };
  }
  // Send the picked element + note back to Operator. A remote embedded webview can't route command
  // IPC (the ACL denies it) — but a request to our registered custom scheme is never ACL-gated. So
  // we beacon via an <img> to operatorpick://, URL-safe-base64-encoding the JSON payload.
  function b64(str) { return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function beacon(data, onOk, onFail) {
    try {
      var im = new Image();
      im.onload = onOk; im.onerror = onFail;
      im.src = 'operatorpick://ipc?d=' + b64(JSON.stringify(data)) + '&t=' + Date.now();
    } catch (e) { onFail(); }
  }
  // ---- Floating compose card next to the clicked element (annotate-style, not a bottom bar).
  var composing = false;
  function removeCompose() { var c = document.getElementById('__op_compose'); if (c) c.remove(); composing = false; }
  function showCompose(el) {
    removeCompose(); composing = true;
    box.style.display = 'none'; label.style.display = 'none';
    var s = source(el), r = el.getBoundingClientRect();
    var data = {
      selector: selector(el), tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
      component: s.component, source: s.source, route: location.pathname, message: '',
    };
    var card = document.createElement('div');
    card.id = '__op_compose';
    var W = 288;
    var left = Math.min(Math.max(8, r.left), window.innerWidth - W - 8);
    var top = r.bottom + 8; if (top > window.innerHeight - 130) top = Math.max(8, r.top - 130);
    card.style.cssText = 'position:fixed;left:' + left + 'px;top:' + top + 'px;width:' + W + 'px;z-index:2147483647;box-sizing:border-box;background:#0b0d10;border:1px solid #2a2a35;border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:8px;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,0.55)';
    var chip = document.createElement('div');
    chip.textContent = '⧉ ' + (data.component || data.tag) + (data.source ? ' @ ' + data.source.split('/').pop() : '');
    chip.title = data.source || data.selector;
    chip.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:600 11px ui-monospace,SFMono-Regular,Menlo,monospace;color:#7ee787';
    var inp = document.createElement('textarea');
    inp.placeholder = 'What should change about this element?';
    inp.rows = 2;
    inp.style.cssText = 'width:100%;box-sizing:border-box;resize:none;font:13px ui-sans-serif,system-ui;background:#15171c;color:#e6e6e6;border:1px solid #2a2a35;border-radius:6px;outline:none;padding:6px 8px';
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px';
    function mkBtn(txt, primary) {
      var b = document.createElement('button');
      b.textContent = txt;
      b.style.cssText = 'font:600 11px ui-sans-serif;border-radius:6px;padding:6px 10px;cursor:pointer;border:1px solid ' +
        (primary ? 'transparent;color:#0b0d10;background:#7ee787' : 'rgba(126,231,135,0.4);color:#7ee787;background:transparent');
      return b;
    }
    var toConsole = mkBtn('→ Console', false);
    var toTasks = mkBtn('→ Tasks', true);
    var spacer = document.createElement('span'); spacer.style.cssText = 'flex:1';
    var cancel = document.createElement('button');
    cancel.textContent = '✕';
    cancel.style.cssText = 'color:#8a8f98;background:transparent;border:none;cursor:pointer;font-size:15px;line-height:1;padding:2px 4px';
    function submit(target) {
      data.message = inp.value.trim(); data.target = target;
      toConsole.disabled = toTasks.disabled = true;
      beacon(data,
        function () { removeCompose(); },
        function () { chip.textContent = '✗ could not reach Operator'; chip.style.color = '#ff6b6b'; toConsole.disabled = toTasks.disabled = false; });
    }
    toConsole.onclick = function () { submit('console'); };
    toTasks.onclick = function () { submit('tasks'); };
    cancel.onclick = removeCompose;
    inp.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); submit('tasks'); }
      else if (ev.key === 'Escape') { ev.preventDefault(); removeCompose(); }
    });
    row.appendChild(toConsole); row.appendChild(toTasks); row.appendChild(spacer); row.appendChild(cancel);
    card.appendChild(chip); card.appendChild(inp); card.appendChild(row);
    document.documentElement.appendChild(card);
    inp.focus();
  }
  if (document.body) mk(); else document.addEventListener('DOMContentLoaded', mk);
  document.addEventListener('mousemove', function (e) {
    if (!box || composing) return;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === box || el === label) { box.style.display = 'none'; label.style.display = 'none'; return; }
    var r = el.getBoundingClientRect();
    box.style.display = 'block'; box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
    box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    label.textContent = name(el); label.style.borderColor = ''; label.style.color = '#7ee787';
    label.style.display = 'block'; label.style.left = r.left + 'px'; label.style.top = Math.max(0, r.top - 20) + 'px';
  }, true);
  // Click SELECTS the element (doesn't activate the app) and opens the in-window compose bar.
  document.addEventListener('click', function (e) {
    if (!box || composing) return;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === box || el === label) return;
    e.preventDefault(); e.stopPropagation();
    showCompose(el);
  }, true);
})();
"#;

/// Embed (or reposition) the inspector: a native child webview on the running app's URL, placed
/// OVER the preview panel at the frontend-measured rect (logical px, window-relative) so it reads
/// as inline. The injected inspector script reads the DOM (which a cross-origin iframe can't) and
/// beacons picks back over the `operatorpick://` scheme (a remote embedded webview can't route
/// command IPC, but a custom-scheme request is never ACL-gated).
#[tauri::command]
fn preview_inspect_open(app: AppHandle, url: String, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    use tauri::{LogicalPosition, LogicalSize};
    if let Some(wv) = app.get_webview("inspector") {
        let _ = wv.set_position(LogicalPosition::new(x, y));
        let _ = wv.set_size(LogicalSize::new(w, h));
        return Ok(());
    }
    let win = app.get_window("main").ok_or_else(|| "no main window".to_string())?;
    let parsed: tauri::Url = url.parse().map_err(|_| "invalid preview url".to_string())?;
    let builder = tauri::webview::WebviewBuilder::new("inspector", tauri::WebviewUrl::External(parsed))
        .initialization_script(INSPECTOR_JS);
    win.add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Reposition the embedded inspector as the preview panel resizes.
#[tauri::command]
fn preview_inspect_move(app: AppHandle, x: f64, y: f64, w: f64, h: f64) {
    use tauri::{LogicalPosition, LogicalSize};
    if let Some(wv) = app.get_webview("inspector") {
        let _ = wv.set_position(LogicalPosition::new(x, y));
        let _ = wv.set_size(LogicalSize::new(w, h));
    }
}

#[tauri::command]
fn preview_inspect_close(app: AppHandle) {
    if let Some(wv) = app.get_webview("inspector") {
        let _ = wv.close();
    }
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

/// Every OPERATOR-REPLY posted to a project, oldest first. Read-only, like `chat_history`:
/// replies are written by the tailer alone (a lane posts one by emitting the sentinel into
/// its own transcript), so there is deliberately no write command here.
#[tauri::command]
fn project_replies(
    store: tauri::State<Arc<chatstore::ChatStore>>,
    project_id: String,
) -> Vec<chatstore::ProjectReply> {
    store.replies(&project_id)
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

/// The plan's session/weekly percentages, via `claude -p "/usage"` (see planlimits.rs).
/// Cached with a 5-minute TTL and guarded to one process at a time; `force` skips the TTL.
#[tauri::command]
async fn plan_limits(force: Option<bool>) -> planlimits::PlanLimits {
    // On a blocking thread: it spawns a subprocess and waits on a network round-trip, and the
    // async runtime's workers must not be parked on that.
    tauri::async_runtime::spawn_blocking(move || planlimits::fetch(force))
        .await
        .unwrap_or_else(|e| planlimits::PlanLimits {
            note: Some(format!("Reading plan usage failed: {e}")),
            ..Default::default()
        })
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
fn folder_prefs_save_md(path: String, content: String) -> Result<(), String> {
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

/// Which dock variant to actually apply, given what was asked for and whether this is a dev build.
///
/// A DEV BUILD IS ALWAYS DARK, whatever the renderer asks. Two or more instances run at once here
/// and they share `~/.operator`, so telling a dev window from the installed release at a glance is
/// the difference between a screenshot meaning something and meaning nothing.
///
/// It has to be forced in Rust rather than in `App.tsx` for two reasons. The renderer's own
/// `setDockIcon` call would otherwise override it a moment later; and the renderer reads the
/// preference from `localStorage`, which is exactly what cannot work here — see the note on
/// per-origin storage in the RESULT. This is the single choke point both the startup hook and the
/// command go through, so nothing can route around it.
///
/// The `dev` flag is a parameter rather than a `cfg!` read inside, so BOTH branches are testable:
/// `cargo test` only ever runs in debug, and a release path that cannot be exercised is a release
/// path nobody has checked.
fn dock_variant<'a>(requested: &'a str, dev: bool) -> &'a str {
    if dev { "dark" } else { requested }
}

/// True when this binary was built for development. `cfg!(debug_assertions)` rather than
/// `tauri::is_dev()`: it is resolved at COMPILE time, so the release binary does not merely skip
/// the override — it does not contain it. `main.rs` already keys its windows_subsystem attribute
/// off the same flag, so this is the crate's existing idiom rather than a second notion of "dev".
const fn is_dev_build() -> bool {
    cfg!(debug_assertions)
}

#[cfg(target_os = "macos")]
fn apply_dock_icon(variant: &str) {
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;

    let bytes: &[u8] = match dock_variant(variant, is_dev_build()) {
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
        // Beacon channel for the embedded preview inspector: its injected script can't route
        // command IPC (a remote embedded webview is ACL-denied), so it sends a picked element +
        // note as `operatorpick://ipc?d=<url-safe-base64 JSON>`. Custom schemes bypass the ACL.
        .register_uri_scheme_protocol("operatorpick", |ctx, req| {
            use base64::Engine;
            let uri = req.uri().to_string();
            if let Some(q) = uri.split('?').nth(1) {
                for pair in q.split('&') {
                    if let Some(v) = pair.strip_prefix("d=") {
                        if let Ok(bytes) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(v) {
                            if let Ok(json) = String::from_utf8(bytes) {
                                let _ = ctx.app_handle().emit("preview:pick", json);
                            }
                        }
                    }
                }
            }
            // A 1×1 transparent GIF so the beacon <img> fires `onload` on success (→ the card gets
            // honest feedback; `onerror` means the request was blocked, e.g. by the page's CSP).
            const GIF_1PX: &[u8] = &[
                0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00,
                0x00, 0x00, 0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c,
                0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
            ];
            tauri::http::Response::builder()
                .status(200)
                .header("Access-Control-Allow-Origin", "*")
                .header("Content-Type", "image/gif")
                .header("Cache-Control", "no-store")
                .body(GIF_1PX.to_vec())
                .unwrap()
        })
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
            // A dev build claims its dark icon BEFORE the renderer paints, so it never flashes the
            // release icon on the way up. Release is deliberately untouched here: the renderer
            // applies the stored preference exactly as it always has, and adding a startup write
            // would be a second opinion about what a release icon should be.
            #[cfg(target_os = "macos")]
            if is_dev_build() {
                let _ = app.handle().run_on_main_thread(|| apply_dock_icon("dark"));
            }
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
            session_ports,
            get_sessions,
            inspect_repo,
            worktree_create,
            worktree_status,
            worktree_diff,
            branch_diff,
            run_check,
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
            save_projects,
            load_projects,
            save_role_defaults,
            load_role_defaults,
            plan_limits,
            backup_projects,
            project_asset_dir,
            moodboard_add,
            moodboard_list,
            moodboard_image,
            moodboard_remove,
            preview_inspect_open,
            preview_inspect_move,
            preview_inspect_close,
            save_pasted_image,
            set_dock_icon,
            chat_history,
            project_replies,
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

    // --- pty reader teardown policy (see reader_action) -------------------------------
    // The reader thread can't be tested (it owns a real pty), so the decision it makes on
    // every read lives in a pure function and is pinned here instead.

    #[test]
    fn classify_read_separates_eof_from_interruption_from_real_failure() {
        use std::io::{Error, ErrorKind};
        assert_eq!(classify_read(&Ok(0)), ReadOutcome::Eof);
        assert_eq!(classify_read(&Ok(64)), ReadOutcome::Bytes(64));
        assert_eq!(
            classify_read(&Err(Error::from(ErrorKind::Interrupted))),
            ReadOutcome::Interrupted,
        );
        assert_eq!(classify_read(&Err(Error::from(ErrorKind::Other))), ReadOutcome::Failed);
    }

    /// THE REGRESSION: a read error while the child is alive used to end the session,
    /// leaving the real `claude` orphaned. It must now keep reading.
    #[test]
    fn a_failed_read_never_ends_a_session_whose_child_is_still_alive() {
        assert_eq!(
            reader_action(ReadOutcome::Failed, ChildState::Alive, 0),
            ReaderAction::Retry,
        );
        assert_eq!(
            reader_action(ReadOutcome::Eof, ChildState::Alive, 0),
            ReaderAction::Retry,
        );
    }

    /// A child we can't ask about (deferred launch not exec'd yet, or try_wait itself
    /// failed) is treated as alive — we never end a session we can't prove is over.
    #[test]
    fn an_unknown_child_is_given_the_benefit_of_the_doubt() {
        assert_eq!(
            reader_action(ReadOutcome::Failed, ChildState::Unknown, 0),
            ReaderAction::Retry,
        );
        assert_eq!(
            reader_action(ReadOutcome::Eof, ChildState::Unknown, 0),
            ReaderAction::Retry,
        );
    }

    /// The only genuine end-of-session: nothing left to read AND the child has exited.
    #[test]
    fn a_confirmed_exit_tears_the_session_down() {
        assert_eq!(
            reader_action(ReadOutcome::Eof, ChildState::Exited, 0),
            ReaderAction::Teardown,
        );
        assert_eq!(
            reader_action(ReadOutcome::Failed, ChildState::Exited, 0),
            ReaderAction::Teardown,
        );
    }

    /// EINTR is a signal, not a death — retried whatever the child is doing, and it
    /// doesn't consume the transient budget (the caller skips the increment).
    #[test]
    fn an_interrupted_read_is_always_retried() {
        for child in [ChildState::Alive, ChildState::Unknown, ChildState::Exited] {
            assert_eq!(
                reader_action(ReadOutcome::Interrupted, child, MAX_TRANSIENT_READ_RETRIES + 5),
                ReaderAction::Retry,
                "EINTR must never end a session ({child:?})",
            );
        }
    }

    /// Bytes are delivered no matter what the child status says — output that arrived
    /// before the child exited still belongs on screen.
    #[test]
    fn bytes_are_always_delivered() {
        for child in [ChildState::Alive, ChildState::Exited, ChildState::Unknown] {
            assert_eq!(
                reader_action(ReadOutcome::Bytes(1), child, 0),
                ReaderAction::Deliver,
                "({child:?})",
            );
        }
    }

    /// The safety valve: a pty that keeps failing while its child lingers is eventually
    /// given up on, so a broken fd can't spin the reader for the life of the app. Because
    /// the child was never proven dead, that teardown must KILL it — walking away from a
    /// live `claude` nothing is reading is the very orphan this whole policy exists to stop.
    #[test]
    fn a_pty_that_never_recovers_is_torn_down_and_its_child_killed() {
        assert_eq!(
            reader_action(ReadOutcome::Failed, ChildState::Alive, MAX_TRANSIENT_READ_RETRIES - 1),
            ReaderAction::Retry,
            "still inside the budget",
        );
        for child in [ChildState::Alive, ChildState::Unknown] {
            assert_eq!(
                reader_action(ReadOutcome::Failed, child, MAX_TRANSIENT_READ_RETRIES),
                ReaderAction::KillAndTeardown,
                "a child that was never proven dead must not be left running ({child:?})",
            );
        }
    }

    /// A child that exited on its own needs no killing, however long the reader struggled.
    #[test]
    fn a_confirmed_exit_never_escalates_to_a_kill() {
        assert_eq!(
            reader_action(ReadOutcome::Eof, ChildState::Exited, MAX_TRANSIENT_READ_RETRIES + 10),
            ReaderAction::Teardown,
        );
    }

    /// `terminal_kill` removes the ptys entry and fires the killer. A reader that then asks
    /// about the child must hear "over" — reporting `Unknown` would keep it retrying for the
    /// entire backoff budget after an explicit close.
    #[test]
    fn a_removed_pty_entry_reads_as_a_dead_child() {
        let mgr = Arc::new(PtyManager::default());
        assert_eq!(child_state(&mgr, "no-such-terminal"), ChildState::Exited);
        assert_eq!(
            reader_action(ReadOutcome::Failed, child_state(&mgr, "no-such-terminal"), 0),
            ReaderAction::Teardown,
            "a killed lane stops reading at once, and needs no second kill",
        );
    }

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

    /// Lanes in the same directory serve identical code, so they get ONE port —
    /// the second lane joins the first rather than spawning a redundant server.
    #[test]
    fn alloc_port_shares_one_port_across_lanes_in_the_same_cwd() {
        let mgr = PtyManager::default();
        let (a, a_shared) = mgr.alloc_port("t0", "/tmp").expect("a port");
        let (b, b_shared) = mgr.alloc_port("t1", "/tmp").expect("a port");
        assert_eq!(a, b, "same cwd must share a port");
        assert!(!a_shared, "the first lane in a directory owns its port");
        assert!(b_shared, "the second lane is told the port is shared");
    }

    /// A worktree lane has its own checkout, so it must get its own server —
    /// this is what keeps lanes from reviewing each other's build.
    #[test]
    fn alloc_port_isolates_different_cwds() {
        let mgr = PtyManager::default();
        let (a, _) = mgr.alloc_port("t0", "/tmp").expect("a port");
        let (b, b_shared) = mgr.alloc_port("t1", "/usr").expect("a port");
        assert_ne!(a, b, "different cwds must not share a port");
        assert!(!b_shared);
    }

    /// Releasing one lane leaves the port held while a sibling still shares it,
    /// so a rejoining lane can't be handed a port that's still serving.
    #[test]
    fn releasing_one_sharer_keeps_the_port_held_for_the_rest() {
        let mgr = PtyManager::default();
        let (a, _) = mgr.alloc_port("t0", "/tmp").expect("a port");
        mgr.alloc_port("t1", "/tmp").expect("a port");
        mgr.release_port("t0");
        assert_eq!(mgr.dev_ports().get("t1"), Some(&a));
        let (c, c_shared) = mgr.alloc_port("t2", "/tmp").expect("a port");
        assert_eq!(c, a);
        assert!(c_shared);
    }

    /// Trailing slashes must not read as a different directory, or two lanes in
    /// the same place would each get a server.
    #[test]
    fn canonical_cwd_normalizes_trailing_slash() {
        assert_eq!(canonical_cwd("/tmp/"), canonical_cwd("/tmp"));
    }

    /// A port that already serves gets the "use it" note — the lane must not be told
    /// to start anything, or every lane launched after the first grows its own server.
    #[test]
    fn dev_port_note_already_live_forbids_starting_a_server() {
        let note = dev_port_note(1420, true, true, &[1425]);
        assert!(note.contains("ALREADY LIVE on port 1420"));
        assert!(note.contains("Do NOT start another dev server"));
        assert!(!note.contains("start the dev server yourself"), "must not instruct a start");
        assert!(note.contains("1425"), "still lists ports held by other sessions");
    }

    /// Not live yet: both the shared and exclusive wordings must demand strict-port
    /// binding, so a lost bind race means "use the winner's server" — Vite's silent
    /// fall-back to port+1 is how per-agent servers multiplied.
    #[test]
    fn dev_port_note_not_live_demands_strict_port() {
        let shared = dev_port_note(1420, true, false, &[]);
        assert!(shared.contains("SHARED"));
        assert!(shared.contains("--strictPort"));
        assert!(shared.contains("never fall back to a different port"));
        let owned = dev_port_note(1420, false, false, &[]);
        assert!(owned.contains("Your reserved dev-server port is 1420"));
        assert!(owned.contains("--strictPort"));
    }

    /// The probe itself: a bound listener reads as live, a freshly freed port as down.
    #[test]
    fn dev_port_is_live_detects_a_listener() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        assert!(dev_port_is_live(port));
        drop(listener);
        assert!(!dev_port_is_live(port));
    }

    /// The real-world shape on this machine: Vite listening on [::1] ONLY. A v4-only
    /// probe called this "down" and told the next lane to start a second server.
    #[test]
    fn dev_port_is_live_sees_an_ipv6_only_listener() {
        let listener = std::net::TcpListener::bind("[::1]:0").expect("bind v6");
        let port = listener.local_addr().expect("addr").port();
        assert!(dev_port_is_live(port));
        drop(listener);
        assert!(!dev_port_is_live(port));
    }

    /// A dir that doesn't exist yet (a worktree not checked out) must key the SAME whether
    /// reached via a symlinked ancestor (/tmp) or its resolved form (/private/tmp) — else the
    /// before-exists lane and the after-exists lane split into two servers. (macOS: /tmp is a
    /// symlink to /private/tmp; this is a mac-only target.)
    #[test]
    fn canonical_cwd_agrees_before_and_after_a_dir_exists() {
        let via_symlink = canonical_cwd("/tmp/operator-nonexistent-xyz/proj");
        let via_resolved = canonical_cwd("/private/tmp/operator-nonexistent-xyz/proj");
        assert_eq!(via_symlink, via_resolved);
        // And it resolved the ancestor rather than returning the raw literal.
        assert!(via_symlink.starts_with("/private/tmp/"), "got {via_symlink}");
    }

    /// The dev server is a grandchild (zsh → claude → npm → vite), so the walk has
    /// to go all the way down — not just the root's direct children.
    #[test]
    fn descendants_walks_the_whole_tree() {
        // 1 ─ 100(zsh) ─ 200(claude) ─ 300(npm) ─ 400(vite)
        //                            └ 301(tsc)
        let ps = "100 1\n200 100\n300 200\n301 200\n400 300\n999 1\n";
        let mut got = descendants_from(ps, 100);
        got.sort_unstable();
        assert_eq!(got, vec![100, 200, 300, 301, 400]);
    }

    /// An unrelated tree must never be attributed to this session — that's the whole
    /// reason we walk pids instead of probing localhost.
    #[test]
    fn descendants_excludes_unrelated_processes() {
        let ps = "100 1\n200 100\n500 1\n600 500\n";
        let got = descendants_from(ps, 100);
        assert!(!got.contains(&500) && !got.contains(&600));
    }

    /// A malformed ps table with a pid cycle must not hang the walk.
    #[test]
    fn descendants_survives_a_cycle() {
        let ps = "100 200\n200 100\n";
        let got = descendants_from(ps, 100);
        assert_eq!(got.len(), 2);
    }

    /// lsof reports one socket per address family; the picker should offer ONE port.
    #[test]
    fn listening_ports_dedupes_across_address_families() {
        let lsof = "p123\nn*:5173\nn127.0.0.1:5173\nn[::1]:5173\nn127.0.0.1:3000\n";
        assert_eq!(listening_ports_from(lsof), vec![3000, 5173]);
    }

    #[test]
    fn listening_ports_ignores_unparseable_names() {
        let lsof = "p123\nn*:*\nnsomething-odd\nn127.0.0.1:4321\n";
        assert_eq!(listening_ports_from(lsof), vec![4321]);
    }
}

#[cfg(test)]
mod dock_icon_tests {
    use super::*;

    #[test]
    fn a_dev_build_is_always_dark() {
        // Whatever the renderer asks for — including an explicit "light" from the Prefs control,
        // and including a value we don't recognise.
        for requested in ["light", "dark", "", "chartreuse"] {
            assert_eq!(dock_variant(requested, true), "dark", "requested {requested:?}");
        }
    }

    #[test]
    fn a_release_build_is_unchanged() {
        // The proof that this override is dev-only: with `dev = false` the request passes through
        // untouched, so the Prefs preference keeps working exactly as it did.
        assert_eq!(dock_variant("light", false), "light");
        assert_eq!(dock_variant("dark", false), "dark");
        // …including the fall-through that `apply_dock_icon`'s match treats as light.
        assert_eq!(dock_variant("", false), "");
        assert_eq!(dock_variant("chartreuse", false), "chartreuse");
    }

    #[test]
    fn the_dev_flag_follows_the_build_profile() {
        // `cargo test` compiles in debug, so this asserts the flag is wired to the profile at all
        // rather than hardcoded — the release value is covered by the pass-through test above.
        assert!(is_dev_build(), "a test binary is a debug build");
    }
}
