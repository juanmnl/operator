# Refocus on app activation — 2026-09-26

Branch **`operator/refocus-on-activate`**, cut from `main` at `c2cc7f9`. Commit 81cdb57. Not merged. **No activation path was verified in the running app**: I cannot drive the GUI, and nothing was launched. Everything below is from reading the code, plus unit tests of the decision.

## Why focus did not land (from the code)

The only refocus was in `TerminalPane.tsx:280-286`: every mounted pane added a `window` 'focus' listener, plus `visibilitychange`, and called `term.focus()` when its `activeRef` was set. Four problems:

1. **Main never took part.**
   - `electron/src/main/index.ts` had no BrowserWindow 'focus' handler and never called `webContents.focus()`.
   - `app.on('activate')` only created a window when there was none; with the window open it did nothing.

   So the renderer's own `window` 'focus' was the only signal. On macOS, NSWindow activation does not always hand the page keyboard focus. The usual case is a Dock click on an app whose window is already open, which is a long-standing Electron behaviour. **Not verified here**, because I cannot reproduce it without the GUI.
2. **Focus inside the Preview's iframe never reaches the parent.** When focus is restored into an iframe, the top document gets no `window` 'focus' event, so the listener never ran. This is standard DOM focus behaviour, reasoned from the code, not observed.
3. **`active` is not "on screen".** The prop is `t.id === activeTerminalId && !t.ended && mainView === 'terminal'`. It does not check `contentMode`, so it stays true for the selected lane while the board, settings or a gallery is showing. On activation the hidden pane focused itself, which could take focus from the board's composer or a dialog. Nothing restored what the user had been typing in.
4. **Timing.** `term.focus()` ran synchronously inside the 'focus' event, before Chromium finishes restoring its own focused element. Ordering against that restore was not controlled.

`activeRef` itself was not stale: it is reassigned on every render.

## The fix

- **Main** (`electron/src/main/activation.ts`, wired in `index.ts`):
  - BrowserWindow 'focus' → `webContents.focus()`, then `broadcast('onWindowActivated')`.
  - app 'activate' with a window open → `win.focus()`, which fires 'focus'. This happens only if the window is visible. The window starts hidden and the renderer shows it when ready, and 'activate' also fires at launch; showing it here would flash an unfinished window.
- **Renderer, one app-level hook** (`src/renderer/lib/use-refocus-on-activate.ts`, mounted in DashboardView) replaces the per-pane listeners. It records `document.activeElement` on window `blur`. On window `focus`, on the document becoming visible, or on `onWindowActivated`, coalesced into one decision a frame later, it applies the rules below.
- **The rules** (`src/renderer/lib/refocus.ts`, pure):
  1. If a text field, a dialog, or an embedded page (the Preview iframe) has focus now: **keep** it.
  2. If one had focus when the window lost it and is still connected and visible: **restore** it.
  3. If a lane is on screen: focus **its terminal** (`getTerminal(id).focus()`). "On screen" means `contentMode === 'localTerminal'`, `mainView === 'terminal'`, the tab is live, and neither the activity timeline nor the diff review is laid over it.
  4. Else the view's **primary input**, `[data-primary-input]` and visible. Today that is the empty board's hero task composer.
  5. Else **nothing**.
- **`TerminalPane`** keeps focusing itself when it becomes the active pane (`applyPaneActivation`, unchanged); only the activation listeners are gone.

## Activation paths: what is verified, and how

| Path | Main | Renderer | Verified |
|---|---|---|---|
| Cmd-Tab back to Operator | BrowserWindow 'focus' → `webContents.focus()` → `onWindowActivated` | the renderer's own 'focus' and the IPC, coalesced | **code only** |
| Clicking the Dock icon with the window open | app 'activate' → `win.focus()` → 'focus' → as above | same | **code only**; that 'activate' fires then is Electron's documented behaviour |
| Clicking the window | BrowserWindow 'focus' → as above | same, and the click itself places focus where it lands (kept if it is a field) | **code only** |
| Focus left in the Preview iframe | as above | the iframe is `embedded`: kept, never taken | **code only** |
| A native dialog (folder picker, quit confirm) closing | BrowserWindow 'focus' → as above | a field focused before it opened is restored | **code only** |
| Coming back to a board or settings | as above | primary input if marked, else nothing; a hidden lane no longer takes focus | **code only** |

Unit-tested: the decision (`refocus.test.ts`, 12 tests covering element classification and every rule), and main's two handlers against a fake window (`activation.test.ts`, 4 tests: order, destroyed windows, and a hidden window left alone). The hook's DOM wiring is not unit-tested: jsdom has no layout, so the visibility check cannot be exercised there.

## Checks

- Root: `tsc --noEmit` exit 0; vitest 108 files, **1591 passed**.
- `electron`: typecheck exit 0; vitest 45 files, **790 passed**.

## To check in the app

For each path in the table, with a lane on screen, a board on screen, a settings field being typed in, and the Preview focused, switch away and back, then type. The keys should land in the lane, the board composer, the settings field, and the Preview page respectively.

## Not done

- Grid terminal panes (`GridTerminalPane`) are not in the terminal registry, so rule 3 does nothing for them. The Electron build never mounts them (`grid: false`).
- Only the empty board's composer is marked as a primary input. Other views have none, so rule 5 applies.
