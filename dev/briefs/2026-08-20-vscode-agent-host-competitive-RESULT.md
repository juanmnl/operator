# Result — VS Code's Agent Host: how close is it to Operator's job?

**Verdict:** Worried, not panicked. Structurally, AHP's Agent Host is the same bet Operator is
making — a dedicated process hosting harnesses (Claude included) that multiple clients can attach
to, with a client-facing tool for one session to spin up and message another. It shipped in VS
Code 1.129 (2026-07-15) and is already at "send a message to a session it created, to kick off or
steer that work" (1.129 release notes) — the same shape as `OPERATOR-DISPATCH`. But it is still
N-chats-side-by-side wearing an orchestration coat: no board/fleet view, no roles, and the
dispatch tool is a per-agent utility buried in a chat window, not a product surface. **The one
thing to steal**: AHP's reconnect model — "immutable state, pure reducers, ordered actions; on
drop the client reconnects and gets missed actions or a fresh snapshot" — is a cleaner shape than
Operator's jsonl-tailing for surviving a renderer respawn (see `project_chat_markdown_freeze.md`
on the hourly WebContent kill). Everything else here is corroborated by 2-4 primary/near-primary
sources; flagged inline wherever it rests on secondary reporting only.

---

## 1. What is AHP concretely?

**Agent Host Protocol (AHP)** is an open, MIT-licensed, agent-agnostic protocol between a *host*
process and its *clients* — published by Microsoft at `microsoft.github.io/agent-host-protocol`
and `github.com/microsoft/agent-host-protocol` (fetched 2026-08-20).

- **Transport**: JSON-RPC. Local IPC uses a message port; remote connections use JSON-RPC over
  WebSocket (`code.visualstudio.com/docs/agents/concepts/agent-host`, fetched 2026-08-20).
- **Message shape**: immutable state with pure reducers. Each client subscribes to URI-addressed
  channels (sessions, chats, terminals, changesets), gets an initial snapshot, then a stream of
  ordered actions with monotonic sequence numbers; the host broadcasts each mutation to every
  subscribed client; on a dropped connection the client reconnects and receives missed actions or
  a fresh snapshot (same source; corroborated by the protocol repo's write-ahead-reconciliation
  description).
- **Who hosts whom**: VS Code (or any AHP-speaking client) connects to an Agent Host process. The
  host "can run as a local utility process or as a standalone server on a remote machine" — `code
  agent host` starts one directly, defaulting to a localhost server protected by a connection
  token (same source). So it is genuinely host/client-separated, not VS Code spawning a harness
  as a child it owns exclusively — a session "can continue when no editor or other client is
  connected."
- **Open/specified/published**: Yes. MIT license, spec + client SDKs (Rust, TypeScript, Kotlin,
  Go, Swift) in the repo, VS Code referenced in the repo's own docs as "the reference AHP server
  implementation" (`github.com/microsoft/agent-host-protocol`, fetched 2026-08-20). Actively
  developing, not frozen — 1.134's release notes (2026-08-19) still describe it as "actively
  developing."
- **Relationship to ACP**: Documented explicitly by Microsoft at
  `microsoft.github.io/agent-host-protocol/guide/ahp-and-acp` (fetched 2026-08-20, via search
  synthesis — recommend a direct fetch if this distinction matters for a design decision): ACP
  (Zed's protocol) defines client↔single-agent communication (init, prompts, streaming, tool
  calls, permissions). AHP solves a different, layered-above problem — coordinating **N clients**
  over **shared** agent sessions, with authoritative host state. Their own framing: "AHP is a
  coordination layer. ACP is a communication layer... An AHP host implementation can use ACP as
  its agent backend protocol." Not competitors, not the same thing — AHP is one level up.
- **Relationship to Anthropic's Agent SDK**: separate axis entirely — AHP is transport/coordination,
  the Agent SDK is what runs *inside* one of the adapters (see Q2). No source found equating them.

## 2. How does Claude run inside it?

**Claude Agent SDK**, not the Claude Code CLI's pty and not an Anthropic-authored VS Code
extension repurposed. `code.visualstudio.com/docs/agents/run/agent-harnesses` (fetched 2026-08-20):
"Claude sessions utilize Anthropic's Claude Agent SDK and operate autonomously on your workspace.
VS Code integrates the harness through its SDK while maintaining session management and code
review within the editor itself." The architecture doc's framing is consistent: "first-party agent
adapters run inside the Agent Host process" — Copilot, Claude, and Codex are three adapters inside
one host process, Claude's adapter wraps the Agent SDK rather than shelling out to `claude` as a
subprocess the way Operator does today.

