# Input-dead-but-navigable — mechanism research

Brief file `dev/briefs/input-dead-navigable.md` does not exist in this worktree (known
cross-worktree brief invisibility issue — see `feedback_briefs_invisible_across_worktrees` in
project memory). Proceeded from the dispatch's own description: reproduce the "fully
navigable, input dead" state via the quit guard's native fallback dialog / stuck `prompting`
flag / menu ownership at `lib.rs:2166`. Read-only — no code changed. Verified against pinned
dependency source (`tauri-plugin-dialog 2.7.1`, `rfd 0.16.0` in `src-tauri/Cargo.lock`), not
against a live repro.

## CONFIRMED — unparented native fallback dialog never restores key-window focus

`quit.rs:191-196` (`native_fallback`) builds the backstop dialog with no `.parent(...)`:

```rust
app.dialog().message(message).title("Quit Operator?")
   .buttons(MessageDialogButtons::OkCancelCustom(...))
   .blocking_show();
```

Traced the full call chain from there:

1. `blocking_show()` → `blocking_fn!(self, show)` (tauri-plugin-dialog `lib.rs:357-358`) → the
   non-blocking `show()` (`lib.rs:323`) → `show_message_dialog()` (`desktop.rs:214-252`), which
   hops to the main thread only to construct `AsyncMessageDialog::from(dialog).show()`, then
   spawns **another** thread to `block_on` it. The dialog builder's `parent` field
   (`lib.rs:224`, `MessageDialogBuilder::new`, `lib.rs:253`) defaults to `None` and is only set
   by an explicit `.parent(&window)` call — never made here.
2. rfd's `AsyncMessageDialogImpl::show_async` (`rfd-0.16.0/src/backend/macos/message_dialog.rs:172-183`):
   ```rust
   fn show_async(self) -> DialogFutureType<MessageDialogResult> {
       if self.parent.is_none() {
           utils::async_pop_dialog(self)          // <- our path
       } else {
           Box::pin(ModalFuture::new(..., Alert::new, ...))   // NSAlert sheet, not taken
       }
   }
   ```
   Because there is no parent, rfd does **not** build an `NSAlert` sheeted to Operator's main
   window. It falls through to the legacy path.
3. `async_pop_dialog` (`utils/user_alert.rs:177-196`) spawns yet another background thread and
   calls `UserAlert::new(opt.clone(), None).run()` — `mtm: None` because this runs off the main
   thread. `UserAlert::run()` (line 80-107) shows the panel via the deprecated
   `CFUserNotificationDisplayAlert` API — a `SystemUIServer`-hosted floating panel, not a normal
   `NSWindow` sheet, and not tied into Operator's window list at all. `timeout: 0.0` (line 60,
   hardcoded) means **no auto-dismiss** — it blocks until answered, forever if unanswered.
4. The smoking gun: `UserAlert::new` only builds a `FocusManager` when `mtm` is `Some`
   (`_focus_manager: mtm.map(FocusManager::new)`, `user_alert.rs:76`). Our call path passes
   `None`, so **no `FocusManager` is ever constructed**. `FocusManager::drop`
   (`utils/focus_manager.rs:18-24`) is the only code in this whole chain that calls
   `win.makeKeyAndOrderFront(None)` to hand keyboard focus back to whatever window held it
   before the alert opened. Skipping it means: once this panel is dismissed (or even while it's
   still up but off-screen — see below), nothing ever tells any Operator window to become key
   again.

Net effect, and why it matches "fully navigable but input-dead" exactly: mouse/click routing to
a `NSWindow`'s content view does not require that window to be key, so the webview keeps
receiving clicks, hovers, and scroll — the app looks alive and clickable. Keyboard events
(`keyDown:`) are only delivered to the **key** window, and nothing in this call path ever makes
Operator's window key again. The app is stuck exactly as described: clickable, unable to type.

