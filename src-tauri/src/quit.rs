// The quit guardrail.
//
// Quitting Operator ends every lane's pty, and with it whatever turn each agent was in the
// middle of. Until now nothing asked: the red traffic-light button destroyed the window, the
// window store emptied, and the app exited — which is exactly how the 2026-08-14 accident ran
// (a stray image drop navigated the webview to a file:// URL, the user closed what no longer
// looked like Operator, and every lane went with it).
//
// WHAT THIS DOES AND DOES NOT CATCH. Three quit paths remain unguarded, by decision, and this
// module does not pretend otherwise:
//
//   Dock (right-click) → Quit   native `-[NSApplication terminate:]`; reaching it needs an
//                               unsafe `applicationShouldTerminate:` override on the shared
//                               NSApplicationDelegate, outside tao 0.35.3's public surface.
//   macOS logout / restart      same delegate method. A guard that vetoes a system shutdown is
//                               a bug, so this one is not merely unbuilt — it is refused.
//   Force Quit                  SIGKILL. Impossible by definition.
//
// The app menu's ⌘Q *is* caught, but only because `build_menu` below replaces the predefined
// Quit item: `PredefinedMenuItem::quit` binds the native `sel!(terminate:)` selector
// (muda-0.19.2/src/platform_impl/macos/mod.rs:994) and never reaches Tauri's MenuEvent or
// RunEvent at all. A custom item carrying the same ⌘Q accelerator routes through a normal
// MenuEvent instead. The tray's `MenuBuilder::quit()` was the same predefined item and is
// replaced the same way.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem, MenuItemKind};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::transcript::{LiveLane, LiveLanes};

/// App-menu item ids. Namespaced so they can never collide with the tray's own ids.
pub const MENU_QUIT: &str = "operator:quit";
pub const MENU_QUIT_NOW: &str = "operator:quit-now";
/// Tray menu item id — the tray listens on its own handler, see `build_tray`.
pub const TRAY_QUIT: &str = "quit";

/// How long the webview gets to mount the dialog and ack before we fall back to a native ask.
/// The fallback is not a nicety: it is the whole reason the count lives in Rust. When the
/// renderer is navigated away, frozen, or mid-respawn there is no React app to render anything.
const ACK_MS: u64 = 400;

/// The phases that mean "mid-turn". `waiting` is included deliberately: an agent blocked on YOU
/// is the precise lane you forgot about. A live-but-idle lane does not trigger the dialog — it
/// would then fire on nearly every quit, which is how a guard trains its own dismissal.
fn is_busy(phase: &str) -> bool {
    matches!(phase, "running" | "compacting" | "waiting")
}

pub struct QuitGuard {
    /// The user has answered "quit" (or bypassed): every hook becomes a pass-through.
    confirmed: AtomicBool,
    /// A prompt is on screen. ⌘Q pressed twice must not quit by repetition.
    prompting: AtomicBool,
    /// The webview acked that it mounted the dialog.
    acked: AtomicBool,
    /// Mirrors the "Ask before quitting with agents running" preference (default on). The
    /// preference itself lives in the renderer's localStorage with the app's other switches;
    /// the renderer mirrors it here on mount and on every toggle. If it never gets the chance,
    /// this stays ON — the direction a default should fail in.
    ask: AtomicBool,
    /// Incremented per prompt, so a late ack or a late native-dialog answer from a prompt the
    /// user already resolved cannot answer the next one.
    round: AtomicU64,
}

impl QuitGuard {
    /// The user has answered "quit" — the ExitRequested hook must let that exit through.
    pub fn is_confirmed(&self) -> bool {
        self.confirmed.load(Ordering::SeqCst)
    }
}

impl Default for QuitGuard {
    fn default() -> Self {
        QuitGuard {
            confirmed: AtomicBool::new(false),
            prompting: AtomicBool::new(false),
            acked: AtomicBool::new(false),
            ask: AtomicBool::new(true),
            round: AtomicU64::new(0),
        }
    }
}

/// What the dialog renders from. The frontend enriches each lane by `terminalId` (lane name,
/// accent, the chat-signal wording) and falls back to what is here for any it cannot match —
/// so there is no loading state and no store read, and a webview with a stale session list
/// still names the right lanes.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct QuitRequest {
    /// Busy lanes only, unordered — the frontend owns presentation order.
    lanes: Vec<LiveLane>,
    /// Live lanes that are NOT busy. They will be ended too, and are counted in one line.
    idle: usize,
}

