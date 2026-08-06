// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // THE ARTIFACT-PLANE MCP SERVER, in the same binary as the app. A lane's Claude Code spawns
    // `operator --mcp-serve` over stdio (see `terminal_spawn`'s --mcp-config); it inserts a row
    // and exits with the client. One binary means nothing extra to sign, notarize or locate.
    //
    // Checked BEFORE Tauri starts: this process must never open a window, take the single-instance
    // lock, or touch the tray.
    if std::env::args().any(|a| a == "--mcp-serve") {
        operator_lib::mcp_serve();
        return;
    }
    operator_lib::run()
}
