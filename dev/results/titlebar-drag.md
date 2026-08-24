# Title-bar drag under the Electron shell

**Branch:** `operator/a30080` · 2026-08-24 · Code lane

## The defect

The window could not be dragged by its title bar in the Electron shell. Two halves of one
mechanism, neither of which was wired to the other:

- `electron/src/main/ipc.ts:220` — `startWindowDrag: () => {}`. Deliberate: Electron has no
  counterpart to Tauri's `startDragging()`. The comment above it says a frameless window is
  dragged with the CSS `-webkit-app-region: drag`, "which lives on the element — i.e. inside
  `src/renderer`".
- `src/renderer/styles.css:5` — `.drag-region { cursor: grab; }`. That was all of it. The
  property the shell was deferring to had never been added.

So `DragRegion`'s `onMouseDown` called into a no-op, and nothing else moved the window. The
strip painted a grab cursor over a surface that could not be grabbed.

## The fix

`src/renderer/styles.css`

```css
.drag-region { cursor: grab; -webkit-app-region: drag; }
.drag-region:active { cursor: grabbing; }

.drag-region button,
.drag-region a,
.drag-region input,
.drag-region textarea,
.drag-region select,
.drag-region [role="button"],
.drag-region [data-no-drag] { -webkit-app-region: no-drag; }
```

The `no-drag` list is `DragRegion`'s own mousedown selector, character for character. They are
the same question — "is this bare title bar, or something the user is aiming at?" — asked once
in CSS for Electron and once in JS for Tauri, and they must not drift.

`src/renderer/components/session/SessionToolbar.tsx` — `data-no-drag` on the MCP dropdown and
its backdrop.

This one is not cosmetic. `-webkit-app-region` **inherits**, and `McpDropdown` renders *inside*
`SessionToolbar`'s `DragRegion`. Its backdrop is `position: fixed; inset: 0` — a full-viewport
div. Without the opt-out, opening the MCP dropdown would have turned the entire screen into a
window-drag handle, and the click-away that dismisses it would have moved the window instead.
That is a defect the naive one-line version of this fix introduces; `[data-no-drag]` exists in
the selector list for exactly the case the element-name selector cannot reach.

Three inline `WebkitAppRegion: 'no-drag'` styles already sat in `SidebarToggle.tsx` and
`SessionToolbar.tsx` from earlier partial work. They are now redundant against the CSS rule but
harmless, and I left them — no drive-by cleanup.

## Tauri is unaffected — verified, not assumed

I did not want to ship this on a claim about WebKit internals, so I measured it. Playwright's
WebKit (`webkit-2311`, the same engine family as the WKWebView Tauri uses on macOS) against
Chromium, on a page with exactly the rules above:

```
webkit:   supports=false  computed=""      events=["bar-mousedown","bar-mousedown","btn-click"]
chromium: supports=true   computed="drag"  events=["bar-mousedown","bar-mousedown","btn-click"]
```

`CSS.supports('-webkit-app-region', 'drag')` is **false** in WebKit and the computed value is
empty — the declaration is dropped at parse time. It cannot alter hit-testing, cannot swallow a
mousedown, cannot do anything at all under Tauri. `DragRegion`'s imperative
`startDragging()` path there is untouched, and this change is additive rather than a swap.

(The doubled `bar-mousedown` is just bubbling from the button; both engines still deliver the
button's click, which is the other thing the probe was checking.)

## The one behavioural difference: double-click to zoom

Electron's documented caveat is that a draggable region may be treated as non-client area, in
which case mouse events are not delivered to the page. On macOS that is what happens: the region
is excluded from the web view's hit test so AppKit can drive the drag. Consequence:

- **Under Tauri** — unchanged. `DragRegion` sees the mousedown, times consecutive presses, and
  calls `toggleWindowMaximize()` on the second. Always zoom.
- **Under Electron** — the renderer most likely never sees the mousedown, so that timer never
  runs. Instead macOS itself handles the double-click on the title bar, per
  *System Settings → Desktop & Dock → "Double-click a window's title bar to"*. On the default
  (Zoom) that is the same outcome by a more native route; if the user has it set to Minimize or
  Do Nothing, the behaviour differs from Tauri's unconditional zoom.

**This is the part I could not verify and it needs the user's eyes** (per the standing env
constraint: GUI verification is the user's, outside the `verify:visual` / `verify:input`
harnesses). There is no headless way to exercise an OS window drag or an AppKit title-bar
double-click.

The brief's suggested fallback — "wire the Electron main side to zoom on titlebar double-click
instead" — is not available as written: the main process has no mouse-event stream, and if the
renderer isn't receiving the event, nobody is left to tell main where the click landed. If the
eyeball check shows double-click does nothing, the real fallback is to drop the CSS again and
implement `startWindowDrag` in main by polling `screen.getCursorScreenPoint()` and calling
`win.setPosition()` until mouseup — which keeps the renderer receiving events, and therefore
keeps the existing JS double-click, at the cost of a jankier drag.

## Checks

| | |
|---|---|
| `npx tsc --noEmit` (root) | **0** — clean |
| `npm test` (root, vitest) | **765 passed, 33 failed** — byte-identical to the same run on a clean tree |
| `npx tsc --noEmit -p electron/tsconfig.json` | **0** — clean |
| `npx vitest run` (electron) | **226 passed, 16 files, 0 failed** |

The 33 root failures are **pre-existing and environmental**, not caused by this change. I
confirmed that directly: I stashed the diff to a patch, reverted the tree, re-ran, got the same
`5 failed | 57 passed (62)` / `33 failed | 765 passed (798)`, and re-applied. They are all
`TypeError: Cannot read properties of undefined (reading 'clear')` and friends — jsdom 25's DOM
globals (`localStorage`, `atob`) not landing under Node 26 in this worktree. Worth someone's
attention, but it is a different task and I left it alone.

Root `node_modules` and `electron/node_modules` were absent in this worktree; both were
installed with `npm ci` to run the above.

## Files touched

- `src/renderer/styles.css` — the drag/no-drag rules
- `src/renderer/components/session/SessionToolbar.tsx` — `data-no-drag` ×2 on the MCP dropdown
- `electron/src/main/ipc.ts` — comment only: the no-op is now the finished shape, not a gap
- `electron/PORT-LEDGER.md` — "The one thing that does not map" marked done
