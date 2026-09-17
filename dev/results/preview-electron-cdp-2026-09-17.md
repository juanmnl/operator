# Preview for Electron apps over Chrome DevTools Protocol, stage 1 (2026-09-17)

Commit `a6d7bed` on `operator/preview-electron-cdp`, branched from `main` at `ccf5207`. It lands after
the 0.24.0 tag and there is no rush to merge.

Background: `dev/results/native-preview-research-2026-09-17.md` §2b, §4 and "Stage 1".

Not verified in the running app. The mechanics are proven by an Electron probe that launches a real
throwaway Electron app (below), and the pieces have unit tests. The React integration (switch,
canvas, empty state) is typechecked but has not been used in Operator itself.

## Result in one table

Measured on this Mac with Electron 43.4.1, with the real `preview-cdp.ts` driving a throwaway
Electron app (`electron/probes/preview-cdp-electron.cjs`). Every check was run twice, with the app's
window shown and hidden.

| Check | Shown window | Hidden window |
|---|---|---|
| Debugging port from `ELECTRON_EXTRA_LAUNCH_ARGS=--remote-debugging-port=P` | **no port** | — |
| Debugging port from `electron app --remote-debugging-port=P` | opens | — |
| Debugging port from the app's `app.commandLine.appendSwitch('remote-debugging-port', process.env.OPERATOR_CDP_PORT)` | opens | — |
| Targets listed from `/json/list` | 1 ("Probe App") | 1 |
| Attach, first screencast frame | PASS (640×388 CSS, 9 KB JPEG) | PASS |
| New frames follow page changes (a counter changing 20 times) | 22 frames | 22 frames |
| Forwarded click increments the app's counter | PASS | PASS |
| Forwarded keys type into the app's input | PASS | PASS |
| Input round-trip (CDP ack) | 1–12 ms | 0–3 ms |
| Inspect: hover and click open the compose card, and "→ Console" reaches Operator as a pick through `Runtime.addBinding` | PASS (the picked `div`, box 120,160 180×70) | PASS |
| Redlines: ⌥-click sets the anchor, reported through the binding | PASS | PASS |
| After `Page.reload`, the scripts are back and configured | PASS | PASS |
| Note screenshot (`Page.captureScreenshot` with a clip, shared outline pipeline): element inside the outline, no hover outline | PASS (element (50,50)–(405,185) in outline (47,47)–(408,188)) | PASS |

`RESULT PASS`, exit 0. `OPERATOR_DIR` was a temp directory, and nothing was written under
`~/.operator`.

## (1) Electron projects get a debugging port

**`electron/src/main/preview-cdp-port.ts` (new):**
- `dependsOnElectron(pkg)`: `electron` in `dependencies` or `devDependencies`.
- `isElectronProject(cwd)`: checks the project's `package.json`, and those in `electron/`, `app/` and
  `desktop/`. Operator's own layout keeps Electron in `electron/`. The root `package.json` also lists
  it, so Operator's own lanes will get a port.
- `allocateCdpPort`: the first port in 9340..9440 that this process has not handed out and that binds
  free. It uses its own window, away from the dev-port window (1420..1520) and from Chrome's 9222.
- `cdpLaunchNote(port)`: the launch-note paragraph.

**`terminals.ts` hook:**
- `buildCommand` reserves a CDP port for a lane in an Electron project, through the same allocation
  gate as the dev port, so concurrent launches cannot collide.
- It exports `OPERATOR_CDP_PORT` and adds the note to the lane's appended system prompt.
- `Managed.cdpPort` and `cdpPort(id)` let IPC find a terminal's port.
- There is one port per lane, unshared: two lanes run two apps.

**How the app gets the switch.** Operator cannot add a switch to an arbitrary npm script, so the note
tells the agent:
- enable it in the app's main process before `app` is ready:
  `app.commandLine.appendSwitch('remote-debugging-port', process.env.OPERATOR_CDP_PORT)`, guarded for
  development builds; or
- start Electron with `--remote-debugging-port=<port>`.

Both are measured to work. `ELECTRON_EXTRA_LAUNCH_ARGS` was tried and **does not** open a port.
Nothing in the `electron` package reads it, which I also checked by grep. So it is not exported.

## (2) Target discovery and choice

- `listTargets(port)` fetches `http://127.0.0.1:<port>/json/list`.
- `parseTargets` keeps `type: page` entries that have a `webSocketDebuggerUrl`, and drops
  `devtools://` windows, service workers and targets already being inspected elsewhere.
