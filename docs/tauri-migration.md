# Operator → Tauri 2 migration plan

## Why / what changes

Goal: keep Operator's React UI, replace the Electron/Node runtime with **Tauri 2 (Rust core + system WebView)**. Expected payoff vs Electron: bundle ~10MB (from ~250MB), idle RAM ~30–40MB (from ~200–300MB), faster startup. Cost: the entire Node *main* process is rewritten in Rust. The **renderer is ~95% reused** — the trick is a single adapter that re-implements today's `window.operator` API over Tauri `invoke()`/events, so the views don't change.

What is **reused unchanged**: every `src/renderer` component/view/theme/style, xterm.js, Vite build, `scripts/operator-hook.sh`, and all on-disk formats (`~/.operator/rules.json`, `.claude/agents/*.md`, `~/.claude/settings.json`, transcript JSONL). Data is portable, so a half-migrated app reads the same files.

## Renderer changes (small, mechanical)

- **`src/preload/index.ts` → `src/renderer/operator-bridge.ts`.** Today the preload exposes `window.operator.*` (see `src/renderer/env.d.ts` for the full surface). Re-implement that exact shape over Tauri: synchronous-ish calls → `invoke('cmd', args)`; event subscriptions (`onTerminalData`, `onTerminalExit`, `onNewRequest`, `onSessionUpdate`, `onFocusSession`) → `listen('event', cb)` returning the unlisten fn. Keep the method names/signatures identical so `DashboardView` etc. are untouched.
- **Terminal I/O.** `terminalWrite/Resize/Kill/Spawn` → invoke commands; `onTerminalData` → a Tauri event or [Channel](https://v2.tauri.app/develop/calling-frontend/#channels) per terminal streaming pty bytes. xterm.js stays as-is, including the `minimumContrastRatio` and wheel-scroll guards.
- **PNG/asset imports** keep working through Vite; no change.

## Backend: Node modules → Rust (the bulk of the work)

| Today (`src/main/...`) | Rust replacement | Notes |
|---|---|---|
| `terminal/pty-manager.ts` (node-pty) | `portable-pty` crate (or `tauri-plugin-pty`) | spawn/write/resize/kill; keep the rolling output buffer for replay |
| `terminal/agent-launcher.ts` | `std::process` args builder | keep the `zsh -ilc '<cmd>'` login-shell launch (the PATH fix) |
| `server.ts` (Express :47821, **blocking** `/hook`) | `axum`/`hyper` (or `tauri-plugin-localhost`) | **highest-risk piece** — see below |
| `queue.ts` (pending-request promises) | `tokio` oneshot channels keyed by request id | backs the blocking permission round-trip |
| `sessions.ts` (hook event state machine, activity timeline, subagents) | Rust struct + `Mutex`; emit `session-update` events | port the `recordEvent` switch + `nextPhase` + delegate/subagent tagging |
| `rules.ts` (`~/.operator/rules.json`, `evaluate`) | serde_json + glob | straight port |
| `tool-summary.ts` | straight port | pure logic |
| `worktree.ts` | `std::process` git | shell out to `git`, same commands |
| `agents.ts` (`.claude/agents/*.md`) | `std::fs` + `serde_yaml` | frontmatter parse/serialize |
| `usage.ts` (transcript cost) | `std::fs` + serde_json | per-line parse + pricing table |
| `folder-prefs.ts`, `hooks-config.ts` | `std::fs` + serde_json | `hookScriptPath()` → `process.resourcesPath` becomes a Tauri resource path |
| `db.ts` (better-sqlite3 audit) | `rusqlite` (bundled) | or drop — it's only an audit log |
| `tray.ts` | Tauri `tray-icon` | |
| `window/*` (main window only, after cleanup) | single Tauri window | hiddenInset titlebar; **no** transparent widget once the legacy pill is removed |
| native notifications, dock badge | `tauri-plugin-notification` (only if we keep the "agent done" ping) | otherwise dropped in cleanup |

### The blocking permission flow (de-risk first)

`operator-hook.sh` does a **blocking** `curl` to `/hook` and waits for `{"decision":"approve"|"deny"}`. In Rust: the HTTP handler creates a `oneshot` channel, stores the sender in a map keyed by a request id, emits a `new-request` event to the renderer, then `.await`s the receiver. When the user clicks approve/deny, the renderer `invoke('respond', id, value)` resolves the oneshot, and the handler returns the JSON. This is the single most important thing to prove works (it's the heart of the app).

## Pre-migration cleanup: drop the legacy notification-gateway

Operator began as "catch every Claude Code process and act on its permission prompts via a floating notification pill." That surface is now dead (we're an orchestration workspace). **Do this cleanup in the current Electron app first** — it removes whole subsystems so they never get ported to Rust, and it's lower-risk to do on the working app.

**Remove (legacy "catch & act"):**
- The **widget window** entirely: `src/main/window/widget-window.ts`, the `#/widget` hash route, `src/renderer/views/WidgetView.tsx`, `src/renderer/components/NotificationWidget.tsx`.
- `WindowManager` logic for it: widget creation/refs, `showWidget`/`hideWidget`, the "route the request to the widget when the main window is unfocused" path, and `activeSessionId`-based widget visibility.
- The **legacy `/request` HTTP endpoint** in `server.ts` (direct/curl/non-hook callers from gateway days). Keep `/hook` and `/health`.
- **Native OS notifications + dock badge** (`prefs.nativeNotifications`, the notification firing, dock-badge mirroring of the tray) — unless we keep a single "agent finished / needs you" ping (see note).
- Notification-reaction prefs: `nativeNotifications`, `autoFocusPending` in `OperatorPrefs`.

**Keep (now core to orchestration, not notification cruft):**
- The hook server `/hook` blocking permission flow — this is how Operator gates what agents do.
- The **in-session** `InlinePermission` bar and the auto-approve **rules engine**.
- Tray (useful), sessions tracking, everything else.

**One judgment call:** OS notifications *could* serve orchestration — a ping when a background/overnight agent finishes or needs approval. Options: (a) remove entirely, or (b) keep one minimal "agent done / needs you" notification and drop the rest. Decide before cutting.

**Copy:** the splash line still says "...approve or deny anything they touch — inline or from a notification pill." Drop the "or from a notification pill" clause.

Net effect on the migration: no widget window, no second WebView, no notification routing to port — a meaningfully smaller Rust surface.

## Phases (~4–6 weeks solo)

- **Phase 0 — spike / de-risk (3–5 days).** Scaffold `create-tauri-app` with the existing Vite/React frontend. Prove the two scary pieces only: (1) xterm.js ↔ `portable-pty` streaming `claude` launched via login shell; (2) the local HTTP server receiving a hook POST and completing a blocking approve/deny round-trip. If both work, the rest is grind, not risk.
- **Phase 1 — backend port (1.5–2 wks).** Port the table above to Rust commands + events. Reuse the on-disk formats so you can diff behavior against the Electron build.
- **Phase 2 — `operator-bridge.ts` (3–5 days).** Implement the `window.operator` surface over invoke/events. Goal: the React app runs unmodified.
- **Phase 3 — window / tray (2–3 days).** Single main window (the legacy widget is gone), tray, and the "agent done" notification only if kept.
- **Phase 4 — packaging + signing + notarization (3–5 days).** Redo signing in Tauri's bundler (Developer ID works); this is also the natural point to finally wire notarization.
- **Phase 5 — parity polish + test (~1 wk).** Walk every view against the Electron build.

## Risks / unknowns to validate in Phase 0

1. **Blocking hook round-trip** in async Rust (the oneshot pattern above).
2. **pty byte streaming** perf + UTF-8 chunk boundaries to xterm.js.
3. **Rust learning curve** if unfamiliar — the async + channel parts are where it bites.

(The macOS transparent always-on-top widget was the other big risk — removed by the pre-migration cleanup, so it's no longer a concern.)

## Recommendation

Do **Phase 0 first as a throwaway spike** before committing. It exercises the only two genuinely uncertain pieces (pty streaming + blocking hook server). If they come together in a few days, the migration is a known-shaped ~4–6 week grind with a fully reusable UI. If they fight back, stay on Electron — it already works and is signed.
