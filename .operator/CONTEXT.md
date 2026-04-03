# Operator Project Context

## Architecture
- Electron 34 + React 19 + Tailwind 4 + Express + better-sqlite3 + node-pty
- Build: electron-vite with `externalizeDepsPlugin()` for main/preload
- Native modules: better-sqlite3, node-pty (rebuilt via postinstall: `electron-rebuild -f -w better-sqlite3,node-pty`)
- PNG imports only resolve at bundle time (not tsc) — pre-existing TS errors, safe to ignore
- Clean install requires `rm -rf node_modules package-lock.json && npm i` (rollup optional dep bug)

## Window System
- Two windows: main (900x600, titleBarStyle:hiddenInset) + widget (516x72, frameless, transparent, alwaysOnTop)
- Hash routing: `#/dashboard` (main window), `#/widget` (widget window)
- WindowManager (`src/main/window/window-manager.ts`) owns both refs
- Permission requests always go to main window; widget shows only when main is unfocused
- App shows in dock via `app.dock?.show()` + custom icon via `app.dock?.setIcon()`

## Terminal System
- PtyManager (`src/main/terminal/pty-manager.ts`) — spawns node-pty processes, each gets a UUID
- `OPERATOR_TERMINAL_ID` env var set on every pty for hook linkage
- TerminalRegistry (`src/main/terminal/terminal-registry.ts`) — bidirectional map terminalId <-> sessionId
- Agent launcher (`src/main/terminal/agent-launcher.ts`): `launchClaudeCode(ptyManager, cwd)` spawns `claude`
- Frontend: xterm.js with WebGL addon, fit addon, web-links addon, 6px padding
- Terminal spawns via IPC `terminal:spawn` which opens a folder picker then runs `claude`
- All terminal panes stay mounted (visibility:hidden for inactive) — switching never destroys state
- `onTerminalData`/`onTerminalExit` return unsubscribe functions for proper cleanup
- Inactive terminals get `cursorBlink: false` + `blur()`, active ones get `focus()` + `fit()`
- DnD: dropping files onto terminal pastes their file paths

## Sidebar
- Only shows sessions with a local terminal (external hook-only sessions are hidden)
- Sessions grouped by projectName (last folder segment of cwd)
- Multiple sessions in same project: "Session 1", "Session 2", etc.
- Double-click to rename — custom names stored in `DashboardView` state (`customNames` map by terminalId)
- Status dots derive from multiple signals:
  - Green (pulsing): running (phase from hooks)
  - Yellow (pulsing): waiting for permission (checks pendingRequests directly)
  - Cyan: compacting context
  - Red: error
  - Muted gray: idle
- CSS `@keyframes pulse` in styles.css

## UI Labels
- "Session" everywhere (not "Agent")
- Sidebar: "Session 1", "Session 2" / custom names
- Button: "+ New Session"
- Empty state: "No active sessions"
- Tray: "X active sessions"

## Themes
- Mr Pink (default): dark purple-gray bg (#22222A/#1E1E25), pink accent (#D58FDB)
- 1984: deep blue bg (#0d0f31/#070825), neon green/blue accents (#B3F361/#46BDFF)
- Applied via CSS custom properties on `:root` + xterm `ITheme`

## IPC Channels
- Permission: `operator:new-request`, `operator:respond`, `operator:get-queue`, `operator:get-sessions`, `operator:session-update`
- Terminal: `terminal:spawn`, `terminal:write`, `terminal:resize`, `terminal:kill`, `terminal:data` (push), `terminal:exit` (push), `terminal:list`
- Window: `operator:show-main-window`, `operator:hide-widget`

## Server
- Express on port 47821, bound to 127.0.0.1
- `POST /hook` — Claude Code hook events (blocking for PreToolUse, fire-and-forget for others)
- `POST /request` — legacy direct permission requests
- `GET /health` — status + pending count + session count
- Sessions reconciled every 2 minutes (10 min inactivity = ended)

## Hook Script
- `scripts/operator-hook.sh` — unified handler for all Claude Code hook events
- Injects `hook_event_name` from `$CLAUDE_HOOK_EVENT_NAME` and `terminal_id` from `$OPERATOR_TERMINAL_ID`
- Read-only tools (Read, Glob, Grep, Skill, ToolSearch, LSP) are forwarded non-blocking
- PreToolUse blocks up to 300s waiting for permission decision

## Known Issues / TODO
- Dock icon is low-res (64px PNG) and not rounded — need proper 512+ icon with baked-in rounded corners or .icns
- Custom session names don't persist across restarts (stored in React state only)
- Theme switching not yet exposed in UI (hardcoded to Mr Pink)

## Remaining Plan
- Phase 3: Split panes (PaneGrid recursive binary split tree, Cmd+D/Cmd+Shift+D/Cmd+W) + layout persistence (SQLite workspaces table)
- Phase 5: Auto-approve rule engine (`src/main/rules.ts`), keyboard shortcuts (Cmd+N new session, Cmd+1-9 switch)
- Agent interconnection in same folder (future — shared message bus or file-based coordination)
