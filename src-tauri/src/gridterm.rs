// Grid terminal — our own terminal, take 2 (the non-native path).
//
// The whole corruption class in the xterm-in-WKWebView terminal is xterm's grid
// state mis-tracking the cursor under heavy streaming. The fix here moves the GRID
// AUTHORITY out of the webview: pty bytes are parsed by `alacritty_terminal` (the
// same battle-tested VT engine the native build used — no GPU, pure Rust), and we
// emit a clean, themed cell snapshot the frontend paints as plain DOM. No escape
// sequences ever reach the webview, so there is no buffer to drift → the overprint /
// ghosting / vim-crash class is structurally impossible. No NSView, no transparent
// window, no `macOSPrivateApi` — the terminal stays the main window.
//
// Opt-in: a core exists for an id only after the frontend `attach`es it, so when the
// grid terminal is off this module is one atomic load per pty chunk.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use alacritty_terminal::event::{Event, EventListener, WindowSize};
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::{Color as AnsiColor, NamedColor, Processor, Rgb};

/// Number of LIVE cores (one per grid session, from spawn until the pty exits). The
/// pty reader hits `feed` for EVERY session on every chunk; this lets the common
/// (grid-off) path bail before taking the lock.
static CORES: AtomicUsize = AtomicUsize::new(0);

/// Default terminal colours, used for OSC color replies until the frontend sets the
/// session's real theme (see `set_theme`). Near-black on light grey.
const DEFAULT_BG: (u8, u8, u8) = (11, 13, 16);
const DEFAULT_FG: (u8, u8, u8) = (230, 230, 230);

fn grids() -> &'static Mutex<HashMap<String, Core>> {
    static G: OnceLock<Mutex<HashMap<String, Core>>> = OnceLock::new();
    G.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Grid sizing handed to alacritty's `Term::new` / `Term::resize`.
#[derive(Clone, Copy)]
struct Size {
    cols: usize,
    lines: usize,
}
impl Dimensions for Size {
    fn total_lines(&self) -> usize { self.lines }
    fn screen_lines(&self) -> usize { self.lines }
    fn columns(&self) -> usize { self.cols }
}

/// Collects the responses alacritty wants to send back to the pty (cursor/device
/// reports, colour-query replies, etc.) so we can write them — the terminal handshake.
#[derive(Clone)]
struct Collector {
    tx: Sender<Event>,
}
impl EventListener for Collector {
    fn send_event(&self, event: Event) { let _ = self.tx.send(event); }
}

/// One terminal's parse state + grid. Created at SPAWN (so it parses + answers
/// queries from the first byte) and kept until the pty exits.
struct Core {
    term: Term<Collector>,
    parser: Processor,
    events: Receiver<Event>,
    cols: usize,
    rows: usize,
    attached: bool,
    last_emit: Instant,
    /// The terminal background/foreground reported to colour queries (OSC 11/10), so
    /// Claude Code renders for the right light/dark scheme.
    bg: (u8, u8, u8),
    fg: (u8, u8, u8),
}

fn new_core(cols: usize, rows: usize, bg: (u8, u8, u8), fg: (u8, u8, u8)) -> Core {
    let (tx, events) = channel();
    Core {
        term: Term::new(Config::default(), &Size { cols, lines: rows }, Collector { tx }),
        parser: Processor::new(),
        events,
        cols,
        rows,
        attached: false,
        last_emit: Instant::now() - Duration::from_secs(1),
        bg,
        fg,
    }
}

/// Resolve a colour-query index to the RGB we report. Background/foreground use the
/// session's theme; anything else falls back to the foreground.
fn reply_color(core: &Core, index: usize) -> Rgb {
    let (r, g, b) = if index == NamedColor::Background as usize {
        core.bg
    } else if index == NamedColor::Foreground as usize {
        core.fg
    } else {
        core.fg
    };
    Rgb { r, g, b }
}

/// Drain alacritty's pending events into pty-response bytes (the handshake).
fn drain_responses(core: &Core) -> Vec<u8> {
    let mut out = Vec::new();
    while let Ok(ev) = core.events.try_recv() {
        match ev {
            Event::PtyWrite(s) => out.extend_from_slice(s.as_bytes()),
            Event::ColorRequest(index, format) => out.extend_from_slice(format(reply_color(core, index)).as_bytes()),
            Event::TextAreaSizeRequest(format) => {
                let ws = WindowSize {
                    num_lines: core.rows as u16,
                    num_cols: core.cols as u16,
                    cell_width: 8,
                    cell_height: 17,
                };
                out.extend_from_slice(format(ws).as_bytes());
            }
            _ => {}
        }
    }
    out
}

