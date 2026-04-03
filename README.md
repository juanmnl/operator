<p align="center">
  <img src="assets/logo.svg" width="120" alt="Operator" />
</p>

<h1 align="center">Operator</h1>

<p align="center">
  Mission control for your AI coding sessions.
</p>

<p align="center">
  <em>You run the agents. Operator keeps you in the loop.</em>
</p>

---

Operator is a desktop companion for developers who work with AI coding agents. It connects to every Claude Code process on your machine — whether you started it from Operator, iTerm, VS Code, or an SSH session — and gives you a single place to see what each agent is doing and to approve or deny their actions without switching windows.

### The problem

You're deep in work. You have Claude Code running in three terminals — one refactoring a module, one writing tests, one debugging a deploy script. Each one occasionally needs permission to write a file, run a command, or make a destructive change. You're constantly switching between terminals, scanning for prompts, losing context.

Or worse: you're in a completely different app — your browser, Figma, Slack — and an agent is blocked, silently waiting for you to notice.

### What Operator does

- **A notification pill** that appears over whatever app you're in when an agent needs a decision. Approve or deny without leaving what you're doing.
- **A session dashboard** showing all active agents grouped by project, with live status — running, waiting, compacting, idle.
- **An activity view** for external sessions — see the event timeline, current tool, and pending requests without hunting for the right terminal tab.
- **A local audit trail** of every action approved or denied.

### How it works

```
Any terminal (iTerm, VS Code, Operator, SSH)
  │
  claude (hooks auto-configured by Operator)
  │
  Agent wants to run a tool
  │
  Hook fires → POST http://localhost:47821/hook
  │
  Operator holds the connection
  │
  Notification pill / Inline prompt → You decide
  │
  Decision sent back → Agent continues or stops
```

Operator configures Claude Code hooks automatically on launch. Every `claude` process on your machine routes permission requests through Operator — no manual setup.

### Quick start

```bash
npm install
npm run dev
```

Launch a session from Operator with **+ New Session**, or run `claude` in any terminal — it appears in Operator automatically.

### Stack

Electron + React + Vite + Tailwind · Express · better-sqlite3 · node-pty

### License

Private