fn raise_main(app: &AppHandle) {
    // Tray and menu-bar paths can fire while the window is hidden or minimised. Without this
    // the app looks wedged: an invisible dialog holding a quit nobody can see.
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Actually quit. Sets `confirmed` FIRST so the ExitRequested hook lets this one through.
fn finish_quit(app: &AppHandle) {
    app.state::<QuitGuard>().confirmed.store(true, Ordering::SeqCst);
    app.exit(0);
}

/// The veto stands and nothing else happens — a cancelled quit is a non-event (no toast).
fn end_prompt(app: &AppHandle) {
    app.state::<QuitGuard>().prompting.store(false, Ordering::SeqCst);
}

/// Every guarded quit path funnels here. `bypass` is ⌥⌘Q — the deliberate, per-quit escape
/// hatch, which is why it is a modifier and not a checkbox inside the dialog.
pub fn request_quit(app: &AppHandle, bypass: bool) {
    let guard = app.state::<QuitGuard>();
    if guard.confirmed.load(Ordering::SeqCst) {
        return; // already on the way out
    }
    if bypass || !guard.ask.load(Ordering::SeqCst) {
        finish_quit(app);
        return;
    }

    let lanes = app.state::<LiveLanes>().snapshot();
    let (busy, idle): (Vec<LiveLane>, Vec<LiveLane>) = lanes.into_iter().partition(|l| is_busy(&l.phase));
    if busy.is_empty() {
        finish_quit(app); // nothing in flight — asking would be a question with nothing behind it
        return;
    }

    // A repeat ⌘Q while the question is outstanding RE-ASKS; it never quits. Repetition
    // reaching the destructive answer is the whole thing this guard is against.
    //
    // Re-asking rather than ignoring matters because the renderer is killed and respawned on
    // its own schedule (the WebContent recycle). If that lands while the dialog is up, the
    // dialog goes with it and `prompting` would otherwise stay set forever — an app that can
    // no longer be quit at all. A second ⌘Q now brings the question back; ⌥⌘Q, which skips
    // this whole path, is the escape hatch if even that fails.
    guard.prompting.store(true, Ordering::SeqCst);
    let round = guard.round.fetch_add(1, Ordering::SeqCst) + 1;
    guard.acked.store(false, Ordering::SeqCst);

    raise_main(app);
    let payload = QuitRequest { lanes: busy.clone(), idle: idle.len() };
    let _ = app.emit("quit:requested", &payload);

    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(ACK_MS));
        let guard = app.state::<QuitGuard>();
        let stale = guard.round.load(Ordering::SeqCst) != round;
        if stale || guard.acked.load(Ordering::SeqCst) || !guard.prompting.load(Ordering::SeqCst) {
            return; // the webview showed the real dialog, or the question is already answered
        }
        native_fallback(&app, &busy, round);
    });
}

/// The backstop dialog, for when there is no React app to render the real one.
///
/// Known and accepted degradation: `tauri-plugin-dialog` cannot choose which button is
/// default, so Return lands on OK — `Stay open`, which is correct — while Esc maps to Cancel
/// and quits. Mashing Return is the panic reflex and it lands safe. The buttons are NOT
/// inverted to "fix" Esc: that would put the destructive verb on Return, which is worse.
fn native_fallback(app: &AppHandle, busy: &[LiveLane], round: u64) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

    let n = busy.len();
    let (message, quit_verb) = if n == 1 {
        (
            "1 agent is still running. Quitting ends it. Its worktree and transcript stay on disk.".to_string(),
            "Quit and end it",
        )
    } else {
        (
            format!("{n} agents are still running. Quitting ends all of them. Their worktrees and transcripts stay on disk."),
            "Quit and end them",
        )
    };
    let stay = app
        .dialog()
        .message(message)
        .title("Quit Operator?")
        .buttons(MessageDialogButtons::OkCancelCustom("Stay open".into(), quit_verb.into()))
        .blocking_show();

    let guard = app.state::<QuitGuard>();
    if guard.round.load(Ordering::SeqCst) != round || !guard.prompting.load(Ordering::SeqCst) {
        return; // the webview woke up and answered while this was open
    }
    if stay {
        end_prompt(app);
    } else {
        finish_quit(app);
    }
}

// --- commands ---------------------------------------------------------------------------

/// The dialog mounted. Cancels the native fallback.
#[tauri::command]
pub fn quit_dialog_shown(guard: State<QuitGuard>) {
    guard.acked.store(true, Ordering::SeqCst);
}

