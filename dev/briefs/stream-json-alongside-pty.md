# Brief — cost a stream-json channel alongside the pty (READ-ONLY investigation)

**Lane: Research.** Change no code. Write your result to
`dev/briefs/stream-json-alongside-pty-RESULT.md`.

## Why

`https://github.com/zeronsh/comet` (Rust, MIT, ~31★, 151 commits — a Rust rewrite of an earlier
TypeScript version, so read its `ARCHITECTURE.md` as intent, not all shipped) drives Claude Code a
different way than we do:

| | Operator | Comet |
|---|---|---|
| talks to Claude Code via | `zsh -ilc 'claude …'` in a pty | `claude` subprocess over **stream-json** |
| knows what happened via | tails `~/.claude/projects/**.jsonl` (`src-tauri/src/transcript.rs`) + the terminal | its own **run journal**, structured events — no transcript reading, no terminal scraping |
| permissions / questions / steering | not modelled at all | first-class in a control protocol (`requestInput`) |
| lifetime | lane dies with the pty | detach-not-close; the TUI never embeds the engine |

Our north star is unchanged: Operator is a harness *orchestrator* that hosts Claude Code's own CLI,
and the terminal is the **fidelity escape hatch**. The open question is whether it also has to be
our **data source**, because that is where the garble, the ornament-width drift and the
bracketed-paste split all live.

## THE QUESTION THAT DECIDES EVERYTHING — answer this first

**Can one `claude` process be both an interactive TUI in a pty and a stream-json pipe at the same
time?** My strong prior is NO — `--output-format stream-json` / `--input-format stream-json` is a
headless mode, mutually exclusive with the interactive TUI in a single process.

If that prior is right, then "stream-json *alongside* the pty" cannot mean both for one session. It
can only mean one of:

- **(a) per-session choice** — a lane is EITHER a terminal lane OR a structured lane, chosen at
  spawn. Hybrid at the app level, not the session level.
- **(b) two processes per lane** — rejected on its face unless you can show otherwise; two `claude`
  processes on one worktree is two agents, not one, and would double-write the same files.
- **(c) stream-json only, terminal reconstructed from the event stream** — the terminal stops being
  a pty and becomes a renderer of structured events, which is a rewrite we have abandoned three
  times.

Establish which of these is real BEFORE costing anything. If the prior is wrong and both are
genuinely possible in one process, say so loudly — it changes the answer completely.

## Then

1. **The event surface.** What does stream-json actually emit — the message types, and whether
   tool calls, tool results, thinking, and subagent activity are all present and populated. Compare
   against what we get today from the transcript tailer. We have a hard-won note that in the jsonl,
   `thinking` is ALWAYS EMPTY and `tool_result` runs ~35KB p90 / 620KB max. Does stream-json differ?
   A fixture more generous than reality has already cost us a shipped feature with an empty body.
2. **The control protocol.** Permissions, `canUseTool`, and asking the user a question. Is this
   documented and supported, or is Comet reverse-engineering it? Cite where you looked. This is the
   part we most want, because a running lane currently looks idle in chat with no interrupt
   anywhere.
3. **Resumption.** Comet keeps a run journal replayable by sequence, with crash auto-resume. What
   does resuming a stream-json session actually require, and how does it compare to our
   `--session-id <uuid>` + transcript tail?
4. **What we'd keep.** Be concrete about what does NOT change: `transcript.rs`, `chat.db`,
   worktrees, the dispatch sentinel loop, the roster. I want the blast radius, not a rewrite plan.
5. **Cost.** Rough size of a spike that runs ONE lane on stream-json behind a flag, with the
   existing terminal untouched for every other lane.

## Rules

- **Read only.** No edits to `src/`, `src-tauri/`, or config. If you clone Comet, clone it to your
  scratch directory, never inside this repo.
- Prefer primary sources: Claude Code's own docs/CLI help for stream-json, and Comet's actual Rust
  source over its README.
- Where you are uncertain, say "uncertain" and say what would settle it. A confident wrong answer
  here costs a rewrite.
- Do not recommend multi-provider. It is deferred deliberately; note only whether this changes the
  cost of that deferral.

## Done means

`dev/briefs/stream-json-alongside-pty-RESULT.md` exists and opens with a direct answer to THE
QUESTION, then the five points, then a one-paragraph recommendation you would defend.
