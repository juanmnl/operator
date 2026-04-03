# Operator File Map

## Main Process (`src/main/`)
- `index.ts` — App entry. Creates WindowManager, PtyManager, TerminalRegistry. Inits DB, IPC, tray, server. Shows dock icon.
- `server.ts` — Express server on port 47821. Hook endpoint, legacy request endpoint, health check. Uses WindowManager for routing.
- `ipc.ts` — IPC handlers: permission respond, queue/session getters, terminal spawn/write/resize/kill/list. Terminal spawn opens folder picker then launches claude.
- `db.ts` — SQLite audit log (better-sqlite3). `audit` table with request/response JSON.
- `queue.ts` — In-memory request queue with timeout. Pending requests as promises.
- `sessions.ts` — In-memory session manager. Tracks phase (idle/running/compacting), subagents, tool activity. Links terminalId from hook events.
- `tray.ts` — System tray icon with context menu. "Show Operator", pending count, active sessions, quit.

## Window Management (`src/main/window/`)
- `main-window.ts` — Creates main BrowserWindow (900x600, hiddenInset titlebar, dark bg). Loads `#/dashboard`.
- `widget-window.ts` — Creates widget BrowserWindow (516x72, frameless, transparent, alwaysOnTop). Loads `#/widget`.
- `window-manager.ts` — Owns both window refs. Routes permission requests (main always, widget when unfocused). Controls visibility.

## Terminal Backend (`src/main/terminal/`)
- `pty-manager.ts` — Spawns/manages node-pty instances. UUID per terminal. OPERATOR_TERMINAL_ID env var. Forwards data/exit via IPC.
- `terminal-registry.ts` — Bidirectional map: terminalId <-> sessionId. Linked on first hook event with terminal_id.
- `agent-launcher.ts` — `launchClaudeCode(ptyManager, cwd)` — spawns `claude` command in pty with FORCE_COLOR=1.

## Preload (`src/preload/`)
- `index.ts` — contextBridge exposing `window.operator` API. Permission flow + terminal management + window control. onTerminalData/onTerminalExit return unsubscribe functions.

## Shared (`src/shared/`)
- `types.ts` — All interfaces: HookEvent (with terminal_id), OperatorRequest (with terminalId), AgentSession (with terminalId), ManagedTerminal, IPC channel constants.

## Renderer (`src/renderer/`)
- `main.tsx` — React root mount.
- `App.tsx` — Hash router: `/dashboard` -> DashboardView, `/widget` -> WidgetView. Applies theme on mount.
- `styles.css` — Tailwind import, reset, scrollbar styling, CSS variable theming, pulse keyframe animation.
- `env.d.ts` — TypeScript declarations for `window.operator` API (including unsubscribe return types) and PNG imports.

## Renderer Views (`src/renderer/views/`)
- `DashboardView.tsx` — Main layout: sidebar + terminal area. Manages terminal tabs (all stay mounted, visibility toggled). Merges hook sessions with local terminals. Tracks customNames and pendingRequests. Only shows local-terminal sessions in sidebar.
- `WidgetView.tsx` — Floating widget view. Shows NotificationWidget for permission requests.

## Renderer Components (`src/renderer/components/`)
- `NotificationWidget.tsx` — Pill-shaped permission widget with approve/deny buttons and "approve all".
- `terminal/TerminalPane.tsx` — xterm.js wrapper with WebGL, fit, web-links addons. 6px padding. Active prop controls focus/blur/cursorBlink. DnD drops file paths. Properly cleans up IPC listeners via unsubscribe.
- `terminal/InlinePermission.tsx` — Bottom bar overlay for terminal panes. Enter=approve, Escape=deny.
- `sidebar/Sidebar.tsx` — Left panel (220px). Project-grouped session list. Passes pendingRequests + customNames + localTerminalIds to items. "+ New Session" button.
- `sidebar/SessionItem.tsx` — Session row with smart status dot (green=running, yellow=waiting, cyan=compacting, red=error, gray=idle). Double-click to rename. Pulse animation for running/waiting.

## Themes (`src/renderer/themes/`)
- `mr-pink.ts` — Mr Pink theme: xterm ITheme + CSS custom properties.
- `1984.ts` — 1984 theme: xterm ITheme + CSS custom properties.
- `index.ts` — Theme registry, `applyTheme()` function, default = Mr Pink.

## Scripts
- `scripts/operator-hook.sh` — Claude Code hook handler. Injects hook_event_name + terminal_id. Forwards events to Operator server.

## Config
- `package.json` — deps, postinstall with electron-rebuild for better-sqlite3,node-pty
- `electron.vite.config.ts` — externalizeDepsPlugin for main/preload, react+tailwind for renderer
- `tsconfig.json` — references node + web configs
- `tsconfig.node.json` — main/preload/shared
- `tsconfig.web.json` — renderer/shared with JSX
