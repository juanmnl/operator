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

Operator is a desktop app for running and managing parallel Claude Code sessions. Launch agents against any project, watch what each one is doing, approve or deny their actions without switching windows, and review and merge their work — all from one place.

### The problem

You want to run several Claude Code sessions at once — one refactoring a module, one writing tests, one debugging a deploy script. But each lives in its own terminal: you're constantly switching between them, scanning for permission prompts, losing track of which agent is blocked. And running them in parallel against the same repo means they trip over each other's changes.

### What Operator does

- **Launch sessions from one window.** Pick a folder, configure the agent (effort level, permission mode, MCP), and start. Each session runs in its own embedded terminal, grouped by project.
- **A notification pill** floats over whatever app you're in when an agent needs a decision. Approve or deny without leaving what you're doing.
- **Isolated worktrees per session.** Run multiple agents on the same repo in parallel — each gets its own git worktree, so their changes never collide.
- **In-app diff review.** See each session's changes in a built-in diff viewer, then **Commit**, **Merge** back to your base branch, or **Discard** — no terminal required.
- **Auto-approve rules.** One click on "Always" turns a permission decision into a standing rule. Manage them in the rules view.
- **An activity dashboard** with live status for every session — running, waiting, compacting, idle — plus a local audit trail of every action approved or denied.
- **Command palette** (`Cmd+K`), themes, and native macOS notifications.

### How it works

```
Operator  ──spawns──▶  embedded terminal  ──▶  claude
                                                 │
                          (OPERATOR_TERMINAL_ID set in the pty env)
                                                 │
                                    Agent wants to run a tool
                                                 │
                                    Hook fires → POST localhost:47821/hook
                                                 │
                                    Operator holds the connection
                                                 │
                          Notification pill / inline prompt → You decide
                                                 │
                                    Decision sent back → Agent continues or stops
```

Operator configures Claude Code's hooks automatically on launch. The hook only acts on sessions Operator itself started — it identifies them by the `OPERATOR_TERMINAL_ID` env var injected into each terminal's environment. A `claude` you run yourself in iTerm or VS Code hits the hook but exits immediately, so Operator stays a session manager, not a machine-wide gateway. If Operator isn't running, the hook fails open and Claude Code works normally.

### Quick start

```bash
npm install
npm run dev
```

Click **+ New Session**, pick a folder, and start. If the folder is a git repo, toggle **worktree** on to isolate the session's changes.

### Keyboard

| Shortcut | Action |
| --- | --- |
| `Cmd+K` | Command palette |
| `Cmd+N` | New session |
| `Cmd+W` | Close active session |
| `Cmd+1`–`9` | Switch session |

### Stack

Electron + React + Vite + Tailwind · Express · better-sqlite3 · node-pty

### License

Private
