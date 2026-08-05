# Result — costing a stream-json channel alongside the pty

**Lane: Research. Read-only — no code changed.** Sources: local `claude --help` (CLI
2.1.220), three live probes against the real `claude` binary (captured JSONL kept at
`/private/tmp/.../scratchpad/stream-json-probe/raw_frames{,2,3}.jsonl`, outside this repo),
the persisted transcript those probes produced under `~/.claude/projects/...`, Comet's actual
Rust source (`crates/harness/src/claude/{mod,wire,normalize}.rs`, `crates/engine/src/{sessions,run_journal}.rs`,
`ARCHITECTURE.md`, `docs/research/harness.md` — cloned to scratch, not this repo), and our own
`src-tauri/src/transcript.rs`.

## THE QUESTION — answer

**Confirmed: no. One `claude` process cannot be both the interactive TUI and a stream-json pipe.**
`claude --help` documents `--output-format`/`--input-format stream-json` as "only works with
--print", and `--print` is documented as "Print response and exit" — headless by definition.
Comet's own spawn call proves the same conclusion from the other side: it always passes
`--print --input-format stream-json --output-format stream-json` together
(`crates/harness/src/claude/mod.rs:142-154`) — Comet never runs an interactive `claude` at all.

That resolves the brief's three options concretely: it's **(a) per-session choice** in practice,
but with a wrinkle worth naming — Comet doesn't actually implement "(a) or (c)" as a menu. It
picked **(c) unconditionally**: `comet-tui` (`crates/tui`) is a from-scratch ratatui renderer of
Comet's own structured engine state, not a wrapped `claude` interactive session
(`ARCHITECTURE.md:48-65`, "**One deliberate difference: the TUI never embeds an engine.**").
Comet never had "the terminal is the fidelity escape hatch" as a constraint, so it never had to
solve keeping both. For us, with that constraint intact, the only shape that fits is **(a):** a
lane is either a terminal lane (today's `zsh -ilc 'claude …'` pty) or a structured lane
(headless `--print` subprocess), chosen at spawn, never both for one live session. (b) is
confirmed dead on the same grounds the brief gives — the brief's own reasoning needed no
correction there.

## 1. The event surface

**Verified empirically against our own installed CLI (2.1.220), not just inferred from Comet.**
Probe transcript (haiku, Bash tool, one turn) at `raw_frames3.jsonl`, frame types seen match
Comet's inventory exactly: `system` (`init`, `status`, `thinking_tokens`), `stream_event`
(`message_start/stop`, `content_block_start/delta/stop` with `text_delta` / `thinking_delta` /
`signature_delta` / `input_json_delta`), `rate_limit_event`, `assistant`, `user` (carries
`tool_result` blocks), `result`.

**The load-bearing finding:** the brief asks whether stream-json's `thinking`/`tool_result`
richness differs from what the jsonl transcript gives us today (which our memory records as
"thinking always empty, tool_result ~35KB p90/620KB max"). It does not differ — **because it is
the same data.** I ran the same session two ways and diffed them:

- Live stream-json capture of a 3-turn haiku session (`raw_frames3.jsonl`): real thinking text
  streamed in `thinking_delta` frames ("The user is asking me to run exactly...", full
  sentences, not empty), and the `user`/`tool_result` frame carried the literal Bash output
  (`"content": "hello-stream-json-probe"`).
- The **persisted jsonl transcript** for that exact session id
  (`~/.claude/projects/.../100a00e1-....jsonl`) has the identical thinking prose and the
  identical tool_result content, verbatim.

They match because they're the same underlying event stream — Claude Code writes the transcript
file from the same internal loop that emits stream-json frames, regardless of which interface
(pty TUI, `--print` stream-json) is driving it. **I also confirmed the headless `--print`
runs still write the normal `~/.claude/projects/<slug>/<uuid>.jsonl` file** (four such files
appeared from three probe runs) — stream-json is not a replacement data source, it's an
additional live view onto the same one `transcript.rs` already tails.

**Where it gets model/effort-dependent, and this is the surprising part:** a second probe
(`raw_frames.jsonl`, opus-5, `--effort high`) streamed **empty** `thinking_delta` text —
literally `""` — with only a cryptographic `signature` and `thinking_tokens` estimated-count
frames alongside it. A third probe (sonnet, `alwaysThinkingEnabled: true`) emitted no thinking
block at all. So "thinking always empty" in our memory note is very likely a **model/effort
artifact of the sessions we've actually run**, not a jsonl-vs-stream-json artifact — switching
transport would not fix it, because both transports read off the identical model output. If a
lane's thinking is empty today in the transcript, it would be equally empty in stream-json.

Subagent/Task activity: present via `parent_tool_use_id` on `stream_event`/`assistant`/`user`
frames (non-null = belongs to a subagent's nested stream) — Comet filters on exactly this field
(`normalize.rs:191-192,214-216,244-245`). Our tailer's equivalent is the jsonl's `caller` field
on `tool_use` blocks plus sidechain transitions (`transcript.rs:247-258`, tested at
`transcript.rs:1082-1090`). Same information, different field name, because — again — same
underlying source.

**Net:** the event surface is not richer over stream-json. What's different is *delivery
shape* — a live framed IPC stream with a request/response control channel, vs. a file you poll
and reparse — not content.

## 2. The control protocol

**Real, and it's the one part of this that genuinely doesn't exist in our current pty
approach.** `--permission-prompt-tool stdio` is a working, present flag on our installed CLI —
I confirmed it directly (not just via Comet's citation): `claude --print --input-format
stream-json --output-format stream-json --verbose --permission-prompt-tool stdio` runs cleanly
against 2.1.220 and routes tool-permission decisions onto the stdio control channel. Notably
**this flag is undocumented** — it does not appear in `claude --help` output at all, only
discoverable by testing it (matching Comet's own note: "Input side de facto stable but
undocumented (claude-code#24594)" in `docs/research/harness.md:37`). That's a real risk: we'd
be building on an interface the CLI doesn't publish, same as Comet is.

Protocol shape (confirmed structurally in my probes and in Comet's parser
`crates/harness/src/claude/wire.rs:146-163`, `mod.rs:627-664`): the CLI sends
`{"type":"control_request","request_id":...,"request":{"subtype":"can_use_tool","tool_name":...,
"input":...}}` on stdout; the client replies on stdin with
`{"type":"control_response","response":{"subtype":"success","request_id":...,
"response":{"behavior":"allow"|"deny","updatedInput"|"message":...}}}`. `AskUserQuestion`
arrives through this exact same `can_use_tool` channel (Comet special-cases the tool name to
intercept it and round-trip a UI question, `mod.rs:639-663`) — there is no separate
"ask the user" protocol message; the CLI treats a question as a permission check on a
pseudo-tool. Interrupt is a `control_request` too (`{"request":{"subtype":"interrupt"}}`,
`wire.rs:250-257`), with SIGTERM→SIGKILL escalation as the fallback if the CLI doesn't wind
down (`mod.rs:524-539` — sensible, and something we'd need regardless of transport for a
stuck headless child).

This is the one capability genuinely missing from our current design end-to-end — not just
"missing a UI," missing *any* hook to receive it. A pty-driven lane today has no channel for
"the CLI is asking something" other than the terminal itself rendering the interactive prompt
for the human to answer by typing — which is why, per project memory, "a running lane
currently looks idle in chat with no interrupt anywhere." Structured mode is the only one of
the options that gets us this without inventing our own protocol.

## 3. Resumption

Comet's resume is a thin layer over the exact same primitive we already use, not a different
mechanism: it stores the harness-native `session_id` per `(chat_id, cwd)`
(`crates/engine/src/sessions.rs:700-761`), and injects `--resume=<id>` on the next dispatch
unless the caller already supplied one (`sessions.rs:279-286`, mirrored in
`crates/harness/src/claude/mod.rs:183-185`). If the CLI rejects an engine-injected resume id, it
retries once as a fresh session rather than surfacing the failure
(`sessions.rs:1063-1094`, comment: "engine-injected resumes are retried fresh — a
caller-specified resume fails loudly"). That's the entire "resume" primitive — identical in
kind to our own `--session-id <uuid>` at spawn plus (implicitly) `--resume`/`--continue`
semantics available on the same CLI.

What Comet adds *on top* of that, and what would be genuinely new work for us, is the **run
journal** (`crates/engine/src/run_journal.rs`): a private, append-only `{seq, event}` JSONL
file per chat, separate from Claude's own transcript, whose purpose is crash recovery — on
boot, any journal whose last event isn't `Done` gets stamped `aborted` and (bounded by
`MAX_AUTO_RESUME`, tracked in a sibling `.resume` file so a crash-loop can't auto-revive
forever) optionally auto-resumed with the last prompt re-dispatched (`sessions.rs:454-571`).
This is *not* required to speak stream-json — it's Comet's answer to "the engine itself is a
daemon that can die mid-run and must self-heal," a problem that exists because Comet's engine
is a detachable, potentially-long-lived process independent of any UI. Our lanes today die with
the pty by design (per project memory, that's accepted as the current model) — so this whole
layer is optional scope, not a prerequisite, unless we also decide lanes should outlive the app.

**Bottom line:** resumption over stream-json costs us nothing new beyond what `--session-id`
already gives us. The crash-recovery journal is a separate, larger, genuinely optional feature
that only matters if we also want detach-not-close lane lifetimes — which is a bigger call than
this brief is asking about.

## 4. What we'd keep

Confirmed directly, not assumed:

- **`transcript.rs` (all 1469 lines) — unchanged.** A headless `--print --output-format
  stream-json` run still writes the identical `~/.claude/projects/<slug>/<uuid>.jsonl` file
  (verified: all three probe sessions produced one). Every structured lane would still be
  tailable exactly as today; the tailer doesn't need to know or care that a given session was
  also driven over a stdio control channel.
- **`chat.db`, worktrees, the dispatch sentinel loop, the roster** — none of these read the
  pty or stream-json directly today; they consume what `transcript.rs` already produces
  (`OPERATOR-DISPATCH`/`OPERATOR-REPLY` sentinel parsing is regex over assistant `text`/
  `thinking` content, `transcript.rs:751-842`) or the sessions/projects JSON stores. A
  structured lane's assistant text is available in full in `assistant` frames
  (`raw_frames3.jsonl` frame 15/73) exactly as it is in the transcript, so sentinel parsing
  transfers with no redesign — at most a second call site reading it live off stdout instead
  of only off the tailed file, if we wanted stream-json's lower latency for that specific path.
- **Every other lane in the app** — per option (a), a stream-json lane is opt-in per session;
  a flag on spawn, not a global switch. Terminal-mode lanes are byte-for-byte what they are
  today.

What's genuinely new, not a modification of something existing:
- A subprocess spawn path that isn't a pty (`tokio::process::Command`-equivalent on the Rust
  side we already have — this is a smaller lift than it sounds, since `src-tauri` is already
  Rust and already spawns processes for `terminalSpawn`).
- A JSONL framer/writer for the control channel (stdin writer + stdout line reader +
  request_id-keyed response routing) — Comet's version of this is `mod.rs:394-416` (stdin
  writer) + `mod.rs:433-543` (the `tokio::select!` event loop) + `wire.rs` (frame parsing) —
  roughly 550 combined lines for a fairly complete implementation with steering and interrupt
  handling included.
- A permission-prompt UI (approve/deny, and the `AskUserQuestion` panel) — this has no
  existing analog in Operator today (pty-mode permission prompts are answered by the human
  typing into the terminal, which is why "a running lane... [has] no interrupt anywhere" per
  project memory — that's specifically about *this* gap).

## 5. Cost of a one-lane spike

Rough, given the above is mostly reuse: **low-to-mid — on the order of a few engineer-days**,
not a rewrite, because the two most expensive pieces (transcript parsing shapes, session
resume) are both already solved and directly reusable — confirmed above, not assumed. Concrete
shape:
- Spawn path: new function alongside `terminalSpawn` that runs `claude --print
  --input-format stream-json --output-format stream-json --verbose --include-partial-messages
  --permission-prompt-tool stdio --session-id <uuid> [--resume=<id>]` as a plain child process,
  gated by a per-session flag (e.g. `sessionKind: "terminal" | "structured"` in
  `sessions.json`) so only one lane opts in behind a flag, everything else spawns exactly as
  today.
- Framing: stdin line writer + stdout line reader + `request_id` → pending-response map. Small,
  mechanical, same shape as Comet's (~550 lines there; likely less for us since we don't need
  Comet's steering-mailbox generality for a single-lane spike).
- Minimal permission UI: one modal/panel for `can_use_tool` (approve/deny) and one for
  `AskUserQuestion` (already has design precedent — Comet's is a paged QuestionPanel, but a
  spike can start with a plain list).
- Reuse, not new: transcript tailing for the actual chat content (unchanged), `--session-id`
  for identity, `chat.db`/dispatch loop (unchanged).
- Explicitly out of scope for a spike, per point 3: the run journal / crash-auto-resume layer.
  A spike lane can simply die with its process like a terminal lane does today — no new
  lifecycle model required to prove the concept.

Multi-provider: this doesn't change its cost either way. Both interfaces (pty, stream-json) are
still Claude-Code-specific; a structured lane is exactly as single-provider as a terminal one.

## Recommendation

Do the one-lane spike, scoped exactly to point 2: get `can_use_tool`/`AskUserQuestion` working
end-to-end for a single flagged lane, with the terminal untouched everywhere else. That's the
only piece of this brief that's actually new capability — the event-surface question the brief
was most worried about turned out to be a non-issue (verified, not assumed: stream-json and the
jsonl transcript are the same data, because they're written by the same process from the same
loop), and resumption is already solved by the primitive we have. The risk worth naming going
in: `--permission-prompt-tool` is undocumented CLI surface, same footing Comet is on, so this is
a bet on an interface Anthropic could change without notice — worth a version pin and a
capability probe at spawn, not a blocker. I would not chase the run journal / detach-lifetime
work off the back of this brief; that's a separate, larger decision (do lanes outlive the app?)
that this investigation wasn't asked to make and shouldn't be smuggled in via "while we're
adding stream-json anyway."
