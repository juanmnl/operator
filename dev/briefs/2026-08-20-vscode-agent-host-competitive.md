# Brief — VS Code's Agent Host: how close is it to Operator's job?

**Investigate and report. Change no code.**
Output: **`dev/briefs/2026-08-20-vscode-agent-host-competitive-RESULT.md`**.

## Why

The user read "VS Code is shipping a full IDE in the CLI." That is not what shipped. What shipped
is the **Agent Host** (VS Code 1.129, 2026-07-15): a dedicated process that runs agent harnesses —
Copilot, Claude, Codex — over the **Agent Host Protocol (AHP)**, with a session able to render in
several VS Code windows at once; 1.130 expanded it; 1.134 (2026-08-19) added side-by-side chats,
a prompt timeline and find-in-chat. That is structurally the thing Operator's north star describes
(a harness *orchestrator* hosting Claude Code — `~/.claude/projects/-Users-juanmnl-Developer-operator/memory/project_direction.md`,
and `dev/briefs/2026-08-*` on the dispatch/report control plane). We need to know exactly how
close it is, and whether AHP is something Operator should speak.

## Questions, in priority order

1. **What is AHP concretely?** Transport, message shapes, who hosts whom (does VS Code spawn the
   harness, or connect to one?), is it open/specified/published, is it the same thing as or related
   to ACP (Zed's Agent Client Protocol — which Zeron uses, see memory
   `project_competitor_zeron.md`) or Anthropic's Agent SDK. Primary sources only:
   `code.visualstudio.com/docs/agents/concepts/agent-host`, the 1.129/1.130/1.134 release notes,
   the vscode repo (`microsoft/vscode`, search `agentHost`, `AHP`), any Microsoft blog/devblog.
2. **How does Claude run inside it?** Is it Claude Code the CLI (pty? `--output-format
   stream-json`? the Agent SDK?) or Anthropic's own VS Code extension being hosted? Does Anthropic
   ship an AHP adapter, or did Microsoft write it? Does the user's Claude subscription/OAuth carry
   through, or is it API-key only? This decides whether Operator's transcript-tailing approach
   (`src-tauri/src/transcript.rs` tails `~/.claude/projects/<slug>/<uuid>.jsonl`) has a more
   official alternative.
3. **Multi-agent orchestration: does it exist there at all?** Can one session dispatch to another?
   Is there a board/fleet view, worktree-per-session, any notion of roles/lanes, any agent→agent
   messaging? Or is it N independent chats side by side? Be precise — this is the wedge Operator
   is betting on (`project_competitor_orca.md`: "wedge = depth, not fleet breadth").
4. **Is VS Code heading to the terminal / a CLI IDE?** Find the actual source of the user's
   impression — is there a TUI/headless agent-host mode, a `code agent` CLI, a "VS Code in the
   terminal" announcement or leak? Say clearly if there isn't one.
5. **Could Operator host or be hosted?** If AHP is open: could Operator be an AHP *client* (host
   Claude/Codex/Copilot harnesses the way VS Code does) — and would that be better or worse than
   hosting the Claude Code CLI in a pty as today? One paragraph, opinionated.

## Report shape

One-paragraph verdict ("how worried should we be, and what's the one thing to steal"), then the
five answers with citations (URL + date). Flag anything you could not confirm from a primary
source as such.
