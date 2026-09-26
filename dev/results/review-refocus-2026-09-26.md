# Review: `operator/refocus-on-activate` (81cdb57, result bfcc016), 2026-09-26

Adversarial review of `git diff c2cc7f9...operator/refocus-on-activate`. The branch adds:
- **Main:** `webContents.focus()` on `BrowserWindow` `focus`, and `win.focus()` on app `activate`
  (`electron/src/main/activation.ts`).
- **Renderer:** one hook that decides where focus goes (`src/renderer/lib/use-refocus-on-activate.ts`,
  with the rules in `src/renderer/lib/refocus.ts`).
- **Removed:** the per-pane `window` focus and `visibilitychange` listeners in `TerminalPane.tsx`.

Nothing in the main checkout was changed.

## Checks run

On a scratch `git archive` export of `bfcc016`, with the main checkout's `node_modules` symlinked in:

| Check | Result |
|---|---|
| Root `tsc --noEmit -p .` | exit 0 |
| electron typecheck | exit 0 |
| Electron suite | 45 files, 790 passed |
| Renderer suite | 101 files, 1475 passed |

Not run in the app. The findings below are from the code and from standard Chromium focus-event
behaviour, and 1 and 2 should be confirmed live.

## Findings, most severe first

### 1. High — after using the Preview, a click back into Operator is pulled back into the Preview iframe

- **Where:** `use-refocus-on-activate.ts:42` (`onBlur` records `document.activeElement`), `:69-70`
  (`window` `blur`/`focus` listeners), `:56` (`restore`); `refocus.ts:42` (an iframe is `embedded`, which
  counts as "typing"), `:73` (restore the remembered typing element).
- **What:** the parent window receives `blur` whenever focus moves **into** a child frame, and `focus`
  when it comes back to the parent document. That is how iframe focus works; it needs no app switch.
  1. Focus enters the Preview iframe (side panel or main view). The window `blur` fires, and `remembered`
     becomes the `<iframe>`.
  2. The user clicks back into Operator: the terminal, a toolbar button, a panel tab or a lane in the rail.
     The window `focus` fires, `onActivate` runs, and `apply` runs one frame later.
  3. `apply` sees `current` = the xterm textarea (`terminal`) or a button (`other`). Neither counts as
     typing, so `keep` is skipped.
  4. `remembered` is the iframe, which is `embedded` and still visible, so the plan is `restore`, and the
     code calls `iframe.focus()`.
- **Failure scenario:** Preview open beside a lane. The user clicks a button inside the previewed app,
  then clicks the terminal and types a prompt. The keystrokes go into the previewed app, because focus
  was moved back into the iframe a frame after the click. Every click out of the Preview does this.
  Only clicking a text field (`keep`) escapes it.
- **Fix:**
  - Act only on real activation: main's `onWindowActivated` and the document becoming visible. Do not act
    on the renderer's own `window` `focus`, which also fires for in-page frame focus changes.
  - Do not record `remembered` on a `blur` that only moved focus into an iframe. In that case
    `document.activeElement` is the iframe and the document still has focus in the page's sense; check
    `document.activeElement.tagName === 'IFRAME'` at blur time and skip it.
  - Add a test that drives an iframe focus round-trip.

### 2. Medium — a click that activates the window is overridden by the remembered text field

- **Where:** `refocus.ts:72-74`, rule order.
- **What:** `current: 'terminal'` never counts as intentional. A remembered text field that is still on
  screen wins over it.
- **Failure scenario:**
  1. The user is in a text field: the Diff panel's commit message, a rename field in the rail, or the
     Preview's note input.
  2. They Cmd-Tab away, then come back by **clicking the terminal**. On macOS the click activates the
     window and is delivered, so the terminal gets focus.
  3. One frame later `apply` sees `current = terminal` and `remembered = text-field` (visible), and
     restores the field.
  4. The prompt the user starts typing goes into the commit message or rename field.
- **Fix:** when a `pointerdown` or `keydown` happened after the activation, do nothing: the user has
  already chosen. Record a timestamp in a capture listener and compare it in `apply`.

### 3. Low–medium — returning to the app closes an open menu and moves focus off controls

