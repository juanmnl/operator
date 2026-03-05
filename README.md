<p align="center">
  <img src="assets/logo.svg" width="120" alt="Operator" />
</p>

<h1 align="center">Operator</h1>

<p align="center">
  Agent Permission Monitor & Notification Gateway
</p>

<p align="center">
  <em>An agent asks. You decide. Everything moves on.</em>
</p>

---

A lightweight macOS desktop app that sits between AI agents and their actions. When an agent wants to do something — write a file, run a command, fetch a URL — Operator surfaces a minimal floating widget so you can approve or deny in real-time.

### How it works

```
Agent (Claude Code, MCP tool, script)
  │
  POST http://localhost:47821/request
  │
  Operator holds the connection
  │
  Widget appears → Accept / Deny
  │
  Response sent back to agent
```

### Quick start

```bash
npm install
npm run dev
```

Test it:

```bash
curl -X POST http://localhost:47821/request \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "claude-code",
    "action": "write_file",
    "message": "Update the server config to enable CORS",
    "context": { "workingDirectory": "/your/project" },
    "severity": "medium",
    "expiresIn": 60
  }'
```

### Stack

Electron + React + Vite + Tailwind · Express · better-sqlite3

### License

Private
