<p align="center">
  <img src="assets/logos/icon-source.svg" width="120" alt="Operator" />
</p>

<h1 align="center">Operator</h1>

<p align="center">
  Mission control for working agents.
</p>

<p align="center">
  <em>You run the agents. Operator makes the work visible and steerable.</em>
</p>

---

Operator is a desktop app for orchestrating Claude Code. Define agents and the model each task runs on, launch sessions that delegate to them, and follow every tool call and subagent live — each in its own git worktree — approving or denying anything they touch, inline as they go.

### The problem

You want to run several Claude Code sessions at once — one refactoring a module, one writing tests, one debugging a deploy script — and let each delegate to subagents. But each session lives in its own terminal: you're constantly switching between them, scanning for permission prompts, with no view of who delegated to whom, how long a tool ran, or what any of it cost. And running them in parallel against the same repo means they trip over each other's changes.

### What Operator does

- **An agent library with per-task models.** A visual editor over your `.claude/agents/*.md` — the headline being which model runs each agent (Haiku for extraction, Sonnet for general work, Opus for hard reasoning), with cost/speed hints right at the point of choice.
- **A live orchestration timeline.** Watch each session's tool calls and subagent delegations as they happen — nested by who-spawned-whom, with a live-ticking duration on the in-flight tool and elapsed time on finished ones. Reconstructed straight from Claude Code's own transcripts, so it needs nothing installed.
- **Isolated worktrees + fan-out.** Run multiple agents on one repo in parallel — each gets its own git worktree, so changes never collide. Fan a single task out across N parallel agents, each badged so the group reads at a glance.
- **In-app diff review.** See each session's changes in a built-in diff viewer, then **Commit**, **Merge** back to your base branch, or **Discard** — no terminal required.
- **Inline permissions + auto-approve rules.** With Operator's (optional) hook installed, approve or deny an agent's action inline as it asks; one click on "Always" turns that decision into a standing rule.
- **A usage & cost dashboard.** Token-driven insights into what's driving your usage (high-context, subagent-heavy, and long-running sessions), plus a Claude-Code-`/usage`-style per-model breakdown — input/output/cache, cost, and API vs. wall time.
- **Drop & click.** Drop an image anywhere on the window to paste its path into the active session, and click links in the terminal to open them in your browser.
- **Never lose your place.** Open sessions are saved continuously to a crash-safe store; relaunch and pick up under "Continue where you left off" — **Resume** the exact conversation or reopen clean.
- **Command palette** (`Cmd+K`), themes, and a menu-bar tray showing your active-session count.

### How it works

Operator pins each session's id at launch (`claude --session-id <uuid>`) and tails its transcript to rebuild the timeline live — a pure observer of the sessions it starts, with **nothing installed and no global config**:

```
Operator  ──spawns──▶  embedded terminal  ──▶  claude --session-id <id>
                                                 │
                       writes ~/.claude/projects/<slug>/<id>.jsonl
                                                 │
              Operator tails it → live timeline (tools, subagents, phase, cost)
```

**Permissions are optional.** Install Operator's hook and it gates each tool use through an inline prompt:

```
Agent wants to run a tool → hook POSTs localhost:47821 → Operator holds it
                          → Inline prompt → You decide → Agent continues or stops
```

The hook only acts on sessions Operator started — it keys on the `OPERATOR_TERMINAL_ID` env var injected into each terminal. A `claude` you run yourself in iTerm or VS Code hits the hook but exits immediately, so Operator stays a session manager, not a machine-wide gateway. With no hook installed (or Operator not running) Claude Code works normally; you just don't get the inline approval gate.

### Quick start

```bash
npm install
npm run dev
```

Click **+ New Session**, pick a folder, and start. If the folder is a git repo, worktree isolation defaults on; bump **Agents** above 1 to fan the same task out across parallel worktree agents.

### Building a signed & notarized release

The build is configured to sign with the `Developer ID Application` identity in `src-tauri/tauri.conf.json` (hardened runtime + `entitlements.plist`). Signing happens automatically; notarization runs too if Apple credentials are present in the environment:

```bash
# one-time: generate an app-specific password at appleid.apple.com
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # app-specific password
export APPLE_TEAM_ID="UJS4C5GUCW"

npm run tauri build                           # signs, notarizes, and staples
```

Without those variables the build still produces a signed (un-notarized) `.app` + `.dmg` — fine for local use, but Gatekeeper will warn on other machines. App Store Connect API keys (`APPLE_API_KEY` / `APPLE_API_ISSUER` / `APPLE_API_KEY_PATH`) work as an alternative to the Apple ID variables.

### Keyboard

| Shortcut | Action |
| --- | --- |
| `Cmd+K` | Command palette |
| `Cmd+N` | New session |
| `Cmd+W` | Close active session |
| `Cmd+1`–`9` | Switch session |

### Stack

React 19 + Vite + Tailwind 4 frontend on a **Tauri 2 (Rust)** backend — `portable-pty` for the embedded terminals, a transcript tailer that rebuilds the session timeline, an optional `tiny_http` server for the permission hook, and `serde`/`serde_yaml` for rules, the agent library, and the durable session store. The build produces a ~10 MB signed app.

### License

Private
