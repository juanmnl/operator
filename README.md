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

Operator is a desktop app for running a *team* of Claude Code agents on one codebase. Give a project a roster of lanes — each with its own model, reasoning effort and optional git worktree — put work on its board, and watch every tool call and subagent live. Agents hand work to each other; you approve what gets commissioned and review the diff before it lands.

### The problem

You want to run several Claude Code sessions at once — one refactoring a module, one writing tests, one debugging a deploy script — and let each delegate to subagents. But each session lives in its own terminal: you're constantly switching between them, scanning for permission prompts, with no view of who delegated to whom, how long a tool ran, or what any of it cost. And running them in parallel against the same repo means they trip over each other's changes.

### What Operator does

**The work is the primary object.** You open a project and see its *board* — what's queued, what's running, what's blocked on you, what's done — not an org chart of idle agents. The team is one tab away, and it exists to get the board moving.

#### The project

- **A board, as project home.** Every project opens on a four-column board — **Backlog · Running · Waiting · Done**. Each column scrolls on its own, so a long Done list never pushes the live work off screen. Type a task, assign it to a lane, and send it; or queue it unassigned and decide later.
- **A team of agent lanes.** **Operator**, Research, Code, Review, Design, QA — each lane pins a model, a reasoning effort, an optional isolated worktree, and a standing charter. Drag to reorder, launch one or all. Live lanes show as full cards; idle ones collapse to a single launchable row, so a quiet project doesn't open on a wall of identical placeholders. The Operator lane knows the team and routes work to the best-suited lane, doing the job itself when none fits.
- **A moodboard.** Drop reference images straight onto a project-scoped board — kept beside the work rather than in another app.
- **Project-first navigation.** A persistent rail of your projects down the left edge; entering one scopes everything — sidebar, board, roster — to it. `Cmd+Shift+O` returns to the gallery, which lists every project and a cross-project activity view.

#### Delegation

- **Hand-offs that actually land.** An agent delegates with a single line — `OPERATOR-DISPATCH [lane] task`. Operator types it into that lane if it's running, or **launches the lane** with the task as its opening brief if it isn't, then tells the sender how it landed. Directives parse even when the model wraps them in bullets or backticks, and submissions are spaced and nudged so they can't merge into one draft or strand half-typed in a composer.
- **An authority gate, per dispatch.** Work an agent commissions from another agent lands in **Waiting** for you to **Approve** or **Decline** — explicit, one card at a time. No approve-all and no timeout: a timeout that approves is not a guardrail, and one button that approves eleven things is how you commission work you never read.
- **A visible outcome for every hand-off.** Delivered, held, declined, or sitting unread in a lane that never started — each dispatch is logged with the outcome it actually got, and a card whose lane isn't running takes you to the roster to start it.
- **A kill switch for agent chatter.** Agent-to-agent delivery can be paused from the team screen — reachable *during* an incident, next to the lanes whose traffic it stops.

#### Watching the work

- **A live operations timeline.** Each session's tool calls and subagent delegations as they happen — nested by who-spawned-whom, with a live-ticking duration on the in-flight tool and elapsed time on finished ones. Reconstructed straight from Claude Code's own transcripts, so it needs nothing installed.
- **Three ways to watch one session.** **Console** (the real terminal), **Chat** (a document-style read of the conversation, with its own composer), and **Preview** — a live view of the app the session is building. The preview's port is *attributed*, never guessed: Operator reserves a port per working directory and reads the URL the session itself prints, so a sibling agent's dev server on `:5173` can never be shown as this one's app. A picker appears when a session serves several.
- **Annotate what you see.** Drop pins and boxes on the preview, or inspect a real element down to `component@file:line`, and send either straight to the agent or into the task queue.
- **A side panel that follows the work.** **Plan** and **Diff** beside any session, resizable, without leaving the surface you're on.

#### The repo

- **Isolated worktrees + fan-out.** Run several agents against one repo in parallel — each gets its own git worktree, so their changes never collide. Fan a single task across N parallel agents, each badged so the group reads at a glance.
- **In-app diff review.** See a session's changes in a built-in diff viewer, then **Commit**, **Merge** back to your base branch, or **Discard** — no terminal required.
- **Tasks with provenance.** Every task carries who ran it, where, and the diff it produced — with an optional check command (`npm test`) that has to go green before it reads "done".

#### Around the edges

- **An agent library with per-task models.** A visual editor over your `.claude/agents/*.md` — the headline being which model runs each agent (Haiku for extraction, Sonnet for general work, Opus for hard reasoning), with cost and speed hints at the point of choice.
- **A usage & cost dashboard.** Token-driven insight into what's driving your usage — high-context, subagent-heavy and long-running sessions — plus a `/usage`-style per-model breakdown: input/output/cache, cost, and API vs. wall time.
- **Never lose your place.** Open sessions are saved continuously to a crash-safe store; relaunch and pick up under "Continue where you left off" — **Resume** the exact conversation or reopen clean. Bring back a whole **project** in one action, every previously open agent continuing its conversation.
- **Drop & click.** Drop an image anywhere on the window to paste its path into the active session; click links in the terminal to open them in your browser.
- **Three themes, light and dark.** Mission Control, Mr Pink and 1984 — six palettes in all, every colour a semantic token, contrast measured rather than eyeballed.
- **Self-updating.** Tagged releases are signed, notarized and published automatically; the app checks on launch and offers a one-click "Install & Restart".
- **Command palette** (`Cmd+K`) and a menu-bar tray whose menu lists your active sessions and their live states.

