<p align="center">
  <img src="assets/logos/logo.svg" width="120" alt="Operator" />
</p>

<h1 align="center">Operator</h1>

<p align="center">
  Mission control for working agents.
</p>

<p align="center">
  <em>You run the agents. Operator makes the work visible and steerable.</em>
</p>

---

Operator is a desktop app for orchestrating Claude Code. Define agents and the model each task should use, launch sessions that delegate to them, and follow every tool call and subagent live — each in its own git worktree — approving or denying anything they touch, inline as they go.

### The problem

You want to run several Claude Code sessions at once — one refactoring a module, one writing tests, one debugging a deploy script — and let each delegate to subagents. But each session lives in its own terminal: you're constantly switching between them, scanning for permission prompts, with no view of who delegated to whom, how long a tool ran, or what any of it cost. And running them in parallel against the same repo means they trip over each other's changes.

### What Operator does

- **An agent library with per-task models.** A visual editor over your `.claude/agents/*.md` — the headline being which model runs each agent (Haiku for extraction, Sonnet for general work, Opus for hard reasoning), with cost/speed hints right at the point of choice.
- **A live orchestration timeline.** Watch each session's tool calls and subagent delegations as they happen — nested by who-spawned-whom, with a live-ticking duration on the in-flight tool and elapsed time on finished ones.
- **Isolated worktrees + fan-out.** Run multiple agents on one repo in parallel — each gets its own git worktree, so changes never collide. Fan a single task out across N parallel agents, each badged so the group reads at a glance.
- **In-app diff review.** See each session's changes in a built-in diff viewer, then **Commit**, **Merge** back to your base branch, or **Discard** — no terminal required.
- **Inline permissions + auto-approve rules.** Approve or deny an agent's action inline as it asks. One click on "Always" turns that decision into a standing rule.
- **A usage & cost dashboard.** Token-driven insights into what's driving your usage (high-context, subagent-heavy, and long-running sessions), plus a Claude-Code-`/usage`-style per-model breakdown — input/output/cache, cost, and API vs. wall time.
- **Command palette** (`Cmd+K`), themes, session persistence/resume, and a native "needs approval" notification.

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
                                       Inline prompt → You decide
                                                 │
                                    Decision sent back → Agent continues or stops
```

Operator only acts on sessions it started — it identifies them by the `OPERATOR_TERMINAL_ID` env var injected into each terminal's environment. A `claude` you run yourself in iTerm or VS Code hits the hook but exits immediately, so Operator stays a session manager, not a machine-wide gateway. If Operator isn't running, the hook fails open and Claude Code works normally.

### Quick start

```bash
npm install
npm run dev
```

Click **+ New Session**, pick a folder, and start. If the folder is a git repo, worktree isolation defaults on; bump **Agents** above 1 to fan the same task out across parallel worktree agents.

### Building a signed & notarized release

The Tauri build (`tauri-spike/`) is configured to sign with the `Developer ID Application` identity in `src-tauri/tauri.conf.json` (hardened runtime + `entitlements.plist`). Signing happens automatically; notarization runs too if Apple credentials are present in the environment:

```bash
# one-time: generate an app-specific password at appleid.apple.com
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # app-specific password
export APPLE_TEAM_ID="UJS4C5GUCW"

cd tauri-spike && npm run tauri build         # signs, notarizes, and staples
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

React 19 + Vite + Tailwind 4 frontend. The backend is being migrated from Electron to **Tauri 2 (Rust)** — `portable-pty` for the embedded terminals, a `tiny_http` server for the blocking permission hook, and `serde`/`serde_yaml` for sessions, rules, and the agent library. The Tauri build (`tauri-spike/`) produces a ~10 MB signed app. The shared React renderer runs unchanged on both.

### License

Private
