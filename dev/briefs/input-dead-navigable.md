# Brief — App navigable, ALL keyboard input dead

## Symptom (user, 2026-08-29)
The app froze and had to be restarted. User could still NAVIGATE the app
(clicks worked, UI painted) but "every input" was dead — not just the terminal
panes. Chat composer, palette, terminal: all refused text.

This rules out resource starvation (rendering would have stalled too) and rules
out a pty-write-path fault (that would be terminal-only). Mouse works, keyboard
does not = something is eating key events app-wide.

## Prime suspect: the quit guard
`src-tauri/src/quit.rs` + `src-tauri/src/lib.rs:2166`. Recent work, commit
`9711c9e "Ask before quitting while agents are still working"`.

Facts already established (do not re-derive):
- `lib.rs:2168` calls `.menu(quit::build_menu)`, and the comment at 2166 says
  calling `.menu(...)` at all makes Operator OWNER OF THE WHOLE MENU BAR, which
  the code itself notes "matters to copy/paste".
- `quit.rs` `ACK_MS = 400`: the webview gets 400ms to mount the dialog and ack,
  otherwise Rust falls back to a NATIVE ask. Comment says the fallback exists
  precisely for when the renderer is "navigated away, frozen, or mid-respawn".
- `QuitGuard.prompting: AtomicBool` — "A prompt is on screen. Cmd-Q pressed
  twice must not quit by repetition."
- `build_menu` removes the predefined Quit item and has several early-return
  paths that log and leave the menu stock.

## Mechanisms to prove or kill (ranked)
1. The NATIVE fallback dialog spawns off-screen, behind the window, or on a
   window that is hidden. A macOS app-modal dialog blocks key delivery app-wide
   while the webview keeps painting. Restart is the only exit — matches exactly.
2. `prompting` (or `acked`) latches true and is never cleared on a path that
   dismisses the dialog, leaving the app in a permanent "prompt is up" state.
3. The React quit dialog mounts as a transparent / zero-size focus-trapping
   overlay: it takes focus, swallows keydown, but passes clicks through.
4. Menu-bar ownership: `build_menu` takes an early return (its own eprintln
   paths) and ships a menu bar missing the Edit menu, breaking key equivalents.
   NOTE: this alone would break Cmd-C/V/A, NOT plain typing — so it is only a
   full explanation if paired with something else. Weigh it accordingly.
5. Tray menu: `build_tray` sets `show_menu_on_left_click(true)`. A tray menu
   stuck in macOS menu-tracking run-loop mode blocks key delivery.

## Known adjacent history (memory, may be the same root)
- The menu rebuild was MERGED WITHOUT GUI VERIFICATION — Cmd-C/Cmd-V/Cmd-A in a
  real window were never exercised after it.
- "Stuck selection highlight", seen once: select-all then deselect left an
  unclearable highlight. Cmd-A is a menu key equivalent; possibly related.
- The renderer is killed and respawned hourly at ~1.1-1.2GB. A respawn is
  exactly the window in which the 400ms ack fails and the native fallback fires.
  Consider whether an UNREQUESTED quit-guard prompt can fire during a respawn.

## Deliverable
Write `dev/results/input-dead-research.md`: for each mechanism, CONFIRMED /
RULED OUT / UNPROVEN with the file:line evidence that settles it, then the
single most likely root cause and the smallest fix that addresses it.
Read the source. Do not change code.