**Who wrote the adapter**: not stated explicitly in what I fetched. The Copilot side is
attributed to the `@github/copilot-sdk` npm package by name; the Claude side is attributed to
"Anthropic's Claude Agent SDK" by name but I did not find a source saying which org wrote the
*glue* connecting that SDK to AHP's session model. Treat "did Anthropic ship the adapter or did
Microsoft" as **unconfirmed**.

**Auth / subscription pass-through**: confirmed, and this took an iteration to get right. As of
the current docs, the Claude harness supports two paths side by side: (a) sign in to GitHub,
"billed through your Copilot subscription," or (b) "an existing Claude configuration with an
Anthropic API key or Claude Code OAuth token — usage is billed by Anthropic," and Claude "can
operate without signing in to GitHub" on that path (same agent-harnesses doc). This matters because
it wasn't always so: `github.com/microsoft/vscode` issue #314952 (fetched 2026-08-20) is a user
complaint that the model picker showed "Claude Agent" but it silently billed through Copilot
quota regardless, costing them ~$300 unexpectedly. That issue is marked Done against milestone
1.128.0, i.e. fixed the release before the Agent Host shipped in 1.129. Net: a user's existing
Claude Code OAuth token does carry through today, but it's opt-in/explicit, not the only path, and
it burned at least one user before it was.

**What this means for Operator's transcript-tailing**: no evidence of a more "official" channel —
AHP's session/chat/action stream is the equivalent of Operator's jsonl tail, just standardized and
reconnectable, and it's Microsoft's model, addressed at VS Code as a client. There's no signal
Anthropic is pushing this as *the* way to observe a Claude session outside VS Code.

## 3. Multi-agent orchestration: does it exist there at all?

**More than "no," less than a real orchestrator — this is the finding to take most seriously.**
1.129's release notes (`code.visualstudio.com/updates/v1_129`, fetched 2026-08-20) state, verbatim:

> "Agents running on the agent host (Copilot, Claude, and Codex) now have access to a suite of
> session-management tools, so an agent can enumerate, create, observe, and act on other sessions
> and chats without you needing to switch away from your current conversation."

Concretely, as *tools available to the agent itself* (not just UI a human clicks):
- **List** sessions with status, workspace, and changes, "so it can find the right one to act on."
- **Read** another session's recent conversation "to understand what it's doing."
- **Create** a new session or a new chat within an existing session "to hand off a sub-task."
- **Send** a message to a session or chat it created, "to kick off or steer that work" — gated:
  "Sending a message to another session always asks for your confirmation first."

That confirmation gate is the same shape as Operator's rule that a dispatch *from* a lane is held
for the user to approve rather than auto-delivered. So the primitive Operator is betting on
(agent-initiated cross-session dispatch, human-gated) already exists in VS Code, shipped, not
speculative.

What's still missing, confirmed by absence across the 1.129/1.130/1.134 notes and the Agents
Window doc (`docs/agents/run/agents-window`, fetched 2026-08-20):
- **No board/fleet view.** The Agents window is a session list (compact rows for quick chats,
  richer rows for project sessions) plus a detail pane — closer to Operator's rail than to a
  Backlog/Running/Waiting/Done board (see `project_work_not_orgchart.md`). No status board
  concept found anywhere in the docs searched.
- **No roles/lanes concept.** Sessions are undifferentiated by harness + workspace, not by a
  named role a human assigns work to.
