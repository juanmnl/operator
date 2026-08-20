# `spike/electron` — an Electron shell for the Operator renderer

Runs the **unmodified** Operator renderer (`src/renderer`, 29k LOC) on Electron, with the
terminal implemented for real over `node-pty`. Nothing under `src/` or `src-tauri/` is touched.

It exists to answer three measured questions — does WebGL xterm survive under Chromium, what
does our fleet shape cost in memory, and what does the shell itself cost — and it is built as
the **seed of a real shell** rather than a throwaway: typed IPC derived from the renderer's own
contract, a main/preload split worth keeping, and the navigation guards the app already needed.

## Run it

```sh
cd spike/electron
npm install          # also rebuilds node-pty against Electron's ABI
npm run dev          # Vite + esbuild --watch + Electron
```

`npm run dev` needs a free port. It defaults to 1450 and **refuses to start** if something else
holds it — on a machine running several projects, the port you assumed was yours is often
somebody else's dev server, and a bench that quietly loads the wrong app produces a clean,
meaningless number. Override with `OPERATOR_ELECTRON_PORT`.

```sh
npm run build        # main + preload (esbuild → CJS) and the renderer (Vite)
npm run package      # unsigned .app in dist/
npm run typecheck    # both halves, against src/renderer/env.d.ts
```

## The measurement bench

`OPERATOR_ELECTRON_PAGE=bench.html?...` opens the harness instead of the app. It mounts the
SHIPPED `TerminalPane` over real ptys — a string fed to xterm in a loop would answer a question
nobody asked.

| Param | Meaning |
|---|---|
| `renderer=webgl\|dom` | which xterm renderer (default `dom`, what ships) |
| `lanes=N` | how many panes to mount (27 = the measured fleet) |
| `stream=N` | how many replay `scripts/width-audit/claude-turn.bin` on a loop |
| `claude=1` | lane 0 is a real `claude` session instead of a replay |
| `cwd=/path` | where lanes spawn |

Only lane 0 is `active`, so the rest hold `INACTIVE_SCROLLBACK` exactly as background lanes do
in the app.

Instrumentation is off unless asked for, and is not on the API's channels:

```sh
OPERATOR_ELECTRON_CAPTURE=./measurements/run   # PNG of the COMPOSITED surface + memory CSV
OPERATOR_ELECTRON_CAPTURE_MS=900000            # capture interval (default 15 min)
OPERATOR_ELECTRON_METRICS_MS=30000             # RSS sample interval
OPERATOR_ELECTRON_LABEL=webgl                  # filename prefix
```

`capturePage` reads the composited surface, which is the only instrument that can see a WebGL
atlas fault — the xterm BUFFER is correct in every one of these failures; it is the picture
that is wrong. **Read `<label>-loads.log` before reading the frames**: a renderer reload
restarts the panes with a fresh WebGL context, so a run that reloaded is not the run it claims
to be.

## How it is put together

```
src/shared/operator-api.ts   the contract: OperatorApi = Window['operator'], + the SPEC table
src/shared/ipc-contract.ts   typed invoke/send/event maps derived from those signatures
src/main/index.ts            lifecycle, window, navigation guards
src/main/terminals.ts        node-pty: the one backend piece implemented for real
src/main/ipc.ts              handler registration (no channel strings, no `any` payloads)
src/main/bench.ts            measurement hooks, off unless env-var'd
src/preload/index.ts         contextBridge → window.__operatorNative, + the drop guard
src/renderer/bridge.ts       mock-bridge with the real methods laid over it
src/renderer/main.tsx        the real App
src/renderer/bench.tsx       the harness
```

**The contract is derived, not copied.** `src/renderer/env.d.ts` declares the API as a global,
so `Window['operator']` reaches the whole shape. A hand-written mirror of 90 signatures would
keep compiling on the day someone adds a method; `SPEC: Record<ApiMethod, MethodSpec>` makes
that a type error instead. Every handler's parameters and return type are read off the same
signature the renderer calls.

**The port is incremental by construction.** `dev/mock-bridge.ts` already answers all 90
methods with fixtures; the shell overrides only what it owns, and `src/renderer/bridge.ts`
layers them. Moving a method from mock to native means editing `SPEC` and writing the handler —
the renderer never learns which half it is talking to. See `PORT-LEDGER.md` for what each
remaining module costs.

## The guards, and why they are not hygiene theatre

A file dropped on a webview **is a navigation**, and the default answer is yes. Operator has
already lost a window to this (2026-08-14: a stray Finder drop navigated the WKWebView to
`file:///…/image.png`, and closing that window killed every lane's pty). Both layers are here
on purpose: the preload cancels the drop and turns it into real paths via
`webUtils.getPathForFile`, and `will-navigate` in main refuses any origin that is not this app
— because the renderer is the layer that can be mid-reload, crashed, or not listening yet, and
main is the layer that cannot.

`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `<webview>` refused,
`window.open` denied and handed to the system browser. `backgroundThrottling: false` because
Operator's whole premise is that a lane you are not looking at keeps working.

## What is NOT here

- **The artifact plane.** Lanes reach Operator's MCP server via `<current_exe> --mcp-serve`;
  under Electron that is the Electron binary and would need an argv branch. Deliberately not
  wired: a lane pointed at a server that does not exist is worse than a lane with none.
- **The grid terminal.** `gridterm.rs` embeds `alacritty_terminal`; there is no npm equivalent.
  Spawn reports `grid: false`.
- **The quit guard, transcript tailer, worktrees, chat store, usage** — all mock. `SPEC` says
  so, per method, and `ipc.ts` asserts at boot that nothing marked `native` lacks a handler.
- **A draggable title bar.** Electron has no programmatic window drag; it needs
  `-webkit-app-region: drag` on the element, which lives in `src/renderer`. See the ledger.