This is also the second-order explanation for why the panel can go unnoticed in the first
place: `CFUserNotificationDisplayAlert` is not a normal app window — it does not follow the
frontmost app's window level the way an `NSAlert` sheet would, and legacy behavior on modern
macOS is known to place it on the primary display's ordinary desktop Space rather than inside a
native-fullscreen Space or ahead of a window on a secondary display. A user running Operator
fullscreen, or on a second monitor, can have this alert open and answered-or-not entirely
outside their view while it (or its aftermath) still owns keyboard focus.

**Confidence:** CONFIRMED as a real, source-verified defect in the call chain — every hop was
read in the pinned dependency versions actually vendored in `Cargo.lock`
(`tauri-plugin-dialog-2.7.1`, `rfd-0.16.0`), not inferred from docs or a newer version. NOT
independently reproduced live in this pass (read-only brief; no code run).

**Trigger condition** for the fallback to even fire: the React `QuitGuard` must fail to ack
within `ACK_MS` = 400ms (`quit.rs:44,163-166`). That happens whenever a `⌘Q`/tray-quit/red-dot
close lands while the renderer is down or busy — most plausibly during the known hourly
WebContent recycle (`project_chat_markdown_freeze.md` in project memory: "the renderer is
KILLED AND RESPAWNED hourly at ~1.1–1.2GB"), or during the stall-watchdog's own recovery kill
(`lib.rs:2038-2074`, `recover_hung_webview`). Either event leaves no React app mounted to render
the real dialog for that 400ms window, guaranteeing `native_fallback` runs.

**Smallest fix:** pass the main window as the dialog's parent in `native_fallback`:

```rust
if let Some(main) = app.get_webview_window("main") {
    /* .parent(&main) */
}
```

With a parent set, rfd takes the `Alert::new(...).run()` branch (`message_dialog.rs:88-101`),
which is a real `beginSheetModalForWindow_completionHandler` sheet on Operator's own window and
builds its `FocusManager` with `Some(mtm)` (since that whole branch already requires
`MainThreadMarker`, `message_dialog.rs:159-165` `run_on_main`) — restoring key-window focus on
close, and keeping the panel physically anchored to Operator's window (visible in fullscreen,
on the correct Space/display, not a floating system panel). This is a one-line change to
`quit.rs:191-196`, no other file touched.

## CONFIRMED (as a downstream consequence, not an independent trigger) — `prompting` stuck true

`prompting` (`quit.rs:57,150`) only clears via `end_prompt` (Stay open) or is moot once
`confirmed` is set (Quit). If the invisible/off-screen native fallback from above is never
answered — plausible given `timeout: 0.0` means it never auto-dismisses on its own — the
`blocking_show()` call inside `native_fallback` never returns, so `prompting` stays `true`
indefinitely, and the background thread that's parked inside it never comes back.

Worse: `request_quit`'s repeat-⌘Q path (`quit.rs:142-149`) is explicit that a second ⌘Q
"RE-ASKS; it never quits" — it bumps `round`, re-emits `quit:requested`, and starts a *new*
400ms-then-fallback thread. Nothing in that path checks whether a previous native fallback
thread is still parked waiting on an answer; it only checks staleness of its **own** round. So
each repeated ⌘Q while the first invisible panel is still up spawns another
`CFUserNotificationDisplayAlert` call on another background thread — compounding invisible,
focus-eating panels rather than recovering. This matches a user story of "I pressed ⌘Q several
times and it got worse, not better."

