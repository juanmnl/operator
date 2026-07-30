# Brief — should Operator's internals be an MCP server? (spike, no code)

**Investigate and report. Change no code.** Output: `dev/mcp-control-plane-spike.md`.

User's question: *"shouldn't operator internals work as an MCP so all processes are routed
correctly?"* My read is that it's substantially right and would dissolve several bugs we are
currently fixing by hand. Your job is to size it honestly and find where it breaks.

## Why this is on the table now — today's evidence

Three separate failures today, all the same root shape (an unreliable, unstructured channel
between Operator and its lanes):

1. **Dispatch split.** A 203-char dispatch arrived as a truncated turn + a stranded composer tail.
   Cause: `submit-queue.ts` writes a bracketed paste then fires an unconditional CR at a *guessed*
   delay. Code is building closed-loop delivery confirmation right now
   (`dev/briefs/dispatch-split-closed-loop.md`) — a watchdog that exists **only because there is no
   RPC with a response.**
2. **Briefs invisible to lanes.** I wrote ten briefs in my own worktree; Design and Code run in
   theirs and could not read a single one. Nine dispatches pointed at unreachable paths.
3. **Results invisible to me.** The same bug in reverse — `*-RESULT.md` files are sitting in
   `operator-c48bd8` and `operator-1cf818`, unreadable from anywhere else. The file-based return
   path exists *because a lane's chat answer never reaches Operator.*

## The question to answer

Would exposing Operator's internals as an **MCP server** that each lane's Claude Code connects to
replace the pty-sentinel-plus-file arrangement with structured calls?

Concretely, evaluate a tool surface roughly like:

- `operator__next_task()` / `operator__task_status(id, status)` — lifecycle as explicit calls
- `operator__report(taskId, summary, artifacts[])` — the return path
- `operator__brief(name)` — brief distribution from ONE store, worktree-independent
- `operator__dispatch(lane, task)` — replaces the `OPERATOR-DISPATCH` sentinel
- `operator__post(channel, message)` — replaces `OPERATOR-REPLY`

### What I believe it fixes — verify each

- **Dispatch split: gone.** A tool call is a structured request with a response. No paste race, no
  nudge watchdog, no length or load sensitivity. Confirm this would let us *delete*
  `SUBMIT_NUDGE_MS`/`nudgeDelayFor` rather than merely tune them.
- **Return path: gone.** `operator__report` instead of a file in an invisible worktree.
- **Brief distribution: gone.** Served by the server, so worktree isolation stops mattering.
- **Task-lifecycle leak: probably gone.** ~200 tasks stuck in `running` because a stamped
  `terminalId` goes stale on restart and the roleId fallback can't match. Explicit status calls
  replace inference-by-transcript-matching. Check this against
  `project_task_lifecycle_leak` / `fix-session-task-lifecycle-RESULT.md`.

### The limit I want you to test hardest

**MCP is agent-pull, not server-push.** An MCP server cannot inject a prompt into a running Claude
Code session. So:

- Dispatching work *into a busy lane* still needs the pty write, or lanes polling
  `operator__next_task()` — which only happens while a lane is running and costs turns.
- Launching an idle lane still needs a spawn.
- The known **mid-task interrupt** gap (no way to inject an out-of-band question; `submitQueue` is
  FIFO-only) is **not** solved by MCP. Note that `dev/research-buzz.md` just found Buzz doesn't
  solve it either — it's a shared open problem, not somewhere we're behind.

Be precise about which direction of traffic MCP genuinely fixes (lane → Operator, and
Operator-state → lane on demand) versus which it does not (Operator → busy lane, unprompted).
**If the honest answer is "it fixes the return path and the reliability of structured calls but
not inbound push," say that plainly.** That would still be worth doing; overselling it would not.

## North-star check — and a distinction that matters

`dev/research-buzz.md` correctly rejects **model-agnostic hosting via ACP** as against the north
star (Operator hosts Claude Code's own CLI/transcript on purpose; multi-provider is deferred).

**MCP is a different proposition and must not be waved off by that finding.** It is not about
hosting other models — it is about the Claude Code we already host being able to *talk back to us*
over a supported, structured channel. Argue explicitly whether that's compatible with the north
star. My view: it's compatible and arguably *more* faithful to "Operator is a harness
orchestrator" than scraping sentinels out of a transcript. Push back if you disagree.

One genuine architectural tension to address: Operator is today a **transcript observer** — it
reads, it does not control. An MCP server makes it an authoritative second channel with lanes
calling *in*. Is that a betrayal of the observer design, or its natural completion? Take a side.

## Also cover

- **Mechanics.** Claude Code's MCP support (stdio vs HTTP/SSE), how Operator would register it per
  lane at spawn (we already pass `--settings`; see `terminal_spawn` in `src-tauri/src/lib.rs`),
  and whether a Tauri app can host it cleanly. Consult the `claude-code-guide` agent or official
  docs — **do not guess at the config surface.**
- **Migration.** Could this land incrementally beside the existing sentinels (both live, sentinels
  as fallback), or is it a cutover? Incremental is strongly preferred — we have live work in flight.
- **What breaks.** Restart/reconnect semantics, a lane that never calls the tools, a lane that
  calls them wrongly, and whether the dispatch-authority gate
  (`harden-lane-dispatch-authority-RESULT.md`) still holds when dispatch is a tool call rather
  than a parsed sentinel. **That gate is a safety property — do not let it regress.**
- **Cost.** Rough size. Is this a week or a quarter?

## Output

`dev/mcp-control-plane-spike.md`:

- **Verdict** in the first five lines: worth doing / not / worth doing narrowly — and the single
  strongest reason.
- Per-fix table: the four "fixes" above, each confirmed or refuted with evidence.
- The push/pull limit, stated plainly.
- North-star position, with your reasoning.
- Incremental migration path if one exists, else say so.
- Risks and rough cost.

Do not edit any file other than `dev/mcp-control-plane-spike.md`.
