# Operator — PRD
**Agent Permission Monitor & Notification Gateway**
Version 0.1 · March 2026

---

## 1. Problem

AI agents (Claude Code, MCP-connected tools, custom scripts) increasingly take actions on your filesystem, network, and toolchain autonomously. There is no standardized way to:

- See what an agent is about to do *before* it does it
- Grant or deny that action in real-time
- Maintain an audit log of what was approved and when

Users must either trust agents blindly or micromanage every step. Operator fills the gap: a lightweight desktop layer that puts the human back in control without breaking the flow.

---

## 2. Vision

> *"An agent asks. You decide. Everything moves on."*

Operator is a macOS desktop app (Electron) that sits in the background, exposes a local permission gateway, and surfaces a minimal floating UI whenever an agent needs approval. It should feel native, fast, and invisible until needed.

---

## 3. Goals

| Goal | Metric |
|------|--------|
| Near-zero friction for the user | Response action ≤ 2 clicks |
| Real-time blocking | Agent waits for response before proceeding |
| Framework-agnostic | Any agent that can make an HTTP request can integrate |
| Non-intrusive UI | Overlay visible only when there's a pending request |

**Out of scope (v1)**
- Mobile companion
- Cloud relay / multi-device sync
- Role-based access / team approvals
- Agent authentication (trust model is local-only)

---

## 4. Users

**Primary:** Individual developers running local AI agents (Claude Code, custom MCP servers, autonomous scripts).

**Secondary (future):** Small teams where one person monitors agents running on behalf of others.

---

## 5. Architecture

### 5.1 Overview

```
┌─────────────────────────────────────────────────┐
│                  AGENT PROCESS                  │
│  Claude Code / MCP tool / custom script         │
│                                                 │
│  POST http://localhost:47821/request            │
│  { id, agentId, action, context, severity }     │
└───────────────────┬─────────────────────────────┘
                    │ HTTP (long-poll)
                    ▼
┌─────────────────────────────────────────────────┐
│            OPERATOR — MAIN PROCESS              │
│  • Express server on port 47821                 │
│  • Request queue (FIFO)                         │
│  • ipcMain ↔ ipcRenderer bridge                 │
│  • Audit log (SQLite via better-sqlite3)        │
└───────────────────┬─────────────────────────────┘
                    │ ipcRenderer
                    ▼
┌─────────────────────────────────────────────────┐
│          OPERATOR — RENDERER PROCESS            │
│  • Frameless BrowserWindow, alwaysOnTop         │
│  • React + Tailwind notification widget         │
│  • Queue view (expandable)                      │
│  • History panel                                │
└─────────────────────────────────────────────────┘
```

### 5.2 Why HTTP Long-Poll (not WebSocket or Unix socket)

| Option | Pros | Cons |
|--------|------|------|
| **HTTP long-poll** ✅ | Universal — any language, any tool, curl works | Slightly higher latency (~50ms overhead) |
| WebSocket | Lower latency, bidirectional | Requires a WS client in every agent |
| Unix socket | Fastest, no port conflict risk | macOS/Linux only, harder to call from Python/JS |

**Decision:** HTTP long-poll on `localhost:47821`. The agent sends a `POST /request` and the server holds the connection open (up to 60s timeout) until the user responds. Simple, debuggable, curl-testable, language-agnostic.

An MCP tool wrapper (`operator_request`) will be provided so Claude Code can call it natively as a tool.

### 5.3 Request Lifecycle

```
Agent → POST /request
           ↓
     Queue receives request
           ↓
     ipcMain emits to renderer
           ↓
     Notification appears
           ↓
     User: Accept / Deny / Accept All / Modify
           ↓
     ipcRenderer → ipcMain → HTTP response released
           ↓
     Agent receives { approved: true/false, modifiedContext? }
           ↓
     Entry written to audit log
```

### 5.4 Request Schema

```json
{
  "id": "uuid-v4",
  "agentId": "claude-code | custom-agent-name",
  "action": "write_file | run_command | fetch_url | delete | ...",
  "message": "Human-readable description of what the agent wants to do",
  "context": {
    "workingDirectory": "/Users/juanmnl/Documents/Claude/uwazi_2026",
    "target": "src/ui/components/Detail.tsx",
    "preview": "Optional diff or payload preview"
  },
  "severity": "low | medium | high",
  "expiresIn": 60,
  "timestamp": "ISO-8601"
}
```

**Response:**
```json
{
  "approved": true,
  "modifiedContext": null,
  "respondedAt": "ISO-8601",
  "respondedBy": "user"
}
```

---

## 6. Features

### 6.1 Notification Widget (MVP)

The floating overlay that appears when a request arrives.

- Frameless, rounded, dark — positioned top-center of primary display
- Slides in from top with spring animation
- Shows: agent icon, working directory, message, proposed action
- Actions: **Accept** · **Deny** · **Accept All** (auto-approve queue)
- Disappears after response or timeout
- Stacks if multiple requests arrive (badge count on widget)

