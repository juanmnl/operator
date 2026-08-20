# Brief — Operator back to Electron: the staged migration plan

**Plan and report. Change no code.** Output: **`dev/briefs/2026-08-20-electron-migration-plan-RESULT.md`**.
This is the reverse of `docs/tauri-migration.md` (2026-06) — read it first; it is the map of what
was ported Node→Rust, and most of its table inverts directly.

## Decision context (settled, don't relitigate)

The user has decided to return to Electron. Reasons that are certain: WKWebView-specific defects
go away (hourly WebContent kill at ~1.2 GB, blank WebGL, the stale-compositor-layer family, the
webview-UTC bug); Node in-process for the Agent SDK / ACP / AHP; Chromium `<webview>` for the
preview/inspector; Orca (MIT, Electron) as readable prior art; Chromium devtools + heap profiler.
Accepted costs: bundle ~10 MB → ~270 MB, idle RAM up, × 3+ instances; redo signing/notarize/
updater; the native grid terminal (`gridterm.rs`, alacritty) has no Node twin and is dropped.
Open: terminal renderer WebGL vs DOM — decided by the spike's M1
(`dev/briefs/2026-08-20-electron-shell-spike.md`, Code lane, in flight). Plan for both.

## Inputs you must read

- `src/renderer/env.d.ts` (the 90-method `window.operator` contract — the ONLY seam),
  `src/operator-bridge.ts` (66 `invoke`s + 8 events: gridterm:update operator:dispatch
  operator:reply preview:pick quit:requested session:update terminal:data terminal:exit).
- `src-tauri/src/*.rs` by module — sizes: lib 2780, worktree 2665, transcript 1638, planlimits
  625, chatstore 545, core 458, usage 452, gridterm 418, mcp 337, quit 324, artifacts 271,
  agents 235, tray_anim 220, folderprefs 175. Read each module's public surface, not every line.
- `src-tauri/tauri.conf.json`, `capabilities/default.json`, `.github/workflows/build.yml`, and
  memory `project_release_process.md` / `project_tauri_build_state.md` (signing identity,
  notarization key, Tauri updater → `juanmnl/operator-releases/latest.json`; **never regenerate
  the Tauri updater key**).
- The Electron-era tree at `94cb187^` (`git show 94cb187^:package.json`, `src/main/**`,
  `src/preload/**`) — what we had: electron 34, electron-vite 3, electron-builder 26, node-pty
  1.1, better-sqlite3, @xterm/addon-webgl. Much of `src/main` is directly revivable; say which.
- Orca (`stablyai/orca`, MIT): its main-process pty manager and worktree lifecycle — name the
  files worth lifting and what license notice that needs.

## Deliver

1. **Stage plan** with acceptance criteria per stage, each shippable behind the same renderer:
   - S0 shell over the renderer + real terminal (this is the spike — state what to keep from it)
   - S1 transcript tailer → `session:update` (+ chat store: SQLite via better-sqlite3 or keep
     the `~/.operator/chat.db` schema byte-compatible — it must read the existing DB)
   - S2 sessions/projects/folderprefs/agents/role defaults (on-disk formats unchanged —
     `~/.operator/{sessions.json,projects.json}`, `.claude/agents/*.md`)
   - S3 worktree (create/status/diff/commit/merge/discard/remove + reap dry-run), usage, plan
     limits, mcp, artifacts/report/task_status (the operator MCP control plane — how does the
     MCP server get spawned/located under Electron?), dispatch/reply tailing, quit guard,
     tray (+ `tray_anim`), dock icon, preview inspector via `<webview>`, drop guard
   - S4 packaging: electron-builder, hardened runtime + notarization with the existing Developer
     ID / App Store Connect key, `electron-updater` against `juanmnl/operator-releases`
   For each: Node libs, LOC estimate, risk, what has NO equivalent.
2. **Hand-off plan for installed users**: the Tauri updater only installs Tauri bundles. Options
   (pick one, justify): a final Tauri release whose only job is to show "download the new
   Operator" with a link; or serve the Electron `.app` inside a Tauri-updater-shaped payload
   (is that even possible? check the updater's install path); or accept a manual reinstall.
   Also: version numbering (stay 0.x or mark the shell change), and whether both shells can
   coexist on disk during the transition (bundle id, `~/.operator` sharing, localStorage origin).
3. **Repo shape**: where Electron code lives (`electron/` at root), what happens to `src-tauri/`
   (keep on a branch until S4 ships), CI matrix, test strategy (the 775 vitest tests stay; what
   replaces the 173 Rust tests), and the dev loop (`electron-vite dev` on the Operator-reserved
   `OPERATOR_DEV_PORT`, parity with `scripts/tauri.mjs`).
4. **Order of risk**: which stage most likely blows the estimate, and the cheapest early probe.

## Report shape

One page of stages first (table), then the details. Numbers and file names, not adjectives.