/// The user answered. `quit: false` = Stay open.
#[tauri::command]
pub fn quit_decision(app: AppHandle, quit: bool) {
    if !app.state::<QuitGuard>().prompting.load(Ordering::SeqCst) {
        return; // nothing is being asked — ignore a stray answer
    }
    if quit {
        finish_quit(&app);
    } else {
        end_prompt(&app);
    }
}

/// Mirror of the renderer's preference. See `QuitGuard::ask`.
#[tauri::command]
pub fn quit_set_ask(guard: State<QuitGuard>, ask: bool) {
    guard.ask.store(ask, Ordering::SeqCst);
}

// --- menu -------------------------------------------------------------------------------

/// The app menu, with ONLY the Quit item replaced.
///
/// This starts from `Menu::default` and edits it, rather than composing a menu by hand, and
/// that is load-bearing: Tauri installs the default menu *only* while `Builder::menu` is never
/// called (tauri-2.11.2/src/app.rs:2236-2241), so calling it makes us the owner of the whole
/// menu bar — including the Edit submenu, which is what supplies Copy/Paste/Select All/Undo to
/// the webview on macOS. A hand-rolled menu that forgets it takes paste out of the composer,
/// which would be a worse regression than the one being fixed.
///
/// If the default's shape ever changes under us, we keep the stock menu and log it: ⌘Q goes
/// back to being unguarded, which is today's behaviour, rather than shipping a mangled menu.
pub fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;

    // macOS app submenu, per tauri-2.11.2/src/menu/menu.rs:190-204:
    // [about, ---, services, ---, hide, hide_others, ---, quit] — quit last, 8 items.
    const APP_MENU_LEN: usize = 8;

    let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() else {
        eprintln!("[quit] default menu has no app submenu — leaving it stock, ⌘Q unguarded");
        return Ok(menu);
    };
    let items = app_menu.items()?;
    if items.len() != APP_MENU_LEN || !matches!(items.last(), Some(MenuItemKind::Predefined(_))) {
        eprintln!("[quit] app submenu is not the expected shape — leaving it stock, ⌘Q unguarded");
        return Ok(menu);
    }
    if let Err(e) = app_menu.remove_at(APP_MENU_LEN - 1) {
        eprintln!("[quit] could not remove the predefined Quit item ({e}) — leaving it stock, ⌘Q unguarded");
        return Ok(menu);
    }
    // NOTHING below returns Err. Past this point the stock Quit item is already gone, and a
    // `?` here would abort `Builder::build` — trading a missing Quit item for no menu bar at
    // all, which is to say no Copy/Paste either. Worst case we log and ship a Quit-less app
    // menu; ⌘Q then does nothing rather than quitting unguarded.
    //
    // The second item is the per-quit escape hatch, spelled out so it is learnable rather than
    // folklore. muda 0.19.2 has no alternate-item support (no `alternate` anywhere in the
    // crate), so it is a plain visible row rather than the ⌥-held reveal the design asked for.
    for (id, text, accel) in [
        (MENU_QUIT, "Quit Operator", "CmdOrCtrl+Q"),
        (MENU_QUIT_NOW, "Quit Without Asking", "Alt+CmdOrCtrl+Q"),
    ] {
        match MenuItem::with_id(app, id, text, true, Some(accel)) {
            Ok(item) => {
                if let Err(e) = app_menu.append(&item) {
                    eprintln!("[quit] could not append {id} to the app menu: {e}");
                }
            }
            Err(e) => eprintln!("[quit] could not build the {id} menu item: {e}"),
        }
    }
    Ok(menu)
}

/// Route the two app-menu items. Anything else is left to whoever else is listening.
pub fn on_menu_event(app: &AppHandle, id: &str) {
    match id {
        MENU_QUIT => request_quit(app, false),
        MENU_QUIT_NOW => request_quit(app, true),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The one decision in this module that is pure, and the one the design turns on:
    /// `waiting` is busy, `idle` is not.
    #[test]
    fn busy_means_mid_turn_or_blocked_on_you_but_never_idle() {
        assert!(is_busy("running"));
        assert!(is_busy("compacting"));
        assert!(is_busy("waiting"));
        assert!(!is_busy("idle"));
        assert!(!is_busy(""));
    }

    #[test]
    fn the_guard_starts_armed() {
        let g = QuitGuard::default();
        assert!(g.ask.load(Ordering::SeqCst), "asking must be the default, not opt-in");
        assert!(!g.confirmed.load(Ordering::SeqCst));
        assert!(!g.prompting.load(Ordering::SeqCst));
    }
}
