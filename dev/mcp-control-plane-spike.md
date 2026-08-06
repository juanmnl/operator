# Spike — should Operator's internals be an MCP server?

No code changed. Grounded in the current sentinel/file architecture (read directly, cited below)
plus doc-grounded MCP mechanics from `claude-code-guide` — flagged below where that research
carries real uncertainty, because the single most decision-relevant claim in it is one I could not
independently verify.

## Verdict (REVISED — Channels confirmed real, see appended section)

**Sequencing does not change — ship the lane→Operator half now, hold dispatch delivery — but the
reason for holding dispatch does.** Three of the four proposed tools (`report`, `task_status`,
`brief`) are pure lane→Operator calls: exactly the direction MCP is built for, and they replace
transcript-scraping / cross-worktree file-hunting with an unambiguous request-response, including
the one cause of the task-lifecycle leak already on record as *unfixable without a real completion
signal*. The fourth — dispatch — is no longer "impossible, protocol says so." Fetched directly
against `code.claude.com/docs/en/channels.md` and `channels-reference.md`: an MCP server genuinely
**can** push an event into an already-open session with no polling. That resolves the protocol-level
doubt the first pass raised, and it means a channel-based delivery would queue cleanly through
Claude Code's own turn-boundary mechanism instead of racing `submitQueue`'s pty bytes — a real fix
for the *mechanism* behind the reported incident. It still doesn't ship, for two separate reasons
this time: pushed events only apply **at the next turn boundary**, not mid-turn, so it still can't
interrupt a busy lane — the actual open gap — and any Operator-authored channel sits outside the
research-preview allowlist today, meaning `--dangerously-load-development-channels` and a
full-screen warning dialog on every launch. **Verdict: dev-prototype only, not shippable in a
released Operator today.** Full re-derivation in "Channels — verified" below.

## Per-fix table