### 6.2 Request Queue

Accessible via menubar icon or keyboard shortcut (`⌥Space`).

- Full list of pending requests in order
- Each item expandable to show full context / diff preview
- Bulk actions: Accept All · Deny All
- Active countdown timer per request (shows time until auto-expiry)

### 6.3 History / Audit Log

- Persisted to SQLite in `~/Library/Application Support/Operator/`
- Filterable by: agent, action type, approved/denied, date
- Exportable as JSON or CSV
- Per-entry: full request object + response + timestamp

### 6.4 Auto-Rules (v1.1)

> Define conditions where Operator auto-approves or auto-denies without user input.

Examples:
- "Always approve read operations in `/Users/juanmnl/Documents`"
- "Always deny any `rm -rf` command"
- "Auto-approve all requests from `claude-code` during a 30-minute session"

Rules stored as JSON in user config. Applied before surfacing the UI.

### 6.5 MCP Tool Integration

A published MCP server (`@juanmnl/operator-mcp`) with one tool:

```
operator_request(action, message, context, severity)
→ { approved, modifiedContext }
```

This lets Claude Code call Operator natively, mid-task, without any extra agent-side code.

### 6.6 Menubar Presence

- Small icon in macOS menubar (active/idle state)
- Click to open history panel or pending queue
- Shows badge count when requests are pending
- Start/stop server toggle

---

## 7. UI Screens

| Screen | Description |
|--------|-------------|
| **Notification widget** | Floating overlay, primary interaction surface |
| **Queue panel** | Full list of pending requests, expandable |
| **History panel** | Audit log with filters |
| **Settings** | Port, auto-rules, startup behavior, agent trust list |
| **Onboarding** | First-run: install MCP tool, test connection |

---

## 8. Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Shell | **Electron + electron-forge** | Already in use, handles frameless windows + alwaysOnTop trivially |
| UI | **React + Vite + Tailwind** | Matches existing workflow |
| Local server | **Express** | Minimal, fast, HTTP long-poll works out of the box |
| IPC | **Electron ipcMain/ipcRenderer** | Native, no extra dependency |
| DB | **better-sqlite3** | Synchronous, no server, perfect for audit logs |
| MCP wrapper | **@modelcontextprotocol/sdk** | Standard MCP tooling |
| Packaging | **electron-builder** | DMG + auto-update |

---

## 9. File Structure

```
operator/
├── src/
│   ├── main/
│   │   ├── index.ts          # Electron main process
│   │   ├── server.ts         # Express HTTP gateway
│   │   ├── queue.ts          # Request queue manager
│   │   ├── ipc.ts            # ipcMain handlers
│   │   ├── db.ts             # SQLite audit log
│   │   └── rules.ts          # Auto-rules engine
│   ├── renderer/
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── NotificationWidget.tsx   # The Figma design
│   │   │   ├── QueuePanel.tsx
│   │   │   ├── HistoryPanel.tsx
│   │   │   └── SettingsPanel.tsx
│   │   └── hooks/
│   │       ├── useQueue.ts
│   │       └── useHistory.ts
│   └── shared/
│       └── types.ts          # Shared Request/Response types
├── mcp-server/               # Publishable MCP tool
│   └── index.ts
├── electron.vite.config.ts
└── package.json
```

---

## 10. MVP Scope

**Phase 1 — Core loop (build first)**
- [ ] Electron app with frameless overlay window
- [ ] Express server on port 47821
- [ ] `POST /request` → holds connection → resolves on user action
- [ ] Notification widget (faithful to Figma design)
- [ ] Accept / Deny actions
- [ ] Basic audit log to SQLite

**Phase 2 — Polish**
- [ ] Queue panel with multiple pending requests
- [ ] History panel with filters
- [ ] Stacking / badge count
- [ ] Request timeout + auto-deny
- [ ] Menubar integration

**Phase 3 — Power features**
- [ ] Auto-rules engine
- [ ] MCP tool wrapper (`@juanmnl/operator-mcp`)
- [ ] Diff/preview renderer for file operations
- [ ] Settings UI
- [ ] DMG packaging + auto-update

---

## 11. Open Questions

1. **Port conflict handling** — what if 47821 is taken? Fallback port or user-configurable?
2. **Agent identity** — should agents be able to register themselves with a name/icon, or is `agentId` just a string passed in the request?
3. **Timeout behavior** — auto-deny after 60s, or auto-approve? (auto-deny is safer default)
4. **Multi-monitor** — should the widget always appear on primary display, or follow the active window?
5. **Modify action** — v1 has Accept/Deny only; how complex should the "modify context" flow be?

---

*Next step: scaffold the Electron project and build the notification widget from the Figma design.*