- **"Subagents" are read-only follow-along chats** ("read-only subagent chats," arranged
  side-by-side per 1.134's side-by-side-chats feature), not autonomous peer sessions a parent can
  task and walk away from — the send-message tool above is the only route to that, and it's
  scoped to sessions/chats *it created*, i.e. a tree, not arbitrary lane-to-lane messaging.
- **Worktree isolation exists** (1.130, confirmed: "Agent harnesses running on the agent host
  support worktree isolation... now available across Claude and Codex harnesses, not just
  Copilot") — this is the one place VS Code is ahead of or level with Operator's own worktree
  work, worth a look from Code/Design if not already tracked.

Net: this is N chats side by side, now with an agent-callable primitive for one to spawn/steer
another under human confirmation — not fleet orchestration, no board, no persistent roles. The
wedge from `project_competitor_orca.md` ("depth, not fleet breadth") still holds against AHP for
the same reason it holds against Orca: presence of a primitive isn't a product built on it.

## 4. Is VS Code heading to the terminal / a CLI IDE?

**No source found for "VS Code in the terminal" as an IDE.** Two real things likely got
conflated into that impression, and it's worth naming both precisely:

- `code agent host` is a real CLI command, confirmed above — but it starts a **headless AHP
  server process**, not a terminal UI. It's infrastructure for remote/standalone hosting, not a
  TUI you'd sit in and use like `claude` or `vim`.
- **Claude Code itself** is "Anthropic's own terminal-native agent" (search synthesis, secondary
  sources) — a completely separate product from VS Code's Agent Host, and pre-existing; not new
  news and not VS Code becoming a terminal app.

No leak, announcement, or roadmap language about a `code` TUI or "VS Code in the CLI" surfaced in
searches targeted at exactly that phrase. Recommend telling the user the premise doesn't hold up
against primary sources as searched; if they have a specific tweet/article in mind, worth handing
it to Research directly to check against this finding rather than re-searching blind.

## 5. Could Operator host or be hosted?

**Operator could plausibly become an AHP client** — connect to a `code agent host` (or any AHP
host) and drive Claude/Codex/Copilot sessions through it instead of piping the Claude Code CLI in
a pty. That would trade Operator's own jsonl-tail/pty-transport plumbing for AHP's reconnect
model (ordered actions + snapshot recovery) — a real upgrade for the WebContent-respawn problem
(`project_chat_markdown_freeze.md`) since a AHP client reconnects and catches up cleanly instead
of needing to re-derive state from a transcript file. It would also mean giving up the CLI-level
control Operator currently has (custom `--append-system-prompt`, `--settings`, direct pty access
for raw terminal fidelity) in exchange for whatever surface AHP's session model exposes — and AHP
is still young enough ("actively developing," no 1.0) that pinning to it now is a bet on
Microsoft's model stabilizing the way Operator needs. **I would not switch transports today** —
the terminal-fidelity requirement (`project_terminal_research_v2.md`: DOM renderer, not
WebGL/canvas, because scrollback fidelity matters to this user) is exactly the kind of thing a
higher-level session-model protocol is likely to abstract away or degrade. But the send/create/
observe session-management tool family in Q3 is worth studying as a *design reference* for
Operator's own dispatch/report control plane regardless of transport — it's a shipped, human-gated
answer to almost the same problem `project_mcp_control_plane.md` is solving for.

Operator being *hosted the other direction* (an AHP client connecting in to observe/control an
Operator-run Claude session) is architecturally possible if Operator implemented an AHP host
interface, but nothing in what was researched suggests urgency here — no evidence any AHP client
other than VS Code exists yet ("Other clients" in the protocol repo lists AHPX and VS Code; AHPX
not investigated further, flagged as unconfirmed what it is).

---

## Sources (fetched 2026-08-20 unless noted)

- `code.visualstudio.com/docs/agents/concepts/agent-host` — architecture, transport
- `code.visualstudio.com/updates/v1_129` — 2026-07-15 release notes, Agent Host launch, session-management tools quote
- `code.visualstudio.com/updates/v1_130` — 2026-07-22 release notes, worktree isolation expansion
- `code.visualstudio.com/updates/v1_134` — 2026-08-19 release notes, side-by-side chats / prompt timeline / find-in-chat
- `code.visualstudio.com/docs/agents/run/agents-window` — Agents window UI, subagent chats
- `code.visualstudio.com/docs/agents/run/agent-harnesses` — Claude harness auth/SDK details
- `code.claude.com/docs/en/vs-code` — Claude Code's own VS Code extension docs (the *separate*, older extension — not the Agent Host adapter)
- `github.com/microsoft/agent-host-protocol` — license, SDKs, reference-implementation claim
- `microsoft.github.io/agent-host-protocol/guide/ahp-and-acp` — AHP vs ACP, reached via search synthesis rather than direct fetch; recommend a direct fetch before relying on the exact wording
- `github.com/microsoft/vscode` issue #314952 — Claude-harness billing-through-Copilot bug, fixed by milestone 1.128.0

**Not independently confirmed from a primary source** (flagged inline above, repeated here for
visibility): whether Anthropic or Microsoft wrote the Claude AHP adapter; the exact wording of the
AHP-vs-ACP guide (read via search-engine synthesis, not a direct page fetch); what "AHPX" is.