- **Where:** `refocus.ts` `classifyFocus`: `role="menu"`/`menuitem`, tab buttons and checkboxes are all
  `other`.
- **What:** with a lane on screen, rule 2 moves focus to the terminal whenever the focused element is not
  a text field, dialog or iframe. `PopMenu` and `CardMenu` dismiss on "focus leaving"
  (`lib/use-dismiss.ts:60`, `focusout`).
- **Failure scenario:** the user opens a lane's card menu or the toolbar `PopMenu`, Cmd-Tabs to check
  something, and comes back. The menu has closed and focus is in the terminal. The same happens to a
  focused side-panel tab or Settings control that is not a text input.
- **Fix:** count an open floating panel (`[role="menu"]`, `[role="listbox"]`, the palette) as `dialog`,
  or keep any focused element that is not `body`.

### 4. Low — a keystroke typed in the first frame after activation can be lost

`apply` runs on the next animation frame (`use-refocus-on-activate.ts:65`). A key typed before then goes
to whatever the platform focused, usually `body`, and is dropped. That is at most one frame, and much the
same as before this branch. Not measured.

### 5. Unverified — `webContents.focus()` and the out-of-process Preview frame

`win.on('focus')` calls `webContents.focus()` every time (`electron/src/main/index.ts:128`). If that moves
focus from the out-of-process Preview iframe to the main frame, rule 1's `embedded` keep never applies on
activation, and the iframe is only refocused by `restore`. That is harmless, but it depends on finding 1's
`remembered` bookkeeping. Worth a live check alongside 1.

## Checked and clean

- **No focus loop between main and the renderer.**
  - `webContents.focus()` focuses the page inside an already-focused window and does not emit
    `BrowserWindow` `focus` again.
  - `win.focus()` runs only on app `activate` (`onAppActivated`).
  - The renderer never calls into main to focus.
- **A hidden window is not focused or shown at launch.** `onAppActivated` returns when
  `!win.isVisible()`, and the window is created with `show: false` and shown by the renderer. There is a
  test for this.
- **Multiple windows do not apply.** The app has one `BrowserWindow` (`index.ts:94`). The preview
  inspector no longer uses a `WebContentsView` and runs inside the Preview iframe
  (`preview-inspect.ts`, "NO SECOND PAGE"). The only frame to worry about is the iframe, which is
  finding 1.
- **The idle-reload case is still covered.**
  - The removed per-pane `visibilitychange` listener is replaced by the hook's own
    (`use-refocus-on-activate.ts`, `onVisibility`).
  - A reloaded renderer's active pane is focused by `applyPaneActivation` on mount.
  - The hook reads the lane on screen only through `activationViewRef`, which excludes the board,
    settings, the activity timeline and the diff review.
- **Fields the user is in keep focus when they are focused on return:** the command palette's input,
  rename fields, Settings text inputs, the task composer, dialogs (`[role=dialog]`, `aria-modal`) and the
  Preview iframe itself.
- **A removed element is never focused.** `remembered` is checked for `isConnected` and visible rects
  before `restore`.
- **The primary input** is limited to the board's hero composer (`data-primary-input` in `TaskBoard.tsx`).
  It is used only when no lane is on screen.
- **Triggers are coalesced** to one decision per frame (`queued`).
- **No leaks.** The hook removes its three listeners and main's event subscription on unmount.

## Verdict

**Not merge-ready.** Finding 1 turns normal Preview use into focus being pulled back into the iframe
after every click out of it. It does not need an app switch, because the parent window's `focus` and
`blur` fire on iframe focus changes. The fix is small: act only on main's activation event and
visibility, and ignore iframe-entry blurs. Fix 2 at the same time: skip when the user clicked or typed
after activating. 3 and 4 can follow. Confirm 1 and 2 live after the fix, since GUI verification is the
user's.

---

## Re-check after 9b1884a (result 2f20127), 2026-09-26

**Checks.** On a scratch `git archive` export of `2f20127`:
- root `tsc` exit 0, electron typecheck exit 0;
- electron 45 files, **790 passed**; renderer 102 files, **1482 passed**.

This includes the new `refocus-controller.test.ts`, which replays the event sequences below.