**Confidence:** CONFIRMED as a real consequence of the above, from the same source reading — not
an independent root cause. Fixing the parent (above) removes the invisible/unanswerable case
entirely (a window-sheeted alert can't go unanswered off-screen), which removes this compounding
failure mode too. No separate fix needed for `prompting` itself.

## RULED OUT — `lib.rs:2166` menu ownership (`build_menu` / Edit submenu loss)

`build_menu` (`quit.rs:249-291`, called from `lib.rs:2168`) replaces only the app menu's
predefined Quit item, and is deliberately defensive: if the default menu's shape doesn't match
what it expects (`APP_MENU_LEN` check, `quit.rs:261-264`, or a failed `remove_at`,
`quit.rs:265-268`), it logs and returns the **stock** menu untouched rather than risk breaking
Copy/Paste/Select All (the comment at `quit.rs:238-248` documents exactly this risk and the
reason `Builder::menu` ownership matters). So:

- The failure mode this guards against (a mangled Edit submenu losing Copy/Paste) is explicitly
  designed to fail safe to the stock menu, not to a broken one.
- Even in a hypothetical broken-menu case, losing Edit-submenu items would only disable the
  **menu-driven** ⌘C/⌘V affordance (and Services-menu integration); it would not stop raw
  `keyDown`/`insertText:` delivery to a focused text field or the webview's own responder chain,
  which is independent of what's registered in the app's menu bar. It could not produce "fully
  navigable but cannot type at all."
- There is also no ownership *collision*: the tray's `.on_menu_event` (`lib.rs:2005`, on
  `TrayIconBuilder`) and the app menu's `.on_menu_event` (`lib.rs:2169`, on the outer
  `tauri::Builder`) are two different builders' handlers, not competing registrations on the
  same object — confirmed by reading both call sites; no override happens.

**Confidence:** RULED OUT as a cause of this symptom, from direct source reading of `quit.rs`
and the two `on_menu_event` registrations in `lib.rs`.

## Scope check — no other native-dialog call site exists

`grep -rn "blocking_show\|NSAlert\|CFUserNotification\|makeKeyWindow\|runModal"` across
`src-tauri/src/*.rs` turns up exactly one hit: `quit.rs`. This is the only place in the Rust
backend that can steal OS-level keyboard focus this way, so the investigation did not need to
widen past the quit guard.

## Recommendation

Smallest fix, one call site: give `native_fallback`'s dialog builder `.parent(&main_window)`
(falling back to today's unparented behavior only if `get_webview_window("main")` returns
`None`, which per `raise_main` at `quit.rs:102-110` should already be the very unlikely case).
This forces rfd onto the `NSAlert`-sheet branch, which both restores focus on close
(`FocusManager` with `Some(mtm)`) and keeps the dialog visibly anchored to Operator's own
window instead of a legacy system panel that can end up on the wrong Space or display. No
other file needs to change.

---

## Addendum 2026-08-29 — does the same mechanism exist in Electron?

The user runs Electron 0.18.1, not this Tauri build (retiring shell). Re-ran the trace against
`electron/src/main/quit.ts:88` (`QuitGuard.nativeAsk`), which also calls
`dialog.showMessageBox({...})` with no `BrowserWindow` argument. Verified against Electron's own
native source (`electron/electron` @ `v43.4.1` — the pinned version in `electron/package-lock.json`
— `shell/browser/ui/message_box_mac.mm`, fetched and read directly).

**The rfd/`CFUserNotificationDisplayAlert` mechanism above does NOT transfer.** Electron's
`ShowMessageBox` branches purely on whether a parent window is present, and both branches are
first-class Cocoa APIs, not the legacy CF panel:

```cpp
void ShowMessageBox(const MessageBoxSettings& settings, MessageBoxCallback callback) {
  NSAlert* alert = CreateNSAlert(settings);
  if (!settings.parent_window) {
    int ret = [alert runModal];                              // <- no-parent branch: OUR path
    std::move(callback).Run(ret, ...);
  } else {
    ...
    [alert beginSheetModalForWindow:window completionHandler:handler];   // <- parented branch
  }
}
```

- **Parented** (`beginSheetModalForWindow:completionHandler:`): a real window-modal sheet,
  visually attached to that `NSWindow`'s own view hierarchy (works correctly under native
  fullscreen, can't wander to another Space), blocks only that window, and its completion
  handler is dispatched via `content::GetUIThreadTaskRunner({})->PostTask(...)` — non-blocking
  to the UI thread, and standard AppKit sheet teardown hands key status back to the parent
  automatically. No `FocusManager`-equivalent step exists to skip, because none is needed here.