// ---- snapshot wire format ---------------------------------------------------

/// A cell colour: an ANSI palette index 0–15 (frontend maps it to the live theme),
/// a "#rrggbb" truecolor/256-cube value, or null (the position's theme default).
#[derive(Serialize, Clone, PartialEq)]
#[serde(untagged)]
enum Col {
    Idx(u8),
    Rgb(String),
}

fn is_zero(n: &u8) -> bool { *n == 0 }

/// A run of consecutive cells sharing fg/bg/attrs (run-length keeps payloads small).
#[derive(Serialize, Clone)]
struct Run {
    t: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    f: Option<Col>,
    #[serde(skip_serializing_if = "Option::is_none")]
    b: Option<Col>,
    #[serde(skip_serializing_if = "is_zero")]
    a: u8,
}

#[derive(Serialize, Clone)]
struct LineMsg {
    y: usize,
    runs: Vec<Run>,
}

#[derive(Serialize, Clone)]
struct Cursor {
    x: usize,
    y: i32,
    vis: bool,
}

#[derive(Serialize, Clone)]
struct Update {
    id: String,
    cols: usize,
    rows: usize,
    cursor: Cursor,
    lines: Vec<LineMsg>,
    /// How many lines we're scrolled back into history (0 = at the live bottom).
    offset: usize,
}

// Attr bitmask shared with the frontend.
const A_BOLD: u8 = 1;
const A_DIM: u8 = 2;
const A_ITALIC: u8 = 4;
const A_UNDER: u8 = 8;
const A_INV: u8 = 16;
const A_STRIKE: u8 = 32;

fn named_idx(n: NamedColor) -> Option<u8> {
    use NamedColor::*;
    Some(match n {
        Black => 0, Red => 1, Green => 2, Yellow => 3, Blue => 4, Magenta => 5, Cyan => 6, White => 7,
        BrightBlack => 8, BrightRed => 9, BrightGreen => 10, BrightYellow => 11, BrightBlue => 12,
        BrightMagenta => 13, BrightCyan => 14, BrightWhite => 15,
        DimBlack => 0, DimRed => 1, DimGreen => 2, DimYellow => 3, DimBlue => 4, DimMagenta => 5, DimCyan => 6, DimWhite => 7,
        // Foreground / Background / Cursor / Bright|DimForeground → position default.
        _ => return None,
    })
}

/// Standard xterm 256-colour cube for indices 16–255 (theme-independent).
fn cube256(i: u8) -> (u8, u8, u8) {
    let cube = |v: u8| -> u8 { if v == 0 { 0 } else { 55 + v * 40 } };
    match i {
        16..=231 => { let i = i - 16; (cube(i / 36), cube((i / 6) % 6), cube(i % 6)) }
        _ => { let v = 8 + (i.wrapping_sub(232)) * 10; (v, v, v) }
    }
}

fn enc(c: AnsiColor) -> Option<Col> {
    match c {
        AnsiColor::Spec(rgb) => Some(Col::Rgb(format!("#{:02x}{:02x}{:02x}", rgb.r, rgb.g, rgb.b))),
        AnsiColor::Named(n) => named_idx(n).map(Col::Idx),
        AnsiColor::Indexed(i) => {
            if i < 16 { Some(Col::Idx(i)) } else { let (r, g, b) = cube256(i); Some(Col::Rgb(format!("#{:02x}{:02x}{:02x}", r, g, b))) }
        }
    }
}

fn attr_bits(flags: Flags) -> u8 {
    let mut a = 0;
    if flags.intersects(Flags::BOLD | Flags::DIM_BOLD) { a |= A_BOLD }
    if flags.contains(Flags::DIM) { a |= A_DIM }
    if flags.contains(Flags::ITALIC) { a |= A_ITALIC }
    if flags.contains(Flags::UNDERLINE) { a |= A_UNDER }
    if flags.contains(Flags::INVERSE) { a |= A_INV }
    if flags.contains(Flags::STRIKEOUT) { a |= A_STRIKE }
    a
}