### What Operator is not

It doesn't proxy your API traffic, doesn't wrap Claude Code in its own agent loop, and doesn't ask you to move your config. It **orchestrates** Claude Code — hosting the real CLI and reading the transcripts it already writes. A `claude` you run in any other terminal is completely unaffected, and if you quit Operator tomorrow your projects, agents and settings are exactly where Claude Code left them.

### How it works

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

### Install

Download the latest `.dmg` from **[operator-releases](https://github.com/juanmnl/operator-releases/releases/latest)** — signed and notarized, so it opens without a Gatekeeper warning. macOS on Apple Silicon.

Operator drives the `claude` CLI you already have, so [Claude Code](https://claude.com/claude-code) needs to be installed and logged in. Nothing else is configured, and nothing is installed into your projects.

Updates are automatic: the app checks on launch and offers a one-click **Install & Restart**.

### Quick start (from source)

```bash
npm install
npm run tauri dev   # or `npm run dev` for the frontend alone
```

Press `Cmd+N` (or click **+ New Session**) and pick a folder — that folder becomes a project. If it's a git repo, worktree isolation defaults on; bump **Agents** above 1 to fan the same task across parallel worktree agents.

You land on the project's **board**. Type a task, assign it to a lane, and send it — the lane launches if it isn't already running. **Team** is where you shape the roster: pin each lane's model, effort, worktree and charter, or add one. `Cmd+Shift+O` takes you back to every project.

### Development

```bash
npm test                       # unit tests (vitest)
cargo test --manifest-path src-tauri/Cargo.toml
npm run build                  # tsc + vite
```

The terminal is the hard part of this app, so it has its own harnesses. Each boots the
**production** xterm config in headless WebKit (the same engine family as the app's
WKWebView) rather than a stand-in:

| Command | Answers |
| --- | --- |
| `npm run verify:width` | Do xterm and Claude Code agree on every glyph's cell width? (A disagreement drifts the cursor and garbles scrollback.) |
| `npm run verify:dom` | Does the DOM renderer leave stale text under incremental writes? (Separates a renderer bug from a compositor one.) |
| `npm run verify:visual` | What do the symbol/emoji fallback paths actually render? |
| `npm run verify:input` | Do keystrokes reach the pty in order? |

`dev/` holds a mock `window.operator` bridge that boots the real renderer against
fixtures in a plain browser, so the UI can be driven and screenshotted without the Tauri
shell. Start a dev server (`npx vite --port 1440`) and run any of the `dev/drive-*.mjs`
scripts against it — each drives a real surface and asserts on the real DOM. It's
development-only: the production build declares its entry points explicitly, so `dev/`
is never bundled.

Two house rules that the drivers exist to enforce, both learned the expensive way:

- **A driver must be able to fail.** Every one exits non-zero on a failed assertion, and
  the way to earn that claim is to revert the fix and watch the driver go red before
  restoring it. A driver that has never failed is a driver that is asserting nothing —
  we have shipped one that read an empty screen and passed for two releases.
- **A fixture must not be kinder than reality.** A mock more generous than the real thing
  validates features that cannot work: a disclosure whose body was always empty, a
  dispatch button that had only ever been clicked on lanes that were running. When a
  driver can't reach a case, the fix belongs in the fixture, not in the assertion.

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
| `Cmd+K` | Command palette — sessions, but also Operator's own functions: switch surface, open Plan/Diff, launch a project's lane, start its queued backlog |
| `Cmd+N` | New session |
| `Cmd+W` | Close active session |
| `Cmd+B` | Collapse ⇄ expand the sidebar |
| `Cmd+J` | Console ⇄ Chat |
| `Cmd+E` | Preview: Interact ⇄ Annotate |
| `Cmd+Shift+O` | All projects (the gallery) — `Cmd+Shift+P` does the same |
| `Cmd+1`–`9` | Switch session |

Only these chords are Operator's; everything else — including plain `Cmd+O` and `Cmd+P` — goes to the terminal untouched.

### Stack

React 19 + Vite + Tailwind 4 frontend on a **Tauri 2 (Rust)** backend — `portable-pty` for the embedded terminals, xterm.js (DOM renderer) for the terminal surface, a transcript tailer that rebuilds the session timeline, and `serde`/`serde_yaml` for the agent library, projects, and the durable session store. The build produces a ~10 MB signed app.

### Brand & assets

All brand assets live under [`assets/`](assets/). The mark is a dot-matrix circle — a "frozen twinkle" (each dot a different size/opacity) — the same geometry the app animates live in the sidebar (`LogoMark`) and per-session status (`StatusWave`).

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

### License

Private