- **Unparented** (our current code, both `nativeAsk` call sites): `[alert runModal]` is called
  **directly inline, synchronously, on the UI thread** — confirmed from the source, no
  `dispatch_async`/`PostTask`/background-thread wrapper around it. This is a genuine app-modal
  Cocoa session on the SAME thread that drives Operator's window painting and all IPC. Per
  standard AppKit modal-session semantics this actually **freezes interaction with the rest of
  Operator's own UI**, not merely the keyboard — a more totalizing failure than the Tauri one,
  not a matching "clicks fine, keys dead" split.

**Why the *reported* symptom ("fully navigable, input dead") can still line up:** Chromium's
renderer process is a separate OS process from Electron's main/browser process. While the main
process's one UI thread is wedged inside `runModal`, the renderer keeps compositing on its own
(GPU-process-driven scroll, hover/CSS states, anything already in flight) and can *look* alive
to a quick glance, while anything that needs an actual round trip into the main process — every
`ipcRenderer.invoke`, every keystroke destined for a pty write, the whole reason typing "does
nothing" — has nowhere to land, because the one thread that would service it is stuck answering
a dialog nobody can see. That reads exactly like "fully navigable but input-dead" from the
outside, even though the underlying mechanism (full app-modal freeze of the main process, not a
lost-focus keyboard-only gap) is different from the Tauri bug above.

**The concrete, independently-confirmed defect, from reading `quit.ts` directly:** `nativeAsk`
never threads a window into `dialog.showMessageBox` at all — not even in the `install()` branch
that already fetched a live, non-destroyed `win` (`quit.ts:57,60-63`) before starting the ack
timer. `win` is captured in that closure and then simply never passed to `this.nativeAsk(lanes)`
(`quit.ts:38-44` — the method's signature only takes `lanes`). Every native fallback, in both
branches of `install()`, therefore takes the `runModal` app-modal path unconditionally, even when
a perfectly good window to sheet against was sitting right there. Nothing in `quit.ts` also calls
the Electron equivalent of Tauri's `raise_main()` (`win.show()`/`win.restore()`/`win.focus()`)
before presenting the fallback — so a hidden, minimized, or background-Spaced window at the
moment quit fires can leave this alert unsurfaced with the app's only UI thread wedged behind it.

**Confidence:** CONFIRMED mechanism divergence from Electron's own vendored source
(`message_box_mac.mm` at the exact pinned version) — the rfd-specific missing-`FocusManager`
explanation does not apply here. The `quit.ts` defect (never parenting a window it already has)
is CONFIRMED by direct code reading of `quit.ts` and `index.ts` (`getWindow: () => mainWindow`,
`index.ts:229`). Not reproduced live.

### The Electron fix — this is the one that ships

Thread the (raised) window through `nativeAsk`, mirroring what `raise_main` did in `quit.rs`,
and only fall back to the bare unparented call in the genuine no-window case:

```ts
private async nativeAsk(lanes: QuitLane[]): Promise<void> {
  this.decided = true
  const names = lanes.map((l) => `${l.project} (${l.phase})`).join(', ')

  const win = this.getWindow()
  const usable = win && !win.isDestroyed() ? win : undefined
  // Mirrors quit.rs's raise_main: a hidden/minimized window must surface before we block on
  // it, and passing it turns this into a window sheet instead of a UI-thread-freezing
  // app-modal runModal.
  if (usable) {
    if (usable.isMinimized()) usable.restore()
    usable.show()
    usable.focus()
  }

  const { response } = await dialog.showMessageBox(usable, {
    type: 'warning',
    buttons: ['Stay open', 'Quit anyway'],
    defaultId: 0,
    cancelId: 0,
    message: `${lanes.length} agent${lanes.length === 1 ? ' is' : 's are'} still working`,
    detail: `${names}\n\nQuitting ends their terminals.`,
  })
  if (response === 1) this.decide(true)
}
```

`dialog.showMessageBox(window, options)` is a documented Electron overload — passing `undefined`
when there truly is no window falls through to today's behavior unchanged. One file
(`electron/src/main/quit.ts`), no signature change needed elsewhere since `nativeAsk` is already
private and only called from within the class.