/// Build a snapshot of the currently DISPLAYED viewport (which respects scrollback:
/// `display_iter` yields the visible rows for the current `display_offset`, with
/// `point.line + offset` giving the 0..rows-1 screen row).
fn snapshot(core: &Core, id: &str) -> Update {
    let cols = core.cols;
    let rows = core.rows;
    let grid = core.term.grid();
    let off = grid.display_offset() as i32;

    // Bucket the displayed cells into rows (column order), then run-length each row.
    let mut rowcells: Vec<Vec<(Option<Col>, Option<Col>, u8, char)>> =
        (0..rows).map(|_| Vec::with_capacity(cols)).collect();
    for indexed in grid.display_iter() {
        let drow = indexed.point.line.0 + off;
        if drow < 0 || drow as usize >= rows { continue }
        let cell = indexed.cell;
        if cell.flags.contains(Flags::WIDE_CHAR_SPACER) { continue }
        let ch = if cell.flags.contains(Flags::HIDDEN) || cell.c == '\0' { ' ' } else { cell.c };
        rowcells[drow as usize].push((enc(cell.fg), enc(cell.bg), attr_bits(cell.flags), ch));
    }

    let mut lines = Vec::with_capacity(rows);
    for (y, cells) in rowcells.into_iter().enumerate() {
        let mut runs: Vec<Run> = Vec::new();
        let mut cur: Option<(Option<Col>, Option<Col>, u8, String)> = None;
        for (f, b, a, ch) in cells {
            match &mut cur {
                Some((cf, cb, ca, s)) if *cf == f && *cb == b && *ca == a => s.push(ch),
                _ => {
                    if let Some((cf, cb, ca, s)) = cur.take() { runs.push(Run { t: s, f: cf, b: cb, a: ca }) }
                    cur = Some((f, b, a, ch.to_string()));
                }
            }
        }
        if let Some((cf, cb, ca, s)) = cur.take() { runs.push(Run { t: s, f: cf, b: cb, a: ca }) }
        // Drop a trailing default-styled whitespace run (most of a blank line).
        if let Some(last) = runs.last() {
            if last.f.is_none() && last.b.is_none() && last.a == 0 && last.t.bytes().all(|c| c == b' ') {
                runs.pop();
            }
        }
        lines.push(LineMsg { y, runs });
    }

    // Cursor is in active-screen coords; hide it while scrolled back into history.
    let cpoint = grid.cursor.point;
    let cursor = Cursor {
        x: cpoint.column.0,
        y: cpoint.line.0,
        vis: off == 0 && core.term.mode().contains(TermMode::SHOW_CURSOR),
    };
    Update { id: id.to_string(), cols, rows, cursor, lines, offset: off as usize }
}

// ---- public API (called from lib.rs) ----------------------------------------

/// Create the core at spawn time so it parses + answers Claude's queries from the
/// first byte (the OSC background query arrives within milliseconds — before the
/// frontend pane mounts). No-op if it already exists.
pub fn create(id: &str, cols: usize, rows: usize, bg: (u8, u8, u8), fg: (u8, u8, u8)) {
    let mut map = grids().lock().unwrap();
    if !map.contains_key(id) {
        map.insert(id.to_string(), new_core(cols.max(1), rows.max(1), bg, fg));
        CORES.fetch_add(1, Ordering::Relaxed);
    }
}

/// Does this pty have a grid core? THE AUTHORITY ON WHICH RENDERER A SESSION USES.
///
/// The core is created at spawn and never afterwards, so its existence is the same fact as "this
/// session was launched in grid mode" — and it survives a renderer reload, which is exactly when
/// the frontend has to decide again which pane to mount. Reported through `terminal_list` so a
/// re-attached tab reads it off the pty rather than keeping a second copy of the answer that is
/// free to drift from this one.
pub fn has(id: &str) -> bool {
    if CORES.load(Ordering::Relaxed) == 0 { return false }
    grids().lock().unwrap().contains_key(id)
}