**What changed.**
- The event handling moved into `refocus-controller.ts`.
- Activation now means **only** main's `onWindowActivated` or the document becoming visible. The page's
  own `window` `focus` is no longer used.
- A `window` `blur` records the focused element only if, one macrotask later, `document.hasFocus()` is
  false, so the app really lost focus (`refocus-controller.ts:74-80`). The iframe is never recorded.
- A `pointerdown` or `keydown` after the activation makes the plan `keep` (`:58`, `refocus.ts:84`).
- Any focused element other than `body` (or a hidden terminal) is kept (`refocus.ts:87`).
- The remembered element is used at most once.

### The original scenarios, walked again

1. **A click into the Preview iframe, then back out: fixed.**
   - Focus entering the iframe fires the page's `blur`, but `document.hasFocus()` is still true, because
     the focused frame is a descendant. So nothing is recorded.
   - Clicking back into the page fires the page's `focus`, which is no longer a trigger, and main sends
     nothing, because the window never lost key status.
   - Nothing refocuses. The test "iframe focus round-trip with no app switch" pins this.
2. **Cmd-Tab away from a rename field, and back without clicking: fixed.**
   - The app-level blur records the field (`hasFocus()` is false after the switch).
   - On return, if Chromium restored the field, it is kept (`current` is not `none`). If focus was left on
     `body`, the field is restored once.
3. **Returning and clicking the terminal: fixed.**
   - If the click comes after main's activation signal, `userActedSinceActivation` gives `keep`.
   - If it comes first, `current` is the terminal, which is not `none`, so it is also `keep`. Both orders
     are tested.
4. **An open PopMenu or CardMenu, or a focused tab or control: fixed.** A focused menu item or button is
   `other`, not `none`, so it is kept, and `use-dismiss`'s focus-leaving rule is never triggered.

**Real activations are not missed.** Cmd-Tab, a Dock click, clicking the window and Mission Control all
emit `BrowserWindow` `focus`, and so `onWindowActivated`. A reload or hidden page coming back is covered
by `visibilitychange`. Only the page's own `focus`, which was the cause of finding 1, is dropped. A bridge
without `onWindowActivated` (mock, Tauri) does no refocusing, as documented.

### Cmd-Tab away while focus is in the Preview iframe, then back — one open question

- **When focus is already inside the iframe, the page gets no second `blur` at the app switch.** It
  already got one when focus entered the frame. So nothing is recorded for that switch.
- On return, the outcome depends on where Chromium puts focus after `webContents.focus()`:
  - **Chromium restores the focused frame** (what I expect: frame focus is kept separately from widget
    focus). Then `document.activeElement` is the iframe, `embedded` is not `none`, and the plan is
    `keep`. Correct.
  - **Chromium leaves the main frame's `body` focused.** Then `remembered` is empty, and a lane on screen
    gets focus (`focusTerminal`). The controller test "the app lost focus while the Preview had it"
    asserts exactly this outcome.
- In that second case, text meant for the previewed app goes into Claude's prompt, and Enter submits it.
- The `embedded` branch in `worthRestoring` (`refocus.ts:88`) can never be reached, since an iframe is
  never recorded.

**Not verified.** I cannot tell which of the two Chromium does without running the app.

**Hardening, if a live check shows the jump:** note on the iframe-entry blur (`hasFocus()` true and
`activeElement` is the iframe) that focus is in the Preview. Clear that note on the next `pointerdown` or
`focusin` in the page. Then, on activation with `current === 'none'`, restore the iframe instead of the
terminal.

### The other earlier findings

- **Finding 4 (first-frame keystroke): unchanged, Low.** A key typed before the next frame now counts as
  user input, so the plan is `keep` and focus is not moved. The key itself still goes wherever the
  platform put focus.
- **Finding 5 (`webContents.focus()` and the out-of-process frame):** this is the same open question as
  the section above.

### Verdict

**Merge-ready.** Both blockers (1 and 2) are fixed, and finding 3 is fixed as well. Before shipping, one
live check, which is the user's to do: focus a field inside the Preview, Cmd-Tab away and back, and type.
If the text lands in the terminal, add the hardening above.