- In the renderer, `usePreviewElectron` asks for the lane's port and windows every 10 s, or every 2 s
  while the Electron source is chosen.
  - A single window is attached automatically; with several, a select in the bar lists them by title
    or URL.
  - A closed window is noticed on the next poll, and `onPreviewCdpDetached` reports a dropped
    connection.
  - The IPC is `previewCdpTargets(terminalId)` → `{ port, targets }`, and
    `previewCdpAttach(terminalId, targetId)`.

## (3) Show and drive

**Main (`preview-cdp.ts`):**
- It connects with `cdp-client.ts`, a minimal JSON-RPC client over the WebSocket that Electron 43's
  Node (24.18.1) provides as a global. There is no `ws` dependency.
- On attach it runs:
  - `Page.enable`, `Runtime.enable`;
  - `Emulation.setFocusEmulationEnabled` — keys reach only a focused page, and the app's window is
    behind Operator's;
  - `Runtime.addBinding`;
  - the scripts (see 4);
  - `Page.getLayoutMetrics`;
  - `Page.startScreencast` (JPEG, quality 80).
- Each `Page.screencastFrame` is acknowledged and sent to the renderer as `onPreviewCdpFrame`, with
  the viewport's CSS size from the frame metadata.
- Screencast was good enough, so no polling fallback was needed. It sends a frame per visual change,
  including while the app's window is hidden (measured above).

**Renderer:**
- `PreviewElectronCanvas` draws each frame at its device pixels, and is sized to
  `fitFrame(panel box, app CSS viewport)`: contain, never above 1:1.
- The stage box is exactly the canvas, so Annotate percentages and window captures refer to the
  app's pixels.
- Mouse down, up, move, wheel and key down/up are mapped to the page's CSS px (`toPage`,
  `cdpModifiers`, `cdpButton`, `keyInput`) and sent as `previewCdpInput`. `inputCommand` in main
  builds the `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` call. A printable key is sent as
  `keyDown` with `text`; other keys as `rawKeyDown`.
- ⌘ combinations are not forwarded, so ⌘K, ⌘E and ⌘' stay Operator's.
- Device presets do not apply to the Electron source. It shows the app window at its own size.

## (4) Inspect, redlines, grid, screenshots: the same code path

- **Same scripts:** `preview-inspector.js` + a CDP bridge + the overlay functions +
  `preview-overlay.js` are run in the app's page with `Runtime.evaluate`, and registered with
  `Page.addScriptToEvaluateOnNewDocument`.
  - After each `Page.loadEventFired` the overlay configuration is applied again and the anchor is
    reported cleared.
  - The inspector is switched **off** right after injection: it starts enabled until configured, and
    the probe caught that swallowing the first forwarded click. The renderer's configuration turns it
    on for Inspect.
- **Same events:** `CDP_BRIDGE_JS` defines the same three functions as the iframe bridge
  (`__operatorPickBridge`, `__operatorAnchorBridge`, `__operatorBeacon`), calling the binding with
  `{kind:'pick', data}` / `{kind:'anchor', value}`. `routeBinding` validates the payload, and main
  broadcasts the existing `onPreviewPick` / `onPreviewAnchor` events, so AppPreviewPanel's pick
  handler and DashboardView's anchor state are unchanged.
- **Same renderer calls:** `ipc.ts` routes `previewInspectOpen/Configure/Close/ClearAnchor` to the
  attached app when one is attached, and to the Preview iframe otherwise.
  - `AppPreviewPanel` treats an attached app as a page (`pageKey`, `pageUp`), so Inspect, Redlines,
    Grid and Annotate appear.
  - Its overlays always run in the app's page (`nativeHost`), with `scale` = canvas px per page CSS
    px.