/// Feed a pty chunk. Returns the bytes to write BACK to the pty (the terminal
/// handshake — cursor/device reports, colour-query replies). No-op (one atomic load)
/// for non-grid sessions. `flush` (read drained the pty) emits even inside the
/// throttle window so the tail of a burst isn't left stale.
pub fn feed(app: &AppHandle, id: &str, bytes: &[u8], flush: bool) -> Vec<u8> {
    if CORES.load(Ordering::Relaxed) == 0 { return Vec::new() }
    let mut map = grids().lock().unwrap();
    let Some(core) = map.get_mut(id) else { return Vec::new() };
    core.parser.advance(&mut core.term, bytes);
    let responses = drain_responses(core);
    if core.attached && (flush || core.last_emit.elapsed() >= Duration::from_millis(16)) {
        core.last_emit = Instant::now();
        let update = snapshot(core, id);
        drop(map);
        let _ = app.emit("gridterm:update", update);
    }
    responses
}

/// Frontend pane mounted/activated: create-or-resize the core, mark attached, and
/// push a full frame immediately.
pub fn attach(app: &AppHandle, id: &str, cols: usize, rows: usize) {
    let cols = cols.max(1);
    let rows = rows.max(1);
    let mut map = grids().lock().unwrap();
    if !map.contains_key(id) {
        map.insert(id.to_string(), new_core(cols, rows, DEFAULT_BG, DEFAULT_FG));
        CORES.fetch_add(1, Ordering::Relaxed);
    }
    let core = map.get_mut(id).unwrap();
    if core.cols != cols || core.rows != rows {
        core.term.resize(Size { cols, lines: rows });
        core.cols = cols;
        core.rows = rows;
    }
    core.attached = true;
    let update = snapshot(core, id);
    drop(map);
    let _ = app.emit("gridterm:update", update);
}

/// Update the colours reported to Claude's colour queries (theme change while a
/// session is open).
pub fn set_theme(id: &str, bg: (u8, u8, u8), fg: (u8, u8, u8)) {
    let mut map = grids().lock().unwrap();
    if let Some(core) = map.get_mut(id) {
        core.bg = bg;
        core.fg = fg;
    }
}

/// Scroll. In fullscreen apps (mouse tracking on — e.g. Claude Code), forward the
/// wheel to the pty as SGR mouse-wheel events so the APP scrolls its own view, and
/// return those bytes. Otherwise scroll the grid's own scrollback and re-emit.
pub fn scroll(app: &AppHandle, id: &str, delta: i32) -> Vec<u8> {
    let mut map = grids().lock().unwrap();
    let Some(core) = map.get_mut(id) else { return Vec::new() };
    if !core.attached { return Vec::new() }
    if core.term.mode().intersects(TermMode::MOUSE_MODE) {
        // SGR wheel: button 64 = up, 65 = down. Position at the viewport centre.
        let (button, n) = if delta > 0 { (64, delta) } else { (65, -delta) };
        let n = n.min(8) as usize;
        let col = (core.cols / 2).max(1);
        let row = (core.rows / 2).max(1);
        let mut out = Vec::new();
        for _ in 0..n {
            out.extend_from_slice(format!("\x1b[<{button};{col};{row}M").as_bytes());
        }
        return out;
    }
    core.term.scroll_display(Scroll::Delta(delta));
    let update = snapshot(core, id);
    drop(map);
    let _ = app.emit("gridterm:update", update);
    Vec::new()
}

/// Resize the alacritty grid (the pty is resized separately by the caller) + emit.
pub fn resize_term(app: &AppHandle, id: &str, cols: usize, rows: usize) {
    let cols = cols.max(1);
    let rows = rows.max(1);
    let mut map = grids().lock().unwrap();
    let Some(core) = map.get_mut(id) else { return };
    if core.cols == cols && core.rows == rows { return }
    core.term.resize(Size { cols, lines: rows });
    core.cols = cols;
    core.rows = rows;
    let update = snapshot(core, id);
    drop(map);
    let _ = app.emit("gridterm:update", update);
}

/// Pane unmounted (just stop emitting snapshots). The core stays alive so it keeps
/// parsing + answering Claude's queries, and re-attach is clean.
pub fn detach(id: &str) {
    let mut map = grids().lock().unwrap();
    if let Some(core) = map.get_mut(id) {
        core.attached = false;
    }
}

/// Terminal exited — drop its core entirely.
pub fn dispose(id: &str) {
    let mut map = grids().lock().unwrap();
    if map.remove(id).is_some() {
        CORES.fetch_sub(1, Ordering::Relaxed);
    }
}