| Fix | Verdict | Evidence |
|---|---|---|
| **Dispatch split gone** | **Confirmed for half, refuted as stated for the reported incident.** | The 2026-07-30 incident (`dev/briefs/dispatch-split-closed-loop.md`) is Operator **delivering into Code's already-busy pty** — `submitQueue.submit` racing `SUBMIT_NUDGE_MS`/`nudgeDelayFor` against a TUI slowed by system load (25 `claude` processes, load 4.01), not by message length (`submit-queue.ts:37-67`). MCP tool calls are agent-initiated only (§ push/pull below) — nothing changes for a message Operator still has to *push* into a live pty. A tool call removes the race only for the half a lane initiates itself (e.g. the lane calling `operator__dispatch` to hand Operator a request) — that leg is a real RPC with a response, no bracketed-paste, no timing guess. Delivering the resulting task **into** the target genuinely races exactly as today, unless the target lane is pull-based (adopts `operator__next_task()`), which has its own limits (below). |
| **Return path gone** | **Confirmed.** | Clean win, MCP-native direction. Today: a lane's chat answer is invisible to Operator; `*-RESULT.md` files sit in worktrees Operator can't reach (`agent-to-agent-delivery`/return-path evidence #3 in the brief). `operator__report(taskId, summary, artifacts[])` is the calling lane reaching Operator directly — the same shape as any tool call Claude Code already makes routinely, no cross-worktree path resolution involved. |
| **Brief distribution gone** | **Confirmed.** | Same direction and same win as above. Nine dispatches pointed at unreachable paths today because a brief is a file resolved relative to the *reading* lane's own worktree cwd (evidence #2). `operator__brief(name)` resolves by logical name against Operator's own store, not a filesystem path — worktree isolation stops being able to break it, by construction. |
| **Task-lifecycle leak "probably gone"** | **Confirmed — the strongest of the four.** | `fix-session-task-lifecycle-RESULT.md` found two causes, only one already fixed: (a) `terminalId` collision across restarts, fixed separately by keying on `claudeSessionId` — unrelated to MCP. (b), quoted verbatim from that result: *"Completion only fires when a lane DIES… there is no per-turn completion signal… **Not fixed here and not fixable by reconciliation**… Closing them needs a real completion signal."* `operator__task_status(id, 'done')` called from inside a turn **is** that signal, and it's a pure lane→Operator call — the direction MCP handles cleanly with no push/pull ambiguity at all. This is the one fix on the list that a prior, independent investigation already declared structurally unreachable without exactly this kind of explicit call. **Unaffected by the Channels finding below — stands regardless.** |

**Row 1 superseded in part** — see "Channels — verified" at the end. A channel notification lets a
busy-lane delivery queue through Claude Code's own turn-boundary mechanism instead of racing
`submitQueue`'s pty bytes, which *does* fix the reported incident's mechanism (no more bracketed-paste
race) — just not immediately (turn-boundary latency, not mid-turn injection), and not without the
preview-allowlist friction described there. The table row above is left as originally evidenced;
this note is the correction.

## The push/pull limit, stated plainly

**Amended below — the "unverified" call in this section turned out right to be cautious about, but
the underlying capability is confirmed real. Read alongside "Channels — verified" at the end, which
supersedes the caveat (not the conclusion) in the paragraph immediately below.**

MCP tool calls are agent-initiated: the CLI decides when to call a tool; nothing in the base
protocol lets a server inject a prompt into an already-running turn on its own initiative. That's
solid ground. What the `claude-code-guide` research surfaced beyond that — a "Channels" capability
described as letting an MCP server push structured events into a running session — I could **not**
independently corroborate. It cited a blog post and a docs page I didn't read directly, carried a
suspiciously exact "2026-07-28 spec" date matching today, and is the single most convenient
possible answer to the hardest question in this brief. Treat it as **unverified, not false** —
someone should open `code.claude.com/docs/en/channels.md` directly and try it against a real
session before it's load-bearing in any design. Everything below assumes the conservative,
independently-confirmed case only.

On that conservative ground:

- **Fixed cleanly**: lane→Operator traffic of any kind (report, status, brief-pull) — a lane
  reaching out is exactly what a tool call is.
- **Fixed only if the target adopts pull**: Operator→lane traffic where the lane is willing to ask.
  A charter can tell a lane to call `operator__next_task()` at the start of each turn; when it does,
  the response is clean (no pty race) — but *whether and when* it asks is a prompting discipline,
  not a protocol guarantee, and every check costs a turn.
- **Not fixed at all**: injecting into a **busy** lane mid-turn (the known interrupt gap — FIFO
  `submitQueue` today, unchanged by MCP either way), and waking an **idle** lane (still a real
  process spawn via `terminal_spawn`, which no protocol substitutes for). `dev/research-buzz.md`
  already found Buzz doesn't solve either of these either — this is confirmed as a shared, still-open
  problem, not something Operator is behind on.

So: MCP converts "Operator infers state from a transcript and pushes bytes into a pty guessing at
timing" into "a lane explicitly tells or asks Operator, with a real response" — for traffic that
already flows toward Operator, or that a lane is willing to initiate. It does not open a channel
*into* a lane that wasn't already reaching out.

## North-star position

**Compatible — and arguably more faithful to "harness orchestrator" than the current sentinels,
with one real caveat.** Today Operator infers structure by regex-parsing free prose out of a
transcript it only observes (`transcript.rs:751-776`, `parse_directives`, with fence-tracking and
markdown-decoration tolerance built specifically to avoid misfiring on text that merely *looks*
like a directive). An MCP tool is Claude Code's own first-class extension surface — using the CLI's
real API instead of scraping its output is closer to "hosting Claude Code's own CLI," not further
from it. It doesn't touch model hosting at all (the already-rejected ACP/multi-provider direction);
Operator still runs Claude Code's binary, still doesn't run its own agent loop.

**The caveat**: registering MCP tools means Operator becomes something Claude Code's *own* trust
layer has an opinion about — workspace-trust approval dialogs on `.mcp.json`, a permissions
surface to pre-authorize. And the mechanics research itself surfaced parts of that surface as
genuinely in flux (SSE marked deprecated-but-still-functional for ~12 months; the unverified
"Channels" feature described as research preview). That's a distinct risk from "is the idea
sound" — it's "is the ground stable enough to build a load-bearing dependency on right now,"
where the sentinel approach depends on nothing more volatile than Claude Code printing plain text
to a JSONL file.

**Observer vs. controller — taking a side, as asked.** For the lane→Operator direction (report,
status, brief) this is a natural completion of the observer role: a lane deliberately telling
Operator what happened is not new control, it's the same thing the tailer already infers today,
made explicit instead of scraped. For the Operator→lane direction it does **not** expand Operator's
role, because that role already exists — dispatch already directs lanes today via pty injection.
MCP would make an existing control relationship more legible and reliable; it wouldn't create one.
Don't let the framing overclaim a bigger architectural shift than what's actually on the table.

## Incremental migration path

Real, and strongly preferable to a cutover — there's live work in flight.

1. **Ship `operator__report` + `operator__task_status` first.** Pure lane→Operator, zero delivery
   risk, closes the two strongest and least-disputed gaps. Runs beside the existing
   `OPERATOR-REPLY`/`*-RESULT.md` convention with no conflict — a lane can do either, nothing breaks
   for charters not yet updated.
2. **`operator__brief(name)` next.** Same shape, same low risk, fixes cross-worktree brief
   distribution.
3. **`operator__dispatch` last, and only after the push/pull question is answered honestly.** If
   built as "a lane calls this to register a dispatch, and Operator still delivers via the existing
   `submitQueue` pty-write," say so plainly — it removes prose-parsing ambiguity on the *sending*
   side only, not the split bug. A genuine pull model for *receiving* lanes is a separate, bigger
   charter-discipline change; trial it on one lane type first (Research is the obvious candidate —
   already produces file-based results, lowest interrupt-need) before rolling to all six.
4. **The dispatch-authority gate must move into the tool handler itself before step 3 ships**,
   keyed the same way `dispatchNeedsApproval` keys today (`dispatch.ts:14,25-27` — role id,
   coordinator vs. not; an unidentified sender defaults to needing approval). Worth noting this is
   a genuine improvement, not just parity: `harden-lane-dispatch-authority-RESULT.md` names an open
   exposure where a coordinator merely **echoing** a quoted `OPERATOR-DISPATCH` sentinel (from a
   file or web page it read) still auto-delivers, because the parser can't distinguish authored
   from echoed text. A tool call can't be tripped by quoted text the same way — invoking a specific
   tool with specific arguments requires the model to decide to actually call it, not merely
   reproduce a string that pattern-matches. Moving dispatch to a tool call closes that hole rather
   than just preserving today's gate.
5. **Sentinels stay as fallback throughout.** Both channels live is fine — a lane whose charter
   hasn't been updated keeps working exactly as it does today.

## Risks

- **No async/HTTP stack exists today.** `Cargo.toml` confirms the Rust backend is entirely
  synchronous (`std::thread` + `Mutex`, no `tokio`/`axum`/`hyper`). Hosting an HTTP MCP server means
  either adding an async runtime to a currently-sync backend (real new failure surface — locking
  bugs across an async boundary are a different class of bug than anything in this codebase today)
  or a stdio-per-session model, which fits awkwardly against operator state (roster, dispatch log)
  that's process-wide, not per-session.
- **Building against a moving target.** SSE deprecated-but-working, and an unverified push feature
  in research preview, per the mechanics research — Operator would be coupling a core delivery path
  to parts of Claude Code's own surface that are still settling.
- **Two coordinated pieces of generated config per spawn.** `.mcp.json`/`--mcp-config` needs a
  matching `permissions.allow` entry to avoid an approval-dialog interruption — one more thing
  `terminal_spawn` (`lib.rs:717-743`, which already assembles `--settings` and
  `--append-system-prompt`) has to get right per session, alongside what it already juggles.
- **Same charter-dependency risk as sentinels, moved, not removed.** Every lane→Operator win still
  requires the lane to remember to call the tool — structurally cleaner once invoked, not obviously
  more reliable in practice than remembering to emit a sentinel.
- ~~The push claim is unverified…~~ **Corrected — push is confirmed real** (see "Channels —
  verified" below). The live risk isn't whether it exists; it's that it's a research-preview
  feature Operator would depend on before its allowlist, dialog UX, and protocol contract have
  settled.

## Cost

The lane→Operator slice (report/status/brief, no delivery change) — an HTTP server in Rust, 3-4
tools, wiring into the existing project-state store, updated charters, tests — is a **small,
few-week effort**, comparable in scope to the already-shipped task-lifecycle or
agent-to-agent-delivery work (each landed as a focused multi-day-to-week effort per their `RESULT`
files). Dispatch-as-a-tool-call with the authority gate correctly reimplemented, plus deciding and
trialing a pull model for receiving lanes, is **materially bigger — multi-week to a quarter** — and
its payoff is capped by the push/pull limit no matter how much is spent, since it can't touch the
one thing actually blocking real complaints (interrupting a busy lane). Ship the confirmed slice;
treat the rest as a separate, later decision.

## Channels — verified

Fetched `code.claude.com/docs/en/channels.md` and `channels-reference.md` directly, per the brief.
Quoting the core claim: *"A channel is an MCP server that pushes events into your running Claude
Code session, so Claude can react to things that happen while you're not at the terminal."* Real,
documented, with a working reference implementation (`webhook.ts`, ~40 lines over the MCP SDK).

### The constraint that actually decides this: turn-boundary delivery, not mid-turn

The most important line in the whole reference doc, easy to miss: *"Events queue into the session
and are processed in order. If several notifications arrive while Claude is busy, they're delivered
together on the next turn."* A channel does not interrupt a running turn — it queues exactly like
Operator's own dispatch-to-a-busy-lane does today, just through a cleaner mechanism. So the honest
before/after is:

- **Before (pty push)**: delivering into a busy lane races `submitQueue` against the TUI's commit
  time — the actual split-bug mechanism.
- **After (channel push)**: delivering into a busy lane queues at the MCP layer and lands cleanly
  at the next turn boundary — no bracketed-paste race, because there's no pty write involved at all.
- **Neither** interrupts a lane mid-turn. The known interrupt gap is exactly as open as the first
  pass found. Channels upgrade "wait for the lane to be free" from a race to a guarantee; they do
  not shrink the wait.

Also confirmed, and worth carrying forward: a channel can only push into a session that's already
open with `--channels` enabled from the start — *"events only arrive while the session is open."*
Waking an idle lane is untouched either way; a channel has to be armed at spawn time, not added
later, so this isn't an opt-in-per-dispatch feature, it's an opt-in-per-launch one. And there is
still no delivery acknowledgment for a one-way push — *"Claude Code doesn't acknowledge
notifications… If you need delivery confirmation, track event state in your server."* — so the
closed-loop-confirmation problem `dispatch-split-closed-loop.md` is solving for pty writes would
need to be re-solved, not inherited, at the channel layer too.

### 1 — The preview allowlist, and a straight shippability answer

**Confirmed as the real blocker, and it's worse mechanically than "needs a flag."** During preview,
`--channels` only accepts an Anthropic-curated allowlist (`claude-plugins-official`) or an org's own
`allowedChannelPlugins` override. An Operator-authored channel is on neither. Testing it needs
`--dangerously-load-development-channels`, and that flag doesn't degrade quietly — per the docs,
*"Claude Code first shows a full-screen warning dialog listing the development channels you're
loading. Select 'I am using this for local development' to continue, or 'Exit' to quit."* Plus a
**second**, separate consent dialog the first time any project uses a new `.mcp.json` server
("New MCP server found in this project"). Both are interactive TUI prompts requiring a keypress,
on every session that arms channels, layered on top of Operator's own deferred-launch pty
choreography (`terminal_spawn`, `lib.rs`) — which today assumes a clean, promptless start.

**Straight answer: dev-prototype only. Not shippable in a released Operator today, and not a GA
target to commit to yet.** Three reasons, not one: (a) the friction dialogs above are a real UX
regression on every lane launch, not a one-time setup cost; (b) getting off the dev flag requires
either an Anthropic-partner allowlist listing or an org-level `allowedChannelPlugins` override —
the latter needs a Team/Enterprise org with an Owner, which doesn't fit a single-user desktop
tool's actual audience; (c) even fully unblocked, the payoff is capped by the turn-boundary limit
above — it upgrades queued delivery, it doesn't buy the interrupt capability that would justify
absorbing preview volatility. Revisit once the feature graduates out of research preview, not
before.

### 2 — Auth and platform limits

Confirmed: requires Anthropic auth (claude.ai or a Console API key); **not available on Amazon
Bedrock, Google Cloud's Agent Platform, or Microsoft Foundry.** Team/Enterprise orgs are blocked by
default until an Owner sets `channelsEnabled`. The one favorable data point: *"Pro and Max users
without an organization skip these checks entirely: channels are available and users opt in per
session with `--channels`."* Operator's actual audience — an individual running their own Claude
Code — mostly clears the org gate for free; the platform restriction only bites if a user routes
through Bedrock/Vertex/Foundry instead of claude.ai/Console auth, worth a one-line note in any
future user-facing docs if this ships, not a blocker for the common case.

### 3 — Research-preview volatility

Confirmed verbatim: *"the `--channels` flag syntax and protocol contract may change based on
feedback."* Also confirmed: neither `--channels` nor `--dangerously-load-development-channels`
appears in `claude --help` while in preview — they work, but they're deliberately undocumented in
the CLI's own surface. Consistent with treating this as something to prototype against, not build a
core mechanism on top of, until it stabilizes.

### 4 — Bun dependency: resolved, narrower than feared

**Not required.** Verbatim: *"The only hard requirement is the `@modelcontextprotocol/sdk` package
and a Node.js-compatible runtime. Bun, Node, and Deno all work. The pre-built plugins in the
research preview use Bun, but your channel doesn't have to."* This narrows the original spike's
infrastructure risk, not just the Bun-specific worry: a channel is a **stdio subprocess Claude Code
itself spawns** per `.mcp.json` (*"Claude Code spawns it as a subprocess"*) — it does not need to be
an HTTP server hosted inside the Tauri app's own process, which was the load-bearing assumption
behind the original Risks section's "no async/HTTP stack exists today" concern. That concern is
smaller than stated, not gone: the spawned sidecar (Node, not necessarily Bun) still needs *some*
way to reach Operator's actual project/dispatch state, which means a minimal local listener on the
Rust side either way — but it can be a plain synchronous listener answering one small request type,
not a full async HTTP framework bolted onto a currently-sync backend.

### 5 — Permission relay: not a drop-in replacement for the dispatch-authority gate

Confirmed mechanism: a channel that declares `claude/channel/permission` gets Claude Code's
*standard tool-use approval dialogs* (Bash, Write, Edit — a fixed four-field
`permission_request`: `request_id`, `tool_name`, `description`, `input_preview`) relayed to it in
parallel with the local terminal dialog; a `notifications/claude/channel/permission` verdict
(`allow`/`deny`) resolves whichever answer arrives first.

**This is a different gate protecting a different action, and it is not a home for Operator's
existing one as-is.** `harden-lane-dispatch-authority-RESULT.md`'s gate holds *dispatch* —
"may lane X commission lane Y" — a concept Operator invented; it isn't one of Claude Code's native
permission categories, so nothing relays it today. Relay would only become applicable if
`operator__dispatch` first becomes an MCP tool call marked to require approval (§ migration path,
step 4) — at that point relay is a genuine *addition*: remote/mobile approval on top of Operator's
own in-app `DispatchLog`, useful specifically for "approve from your phone while away from the
app," which Operator has no answer for today. It is not a *replacement* for the in-app gate, which
already offers richer context (a full log row, not a text message with a 5-letter code) than any
chat-relay prompt would.

**The safety property must not regress, and the docs name the exact way it could.** Verbatim: *"The
allowlist also gates permission relay if the channel declares it. Anyone who can reply through the
channel can approve or deny tool use in your session, so only allowlist senders you trust with that
authority."* And separately, on gating: *"Gate on the sender's identity, not the chat or room
identity… In group chats, these differ, and gating on the room would let anyone in an allowlisted
group inject messages into the session."* If relay is ever adopted for dispatch approval, two hard
requirements, not suggestions: it must be strictly additive to the in-app gate, never its sole
path, and Operator's own sender-allowlist must gate on sender identity specifically — the exact
mistake the reference doc calls out as the common one.

### The smallest real experiment — described, not built

Two tiers, cheapest first:

1. **`fakechat` against one manually-launched `claude` session, outside Operator entirely.** Install
   `fakechat@claude-plugins-official` (it's on the default allowlist — **no** dev flag, no
   full-screen warning, since it's officially approved), restart with
   `claude --channels plugin:fakechat@claude-plugins-official`, and push a message from
   `localhost:8787`. This validates the push mechanism itself — does an event genuinely land in an
   idle-but-open session and get reacted to — with zero friction and zero code, completely isolated
   from Operator's own spawn path. Settles: "does push work at all, for real."
2. **A bare `server:webhook` custom channel** (the ~40-line example in `channels-reference.md`)
   under `--dangerously-load-development-channels server:webhook`, still outside Operator's own
   `terminal_spawn`. This specifically measures what tier 1 can't: (a) whether the full-screen
   dev-channel warning can plausibly be dismissed programmatically via a pty write, or whether it
   hangs a headless/automated launch — the load-bearing question for whether this could ever be
   automated at all; (b) real end-to-end latency from `curl -X POST localhost:8788` to the event
   appearing in the transcript, to compare against the tailer's existing ~1s poll; (c) direct
   observation of the turn-boundary queuing behavior against a lane mid-task, to confirm the docs'
   claim first-hand rather than by citation alone.

Neither tier touches Operator's own code. Both are single-afternoon experiments; do (1) before (2)
— if push doesn't visibly work in the simplest possible case, the dev-flag automation question in
(2) is moot.