- **Screenshots:**
  - An Inspect note from the app calls `previewCdpShot({ project, id, targets, outline })` with the
    pick's boxes in page CSS px.
  - Main crops to the viewport, hides the hover outline, and runs `Page.captureScreenshot` with a clip
    (document coordinates: the visual viewport's `pageX/pageY` are added).
  - The result is finished by `finishShot`: outline, size cap, encoding and storage, split out of
    `preview-shot-capture.ts` so both paths share it.
  - Annotate notes on the Electron source still use the window capture over the stage, which is the
    canvas.

## Files

- **New:**
  - `electron/src/main/preview-cdp.ts`, `preview-cdp-port.ts`, `cdp-client.ts`, `preview-cdp.test.ts`;
  - `src/renderer/components/session/PreviewElectron.tsx`;
  - `src/renderer/lib/preview-electron.ts`, `preview-electron.test.ts`;
  - `electron/probes/preview-cdp-electron.cjs`.
- **Hooks in shared files** (+204 / −53 across them):
  - `terminals.ts`: port, env, note;
  - `ipc.ts`: 5 new handlers and routing of 4 existing ones;
  - `index.ts`: install and broadcasts;
  - `operator-api.ts`, `env.d.ts`, `types.ts`: the contract;
  - `preview-shot-capture.ts`: `finishShot` split out, behaviour unchanged, and the web Inspect-shot
    probe still passes;
  - `AppPreviewPanel.tsx`: source state, the switch, `pageKey`/`pageUp` in place of
    `display`/`reach` gating, the stage content, and the pick-shot branch.
- `preview-inspect.ts` and `preview-inspector.js` are untouched, per the brief (Design is working
  there).

## Tests and results

- **`electron/src/main/preview-cdp.test.ts`** (11):
  - discovery parsing (page targets only; DevTools, workers and socketless entries dropped;
    non-lists);
  - message routing, including running `CDP_BRIDGE_JS` in a VM and feeding its binding calls through
    `routeBinding`, and the pick failure path with no binding;
  - input commands;
  - port reservation (skips handed-out and busy ports; exhausted window);
  - the launch note's text;
  - Electron detection from dependencies/devDependencies only, the subpackage layout, broken and
    missing files.
- **`src/renderer/lib/preview-electron.test.ts`** (5): frame fitting, canvas → page mapping,
  modifiers and buttons, key text rules.
- **`electron/probes/preview-cdp-electron.cjs`:** the table above, `RESULT PASS`.
  `preview-inspect-shot.cjs` (web) still passes after the `finishShot` split.
- Root `tsc --noEmit -p .`: pass. `electron` `tsc -p tsconfig.json` and `tsc -p tsconfig.renderer.json`:
  pass. `build-main` builds.
- Renderer suite (`vitest run src/renderer`): 92 files, 1339 passed, 0 failed.
- Full root suite (`vitest run`): 98 files, 1432 passed, 0 failed.
- Electron suite: 38 files, 676 passed, 0 failed.
- All run with the main checkout's `node_modules` and `electron/node_modules` symlinked in, removed
  after.

## Limits and open items

- **The app must opt in.** A lane's agent is told how. An app started without the switch shows the
  empty state with the snippet.
- **Port lifetime:** the reserved port is not written to the dev-port lease file, so a second
  Operator instance could hand out the same number. The bind check still refuses a port the other
  app has actually opened.
- **Scope:**
  - one attached app at a time;
  - no device presets for this source;
  - the main (Node) process is not inspectable over CDP, only renderer windows;
  - multi-window apps pick a window from the list;
  - an app's own `<webview>`/`BrowserView` content is a separate target and is not composited in.
- **Security:** the debugging port gives full control of the app's renderer to anything on
  localhost. That is the standard trade-off of `--remote-debugging-port`, and it is why the note says
  to guard it for development builds.
- **Not verified in the GUI:**
  - the Web / Electron app switch;
  - the canvas and its input feel (scroll inertia, IME and dead keys are not handled specially);
  - Inspect/Redlines/Grid on a real app;
  - a note screenshot from the app.
- **Not done:** CDP-native inspection (`DOM.getBoxModel` / `Overlay.highlightNode`), which the
  research suggests as a later improvement. Stage 1 reuses the injected scripts so the UI path stays
  shared.

---

## Rebase onto 0.24.0 (f61c4a9), CSS controls on the Electron source, Operator's own opt-in (2026-09-17)

Branch `operator/preview-electron-cdp` is now two commits on `main` at `f61c4a9`:
- `b22f616`: the stage-1 commit above, rebased. It replaces `a6d7bed`.
- `4f01df5`: this section.

### Rebase

The only textual conflict was one import line in `AppPreviewPanel.tsx`. My branch added `pickTargets`
and Design's added `pageToStage`, and the resolution keeps both. Design's CSS controls
(`usePreviewEdit`, `captureEdit`, `PreviewEditPanel` under the stage) merged cleanly around the
Electron source changes, and typechecked before any further edit.

### CSS controls over CDP

Design's page engine (`src/shared/preview-edit-page.js`) talks to `window.parent`:
- It posts state to it: `{ __operatorEdit: 'state', data }`.
- It accepts commands only when `event.source === window.parent`.

In an Electron app the page is the top-level frame, so `window.parent` is the page itself. That
gives a transport without changing Design's file.

- **Injection:** `preview-cdp.ts` appends `EDIT_FNS_JS` + `preview-edit-page.js` to the scripts it
  runs with `Runtime.evaluate` and registers with `addScriptToEvaluateOnNewDocument`. This is the same
  order as `preview-inspect.ts`. The inspector's existing `__operatorEdit.select(el, data)` call in
  `showCompose` then selects the picked element in the app.
- **Page → Operator:**
  - `CDP_BRIDGE_JS` adds one `message` listener per document (guarded, so a re-attach does not add a
    second). It forwards messages whose `source` is the page's own window and that carry
    `__operatorEdit: 'state'`, over the binding as `{ kind: 'edit', data }`.
  - `routeBinding` accepts that shape, and main broadcasts `onPreviewCdpEdit(data)`.
- **Operator → page:**
  - `previewCdpEditCommand(msg)` → `editCommandExpression(msg)` → `Runtime.evaluate` of
    `window.postMessage(<msg as JSON>, '*')`.
  - Only objects carrying a string `__operatorEditCmd` are delivered.
  - The message is JSON-encoded into the expression, never concatenated (tested with a value that
    tries to break out).
- **Renderer transport** (`src/renderer/lib/use-preview-edit.ts`):
  - `usePreviewEdit(transport, resetKey)` takes an `EditTransport { subscribe, post }`.
  - `iframeEditTransport(frameRef)` is Design's original postMessage code, with the same `contentWindow`
    check.
  - `cdpEditTransport` wraps `onPreviewCdpEdit` / `previewCdpEditCommand`, and rewraps the state in the
    engine's message shape so `editStateMessage` parses both.
  - `AppPreviewPanel` picks the transport by source, and the reset key includes the attached window.
  - `PreviewEditPanel` is unchanged and does not know the source.
- **Before/after screenshots:** `captureEdit` on the Electron source sends `capture: on` (the engine
  hides its handles and the compose card), calls `previewCdpShot` with the element's box in page CSS
  px (the `Page.captureScreenshot` clip), then `capture: off`. The web source path is unchanged.

### Operator previewing itself

`electron/src/main/index.ts` now opens a remote debugging port before `app` is ready when
`ownCdpPort(app.isPackaged, process.env, process.argv)` returns one:
- only when not packaged;
- only when `OPERATOR_CDP_PORT` is a port number;
- never on the `--mcp-serve` path. In a dev build, lanes spawn `electron <app> --mcp-serve` with the
  lane's environment, and that process would otherwise take the port first.

A lane in Operator's own repo already gets `OPERATOR_CDP_PORT`: the root `package.json` lists Electron.
So a dev build it starts can be shown in that lane's Preview.

This is not exercised live. Starting a dev Operator runs boot reconciliation and dev-server reaping
against the real `~/.operator`, which a probe should not do. The guard is unit-tested.

### Probe additions (`electron/probes/preview-cdp-electron.cjs`)

After the real Inspect pick, with the window shown and hidden:

| Check | Result |
|---|---|
| The pick selects the element; state arrives through the binding | PASS (`div`, box 120,160 180×70) |
| `set padding-top 24px` changes the app's computed style, and state carries the value | PASS (`0px` → `24px`, values `{padding-top: 24px}`, history 1) |
| Before/after screenshots (handles hidden, as `captureEdit` does) show the element grow by the padding | PASS (element 136 → 184 device px, 24 CSS px at 2×) |
| `undo` reverts it | PASS (computed `0px`, values `{}`) |

Everything from stage 1 still passes: `RESULT PASS`, exit 0. The first run showed the before crop
with no element visible, because the probe had not hidden the engine's handles. `captureEdit` does,
and the probe now does the same.

### Tests and results

- `electron/src/main/preview-cdp.test.ts`: 15, up from 11.
  - `ownCdpPort`: dev build yes; packaged, `--mcp-serve`, unset or non-numeric no.
  - `routeBinding` accepts `edit`.
  - The bridge forwards only the engine's state message posted to its own window, and only once
    after being evaluated twice.
  - `editCommandExpression` delivers only edit commands, JSON-encoded.
  - The two earlier bridge tests' fake windows gained an `addEventListener`.
- Web probes after the transport refactor: `preview-inspect-shot.cjs` and `preview-overlay-toggle.cjs`
  both `RESULT PASS`. `preview-edit.test.ts` (Design) passes.
- Root `tsc --noEmit -p .`: pass. `electron` `tsc -p tsconfig.json` and
  `tsc -p tsconfig.renderer.json`: pass. `build-main` builds.
- Renderer suite (`vitest run src/renderer`): 92 files, 1339 passed, 0 failed.
- Full root suite (`vitest run`): 99 files, 1455 passed, 0 failed.
- Electron suite: 39 files, 681 passed, 0 failed.
- Nothing was written under `~/.operator`, checked. Run with the main checkout's `node_modules` and
  `electron/node_modules` symlinked in, removed after.

### Notes

- **Messages visible to the app:** on the Electron source the engine's state messages and Operator's
  commands are `postMessage`s to the app's own window, so the app's own `message` listeners can see
  them. They carry only the `__operatorEdit*` tags, and an app that filters its messages ignores them.
  In the web source they went to the parent.
- **Not verified in the running app:** CSS controls on an attached Electron app, and a lane
  previewing a dev build of Operator.
