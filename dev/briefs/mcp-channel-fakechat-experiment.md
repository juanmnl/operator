# Brief — smallest real experiment for MCP Channels (fakechat, tier 1)

**Investigate and report. Change no app code.** Output:
`dev/briefs/mcp-channel-fakechat-experiment-RESULT.md`.

This is tier 1 of the two-tier experiment described in `dev/mcp-control-plane-spike.md` §"Channels
— verified" → "The smallest real experiment". Read that section first for full context: the spike
concluded Channels (MCP server-push into a running Claude Code session) are real, but capped by
turn-boundary delivery and gated behind a research-preview allowlist. This experiment settles the
one thing citation alone can't: **does push actually work, hands-on, with zero friction.**

## What to do

Entirely outside Operator's own spawn path — a manually-launched `claude` session in a scratch
directory, not through `terminal_spawn` or any worktree Operator manages. `fakechat` is on the
default Anthropic allowlist, so this needs **no** `--dangerously-load-development-channels` and
should hit **no** full-screen warning dialog — if one appears anyway, that's itself a finding.

1. Confirm `bun --version` works; install Bun if not (`https://bun.sh`).
2. In a scratch dir, start a plain `claude` session and run
   `/plugin install fakechat@claude-plugins-official`. If the marketplace isn't found, add it first:
   `/plugin marketplace add anthropics/claude-plugins-official`.
3. Exit and restart with the channel armed:
   `claude --channels plugin:fakechat@claude-plugins-official`.
4. Open `http://localhost:8787`, type a message (e.g. "what's in my working directory?").
5. Observe and record:
   - Did the message arrive in the terminal as an inbound channel line
     (`← fakechat · web: …`)? Did the model receive it as
     `<channel source="plugin:fakechat:fakechat">`?
   - Did Claude act on it and reply, and did the reply show up back in the browser?
   - Any friction at all — dialogs, prompts, errors — even though none is expected.
   - Rough latency: message sent → visible reaction in the terminal.
6. **If time allows**, a second small check: send a message while the session is mid-task on
   something else (e.g. a long-running Bash command), and observe whether the channel event is
   held until the current turn ends (the spike's turn-boundary claim) rather than injected
   immediately. Don't force this — first-hand confirmation is a bonus, not a requirement.

## Scope

This is tier 1 only — do not build or test tier 2 (the custom `server:webhook` channel under
`--dangerously-load-development-channels`); that's separate, larger, and only worth doing if this
tier confirms push works at all.

## Output

`dev/briefs/mcp-channel-fakechat-experiment-RESULT.md`: what happened at each numbered step, any
deviation from the documented behavior, the latency you observed, and whether the turn-boundary
check (step 6) was attempted and what it showed. Then one `OPERATOR-REPLY` line.
