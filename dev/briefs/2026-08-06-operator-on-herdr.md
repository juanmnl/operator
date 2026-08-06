# RESEARCH: cost Operator as a herdr client

**Lane: Research. Investigate and report — change no product code.** Probes/spikes under `dev/` are fine.

## Why this is worth costing

`herdrdev/herdr` — Rust, Apache-2.0, created 2026-03-27, **24,686 stars**, pushed today. Tagline:
*"the runtime your coding agents live on."* Topics include `terminal-multiplexer`, `tmux`,
`agent-orchestration`, `workspace-manager`. It claims: sessions that survive laptop close / network
drop / restart; agent-agnostic ("19 agents detected out of the box" — Claude Code, Codex, Cursor,
opencode, Grok); agent state (working/blocked/idle) as a runtime feature; local **or a rented box**;
and it owns terminals *without wrapping or replacing* the agent CLIs.

An ecosystem of **clients** already exists on it — `kcosr/herdr-web` (TS web client),
`dcolinmorgan/herdr-remote` (menu bar/phone/Telegram, 187★), `persiyanov/herdr-reviewr` (review
sidebar, 341★), `paulbkim-dev/vim-herdr-navigation`, `joelhooks/pi-bellwether`. **Operator is that
kind of client.** Read at least `herdr-web` and `herdr-reviewr` at the source level — a working
client answers "what does integration actually look like" better than any README.

This is the third independent project to land on *the engine outliving the window*
([[project_competitor_diri]]: worktrees + remote hosts; comet: "detach-not-close, the TUI never
embeds the engine" per `dev/briefs/stream-json-alongside-pty-RESULT.md`). Three convergent designs
is a signal worth costing rather than admiring.

## The question

**What would Operator gain and lose by becoming a herdr client instead of owning ptys itself?**
Not "is herdr good" — assume it works. Cost the integration honestly, including the parts that
would have to be deleted or rebuilt.

## What it would plausibly buy us — verify each, don't assume

- **Persistence across app restarts.** Directly relevant tonight: the WKWebView renderer is being
  killed and respawned (see `dev/briefs/2026-08-05-forget-and-sidebar-restart-RESULT.md`), which
  reads as "the app restarted" and loses scope. A runtime that outlives the window makes that a
  cosmetic blink instead of a state loss.
- **Multi-provider for free.** [[project_direction]] defers multi-provider as *"architecturally at
  odds with Operator hosting Claude Code's own CLI"*. If herdr runs whatever CLI you already run,
  that objection dissolves without Operator becoming a harness. **Check whether this is real** — 19
  detected agents may mean "spawns the binary", not "understands its transcript".
- **Remote execution.** Would resolve the same axis diri covers.
- **Agent state without transcript tailing.**

## What it would cost — these are the load-bearing questions

1. **The transcript tailer.** `src-tauri/src/transcript.rs` tails
   `~/.claude/projects/<slug>/<uuid>.jsonl` and is how Operator knows anything. If herdr owns the
   pty, is that file still written where Operator can read it? **And what happens when the session
   runs on a rented box** — is the transcript remote, and does herdr expose it, or does Operator go
   blind? This single question probably decides the whole thing.
2. **The dispatch sentinels.** `OPERATOR-DISPATCH` / `OPERATOR-REPLY` are parsed out of transcript
   text by `parse_directives`. Same dependency as (1). Note the artifact plane
   (`operator__report` / `operator__task_status`, being built now) is MCP — a lane→Operator call
   that may survive this change untouched. **Say whether herdr makes the sentinels better, worse,
   or irrelevant.**
3. **Per-project ports.** `alloc_port` + `OPERATOR_DEV_PORT` reserve a localhost port per working
   directory. A remote session breaks that assumption completely. What is the story for a dev server
   on a rented box?
4. **Worktrees.** herdr is tagged `workspace-manager`. Does it own workspace lifecycle too? If so,
   compare against the recommendation in `dev/briefs/2026-08-05-worktree-architecture-RESULT.md`
   (owned worktrees + a registry + an age-based reaper) — **adopting herdr might obsolete work we
   just scoped**, which is worth knowing before that work starts.
5. **The renderer.** Operator renders pty bytes into xterm in a webview, and has just wired an
   alacritty-based grid path (`gridterm.rs`, opt-in). Does herdr hand a client **raw pty bytes** or
   something structured? If structured, the terminal work changes shape entirely; if raw, it doesn't.
   herdr's site says nothing about rendering — find out from the source.
6. **What Operator keeps.** Projects, roster, charters, dispatch, tasks/diff, the chat surface. Be
   explicit about which parts of Operator become redundant — if the answer is "most of it", say so.

## Also answer

- **Migration shape.** Must this be all-or-nothing, or can a lane be herdr-hosted *or* pty-hosted,
  chosen at spawn? (The stream-json result landed on exactly that per-lane shape — precedent.)
- **Dependency risk.** Four months old, 24.7k stars, one org. What is the protocol stability story,
  and what happens to Operator if it stalls? Is the client protocol documented and versioned, or is
  every client reverse-engineering it?
- **Does it duplicate what we just built?** Be blunt if tonight's coordinator/worktree work or the
  artifact plane would be wasted.

## Output

A recommendation with a number attached: adopt / adopt-for-some-lanes / don't, plus the smallest
experiment that would prove it (e.g. one lane hosted by herdr behind a pref, rendering into the
existing surface). Cite files and line numbers from herdr's source, not its marketing.

Write `/Users/juanmnl/Developer/operator/dev/briefs/2026-08-06-operator-on-herdr-RESULT.md`
(absolute path, main repo).
