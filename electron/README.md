# `electron/` — the Electron shell for the Operator renderer

Runs the Operator renderer (`src/renderer`, 29k LOC) on Electron. **85 of the 91
`window.operator` methods are native**; the 6 that are not are `gridterm*`, dropped by
decision.

It began under `spike/` as a throwaway answering three measured questions (see
`dev/briefs/2026-08-20-electron-shell-spike-RESULT.md`) and is now the working shell: the pty
layer, the transcript tailer, worktrees, the chat + artifact stores, the MCP server, the quit
guard, usage, plan limits, the preview inspector and the updater are all ported.

## Run it

```sh
cd electron
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

## Probes

`probes/*.cjs` run under `npx electron` and answer one question each with evidence rather than
opinion. The one worth knowing about:

```sh
npx electron probes/preview-bleed.cjs [--target http://localhost:1427] [--out <dir>]
```

**preview-bleed** rebuilds the Preview topology — a real xterm pane under an overlay holding a
CROSS-ORIGIN iframe, in a window configured like the app's — and captures it with
`capturePage()` twice, with the active pane visible and hidden. It counts a witness colour (the
terminal's selection, set to magenta because neither the framed page nor the stage can produce
it) inside the stage rect, so "the terminal bleeds through the preview" is a pixel count, not a
judgement. It also records every frame-scoped event and console line the subframe produces,
which is how you tell "the shell blocked the page" from "the page failed to mount". Exits
non-zero if the pane-hidden case still bleeds.

## How it is put together

```
src/shared/operator-api.ts   the contract: OperatorApi = Window['operator'], + the SPEC table
src/shared/ipc-contract.ts   typed invoke/send/event maps derived from those signatures
src/main/index.ts            lifecycle, window, navigation guards, the --mcp-serve branch
src/main/ipc.ts              handler registration (no channel strings, no `any` payloads)
src/main/terminals.ts        node-pty              ← lib.rs
src/main/transcript.ts       the JSONL tailer      ← transcript.rs
src/main/directives.ts       the OPERATOR-* sentinels + their quotation guards
src/main/worktree.ts         git worktrees         ← worktree.rs
src/main/chat-store.ts       SQLite                ← chatstore.rs + artifacts.rs
src/main/mcp-serve.ts        the artifact plane    ← mcp.rs
src/main/store.ts            durable JSON          ← core.rs
src/main/folder-prefs.ts     settings + MCP list   ← folderprefs.rs
src/main/agents.ts           subagent .md files    ← agents.rs
src/main/usage.ts            token aggregation     ← usage.rs
src/main/plan-limits.ts      `claude -p /usage`    ← planlimits.rs
src/main/quit.ts             the quit guard        ← quit.rs
src/main/moodboard.ts        project assets        ← lib.rs
src/main/preview-inspect.ts  the embedded inspector
src/main/updater.ts          electron-updater
src/main/bench.ts            measurement hooks, off unless env-var'd
src/preload/index.ts         contextBridge → window.__operatorNative, + the drop guard
src/preload/inspector.ts     the embedded preview webview's own preload
src/renderer/bridge.ts       mock-bridge with the real methods laid over it
```

Run the shell's own tests with `npm test` (84, node environment). They cover the parsing and
policy that is easy to get subtly wrong: the removal guard, the tailer's offset discipline, the
sentinel quotation guards, the store's upsert, the `/usage` parser.

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

- **The grid terminal.** `gridterm.rs` embeds `alacritty_terminal`; there is no npm equivalent,
  and it was dropped by decision. Spawn reports `grid: false` and the six methods fall through
  to the mock. `SPEC` says so per method, and `ipc.ts` asserts at boot that nothing marked
  `native` lacks a handler.
- **A draggable title bar.** Electron has no programmatic window drag; it needs
  `-webkit-app-region: drag` on the element, which lives in `src/renderer`. See the ledger —
  it is the one place the renderer's contract does not map onto Electron.
- **A published update feed.** `updater.ts` is written but inert until `OPERATOR_UPDATE_FEED`
  points at a real `latest-mac.yml`. Tauri's `latest.json` is a different format; the feed has
  to exist before an Electron build ships, and the switch is a one-way door.

## Two things that will bite

**Native addons must stay external to esbuild.** Bundling `better-sqlite3` or `node-pty`
rewrites their require into `out/`, and the `.node` binary is then looked for beside the bundle
("Cannot find module out/build/Release/better_sqlite3.node"). Both are in `external` in
`scripts/build-main.mjs`, and `postinstall` rebuilds them against Electron's ABI.

**An `npm install <pkg>` in this directory once silently rewrote `package.json`** and dropped
every devDependency, including electron. That is why the spike is tracked in git — check
`git diff package.json` after adding a dependency.
