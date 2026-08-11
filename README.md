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

<p align="center">
  <a href="#install"><img alt="macOS Apple Silicon" src="https://img.shields.io/badge/macOS-Apple%20Silicon-1d1d1f" /></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-blue" /></a>
  <a href="https://claude.com/claude-code"><img alt="Claude Code" src="https://img.shields.io/badge/requires-Claude%20Code-6b4fbb" /></a>
</p>

---

Operator is a macOS desktop app for running a *team* of Claude Code agents on one codebase. Give a project a roster of lanes — each with its own model, reasoning effort and optional git worktree — put work on its board, and watch every tool call and subagent live. Agents hand work to each other; you approve what gets commissioned and review the diff before it lands.

It **orchestrates** Claude Code rather than replacing it: it hosts the real CLI and reads the transcripts it already writes. Nothing is installed into your projects, no traffic is proxied, and a `claude` you run in any other terminal is completely unaffected.

> **Status:** built and used daily by its author, but young and single-maintainer. Expect rough edges. Issues and PRs welcome.

## Install

Download the latest `.dmg` from **[operator-releases](https://github.com/juanmnl/operator-releases/releases/latest)** — signed and notarized, so it opens without a Gatekeeper warning.

**Requirements:** macOS on Apple Silicon, and [Claude Code](https://claude.com/claude-code) installed and logged in. Operator drives the `claude` CLI you already have.

Updates are automatic — the app checks on launch and offers a one-click **Install & Restart**.

### From source

```bash
npm install
npm run tauri dev     # or `npm run dev` for the frontend alone
```

## First five minutes

Press `Cmd+N` (or **+ New Session**) and pick a folder — that folder becomes a project. If it's a git repo, worktree isolation defaults on; bump **Agents** above 1 to fan one task across parallel worktree agents.

You land on the project's **board**. Type a task, assign it to a lane, and send it — the lane launches if it isn't already running. **Team** is where you shape the roster: pin each lane's model, effort, worktree and charter, or add one. `Cmd+Shift+O` takes you back to every project.

## How it works

Operator is a **pure observer** of the sessions it launches — nothing installed, no global config, no machine-wide hooks. It pins each session's id at launch (`claude --session-id <uuid>`) and tails that session's transcript to rebuild the timeline live:

```
Operator  ──spawns──▶  embedded terminal  ──▶  claude --session-id <id>
                                                 │
                       writes ~/.claude/projects/<slug>/<id>.jsonl
                                                 │
              Operator tails it → live timeline (tools, subagents, phase, cost)
```

Permissions are handled by Claude Code itself in the terminal as usual; Operator doesn't intercept them.

Everything Operator knows about a session comes from that pipeline or from what it handed the session at launch — it never inspects another process. Dev-server ports, for example, are attributed from the port Operator reserved for that working directory plus the URL the session printed in its own output, then confirmed with a loopback connect. That's a deliberate constraint: reading another process's open files requires privileges macOS prompts for, repeatedly, and a background poll is the worst possible place to need them.

If you quit Operator tomorrow, your projects, agents and settings are exactly where Claude Code left them.

## What it does

**The work is the primary object.** You open a project and see its *board* — what's queued, running, blocked on you, done — not an org chart of idle agents. The team is one tab away, and it exists to get the board moving.

### The project

- **A board, as project home.** Four columns — **Backlog · Running · Waiting · Done** — each scrolling on its own, so a long Done list never pushes live work off screen.
- **A team of agent lanes.** Operator, Research, Code, Review, Design, QA — each pins a model, a reasoning effort, an optional isolated worktree, and a standing charter. Live lanes show as full cards; idle ones collapse to a launchable row. The Operator lane routes work to the best-suited lane, and does the job itself when none fits.
- **Lanes are scoped to a task, not to your session.** A lane that reports done closes itself after a keep-warm window; the next dispatch brings it back with `--resume`, same conversation, on the branch it left. Closing **detaches** — the thread stays resumable and its transcript readable. Silence is not success: a lane that never reports is closed by a backstop and its work marked **abandoned** rather than done.
- **Project-first navigation.** A persistent rail of projects down the left edge; entering one scopes sidebar, board and roster to it.

### Delegation

- **Hand-offs that land.** An agent delegates with one line — `OPERATOR-DISPATCH [lane] task`. Operator types it into that lane if it's running, or **launches the lane** with the task as its opening brief if it isn't, then tells the sender how it landed.
- **An authority gate, per dispatch.** Work an agent commissions from another lands in **Waiting** for you to **Approve** or **Decline**, one card at a time. No approve-all and no timeout: a timeout that approves is not a guardrail.
- **A visible outcome for every hand-off.** Delivered, held, declined, or unread in a lane that never started. The outcome is *observed*, not assumed — Operator watches the receiving session's transcript for the message it sent, so "delivered" means a turn actually began.
- **Lanes report through a tool, not prose.** A small MCP surface — `operator__report` hands a result to the coordinator directly, `operator__task_status` marks a task done or blocked at the moment it happens. The board stops inferring completion from the shape of a transcript.

### Watching the work

- **A live operations timeline.** Tool calls and subagent delegations as they happen, nested by who-spawned-whom, with live-ticking durations. Reconstructed from Claude Code's own transcripts, so it needs nothing installed.
- **Three ways to watch one session.** **Console** (the real terminal), **Chat** (a document-style read with its own composer), and **Preview** — a live view of the app the session is building, on a port that's *attributed* rather than guessed.
- **Annotate what you see.** Pins and boxes on the preview, or inspect a real element down to `component@file:line`, and send either to the agent or the task queue.
- **A side panel that follows the work.** **Plan** and **Diff** beside any session, resizable.

### The repo

- **Isolated worktrees + fan-out.** Each agent gets its own git worktree, so parallel changes never collide. Fan one task across N agents, each badged so the group reads at a glance.
- **A worktree lives as long as its task.** Resume a closed lane and it reattaches to the tree holding its committed work. Before any worktree is removed, uncommitted edits are committed first — and if that commit fails, the removal is cancelled rather than completed.
- **In-app diff review.** See a session's changes, then **Commit**, **Merge**, or **Discard** — no terminal required.
- **Tasks with provenance.** Every task carries who ran it, where, and the diff it produced, with an optional check command (`npm test`) that has to go green before it reads "done".

### Around the edges

- **An agent library with per-task models** — a visual editor over your `.claude/agents/*.md`, with cost and speed hints at the point of choice.
- **A usage & cost dashboard** — input/output/cache, cost, and API vs. wall time per model.
- **Never lose your place.** Open sessions are saved continuously to a crash-safe store; relaunch and **Resume** the exact conversation, or bring back a whole project in one action.
- **Three themes, light and dark** — Mission Control, Mr Pink and 1984; every colour a semantic token, contrast measured rather than eyeballed.
- **Self-updating**, plus a **command palette** (`Cmd+K`) and a menu-bar tray listing active sessions and their live states.

## Keyboard

| Shortcut | Action |
| --- | --- |
| `Cmd+K` | Command palette — sessions, and Operator's own functions |
| `Cmd+N` | New session |
| `Cmd+W` | Close active session |
| `Cmd+B` | Collapse ⇄ expand the sidebar |
| `Cmd+J` | Console ⇄ Chat |
| `Cmd+E` | Preview: Interact ⇄ Annotate |
| `Cmd+Shift+O` | All projects (the gallery) — `Cmd+Shift+P` does the same |
| `Cmd+1`–`9` | Switch session |

Only these chords are Operator's; everything else — including plain `Cmd+O` and `Cmd+P` — goes to the terminal untouched.

## Development

```bash
npm test                                        # unit tests (vitest)
cargo test --manifest-path src-tauri/Cargo.toml
npm run build                                   # tsc + vite
```

**Stack:** React 19 + Vite + Tailwind 4 on a **Tauri 2 (Rust)** backend — `portable-pty` for the embedded terminals, xterm.js (DOM renderer) for the terminal surface, a transcript tailer that rebuilds the session timeline, and `serde`/`serde_yaml` for the agent library, projects and durable session store. The build produces a ~10 MB signed app.

### Terminal harnesses

The terminal is the hard part of this app, so it has its own harnesses. Each boots the **production** xterm config in headless WebKit — the same engine family as the app's WKWebView — rather than a stand-in:

| Command | Answers |
| --- | --- |
| `npm run verify:width` | Do xterm and Claude Code agree on every glyph's cell width? (A disagreement drifts the cursor and garbles scrollback.) |
| `npm run verify:dom` | Does the DOM renderer leave stale text under incremental writes? (Separates a renderer bug from a compositor one.) |
| `npm run verify:ghost` | Does the fullscreen composer go stale in the DOM after a resize or a pane hide/show? |
| `npm run verify:visual` | What do the symbol/emoji fallback paths actually render? |
| `npm run verify:input` | Do keystrokes reach the pty in order? |

`dev/` holds a mock `window.operator` bridge that boots the real renderer against fixtures in a plain browser, so the UI can be driven and screenshotted without the Tauri shell. Start a dev server (`npx vite --port 1440`) and run any `dev/drive-*.mjs` script against it. It's development-only — the production build declares its entry points explicitly, so `dev/` is never bundled.

### Two house rules

Both learned the expensive way, and the drivers exist to enforce them:

- **A driver must be able to fail.** Every one exits non-zero on a failed assertion, and the way to earn that claim is to revert the fix and watch the driver go red before restoring it. A driver that has never failed is asserting nothing — we shipped one that read an empty screen and passed for two releases.
- **A fixture must not be kinder than reality.** A mock more generous than the real thing validates features that cannot work: a disclosure whose body was always empty, a dispatch button only ever clicked on lanes that were running. When a driver can't reach a case, the fix belongs in the fixture, not the assertion.

### Releases (maintainer)

Tagging `vX.Y.Z` builds, signs, notarizes and publishes automatically. Locally, the build signs with the `Developer ID Application` identity in `src-tauri/tauri.conf.json` (hardened runtime + `entitlements.plist`); notarization runs too if Apple credentials are present:

```bash
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # app-specific password
export APPLE_TEAM_ID="YOURTEAMID"

npm run tauri build                           # signs, notarizes, staples
```

Without those variables you still get a signed (un-notarized) `.app` + `.dmg` — fine locally, but Gatekeeper warns on other machines. App Store Connect API keys (`APPLE_API_KEY` / `APPLE_API_ISSUER` / `APPLE_API_KEY_PATH`) work as an alternative.

## Contributing

Issues and pull requests are welcome. Before a PR, please run `npm test`, `cargo test` and `npm run build` — and if you touch the terminal, the relevant `verify:*` harness. If you're changing behaviour a harness covers, make it fail first.

<details>
<summary><strong>Brand &amp; assets</strong></summary>

<br/>

All brand assets live under [`assets/`](assets/). The mark is a dot-matrix circle — a "frozen twinkle", each dot a different size and opacity — the same geometry the app animates live in the sidebar (`LogoMark`) and per-session status (`StatusWave`).

<table>
  <tr>
    <th align="left">Asset</th>
    <th align="center">Preview</th>
    <th align="left">Files</th>
  </tr>
  <tr>
    <td><strong>App icon</strong><br/>macOS app / Dock icon — cream rounded-rect, dark dot-circle.</td>
    <td align="center"><img src="assets/logos/icon-source.svg" width="72" alt="Operator app icon" /></td>
    <td><code>logos/icon-source.svg</code><br/><code>logos/icon-source.png</code> (1024²)<br/><code>logos/icon.icns</code></td>
  </tr>
  <tr>
    <td><strong>Sidebar mark</strong><br/>The dot-circle on its own, transparent. Light dots for dark UI, dark dots for light UI.</td>
    <td align="center">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="assets/logos/mark-128.png" />
        <img src="assets/logos/mark-light-64.png" width="64" alt="Operator sidebar mark" />
      </picture>
    </td>
    <td><code>logos/mark.svg</code> · <code>mark-light.svg</code><br/><code>logos/mark-64.png</code> · <code>mark-128.png</code><br/><code>logos/mark-light-64.png</code></td>
  </tr>
  <tr>
    <td><strong>Menu-bar tray icon</strong><br/>The dot-circle as a monochrome macOS template (auto light/dark).</td>
    <td align="center">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="assets/logos/mark-64.png" />
        <img src="assets/logos/mark-light-64.png" width="22" alt="Operator tray icon" />
      </picture>
    </td>
    <td><code>src-tauri/icons/tray.png</code> (the icon the app loads)</td>
  </tr>
  <tr>
    <td><strong>Status indicator</strong><br/>The six "thinking" shimmer frames behind the live session status.</td>
    <td align="center"><img src="assets/status-indicator/state-1.svg" width="36" alt="Operator status indicator" /></td>
    <td><code>status-indicator/state-1.svg</code> … <code>state-6.svg</code></td>
  </tr>
</table>

> The dot-circle mark is generated from the same algorithm as the in-app `LogoMark` (37 dots, deterministic frozen-twinkle weighting). The older bars-in-circle logo (`logos/logo.svg`, `logo-64.png`, `logo-light-64.png`, and the legacy `logos/trayTemplate*.png`) is retained for reference but no longer used in the UI.

</details>

## License

[MIT](LICENSE) © Juan Cornejo

Operator is an independent project. It is not affiliated with, endorsed by, or sponsored by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.
