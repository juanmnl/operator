# Brief — Channels are REAL. Re-open the dispatch half of the MCP spike.

**Amendment to `dev/mcp-control-plane-spike.md`.** Investigate and report; change no code.
Output: append a **"Channels — verified"** section to `dev/mcp-control-plane-spike.md` and revise
the Verdict in place.

## You were right to doubt it, and it's true anyway

Your spike flagged the "Channels" claim as **unverified, not false** — citing the suspicious
date match and that it was "the single most convenient possible answer to the hardest question."
Correct instinct. I fetched `code.claude.com/docs/en/channels.md` directly. It exists, and it
says, verbatim:

> **"A channel is an MCP server that pushes events into your running Claude Code session, so
> Claude can react to things that happen while you're not at the terminal."**

Verified mechanics:

- Enabled **per session** with `claude --channels plugin:<name>@<marketplace>` (space-separated
  for several). Neither `--channels` nor `--dangerously-load-development-channels` appears in
  `claude --help` during the preview; the flags work regardless.
- **Two-way** — Claude reads the event and replies through the same channel.
- The model receives it as a `<channel source="plugin:x:y">` event; the terminal shows an inbound
  line like `← fakechat · web: …`.
- Events only arrive **while the session is open**.
- `fakechat` is an official localhost demo channel — a way to test the flow with nothing to auth.
- Build-your-own is documented at `/docs/en/channels-reference`.

**So the push/pull limit that shaped your verdict is not a hard limit of the platform.** The
conclusion "hold dispatch delivery, MCP can't push" needs revisiting. Do not simply flip it —
re-derive it against the constraints below, which are where the real answer lives.

## The constraints that decide this — the actual research question

1. **The preview allowlist is the blocker, not the protocol.** Verbatim: *"During the preview,
   `--channels` only accepts plugins from an Anthropic-maintained allowlist, or from your
   organization's allowlist if an admin has set `allowedChannelPlugins`."* An Operator-authored
   channel is on neither. Testing your own needs
   **`--dangerously-load-development-channels`**.
   → **Can Operator ship a feature that requires end users to launch lanes with a
   `--dangerously-` flag?** My instinct is no — that's a flag we should not be spawning on a
   user's behalf, and Operator spawns the `claude` process itself (`terminal_spawn`,
   `src-tauri/src/lib.rs`). Take a position. If the answer is "not shippable yet, but worth
   prototyping behind a dev flag," say exactly that.
2. **Auth and platform limits.** Requires Anthropic auth via claude.ai or a Console API key; **not
   available on Bedrock, Google Cloud Agent Platform, or Microsoft Foundry.** Team/Enterprise orgs
   must have an Owner enable `channelsEnabled`. Assess whether that narrows Operator's audience.
3. **Research preview volatility.** Verbatim: *"the `--channels` flag syntax and protocol contract
   may change based on feedback."* Weigh building a core mechanism on it.
4. **Bun dependency.** The official plugins are Bun scripts. Check whether a custom channel must
   also be Bun, or whether that's only true of the shipped examples — Operator is Tauri/Rust +
   Node, and a Bun requirement is a real packaging cost. **Read `channels-reference` for this;
   don't infer it.**
5. **Permission relay — possibly the bigger prize.** The docs describe channels that declare a
   *permission relay capability* forwarding permission prompts for remote approve/deny. Operator
   already has a **dispatch-authority gate** that holds a non-coordinator lane's dispatch for
   human approval (`harden-lane-dispatch-authority-RESULT.md`). Is relay a better home for that
   gate than what we built? Note the security note: anyone who can reply through the channel can
   approve tool use. **That gate is a safety property — do not recommend regressing it.**

## What I want back

- **Revised verdict.** Does the lane→Operator half still ship first, or do Channels change the
  sequencing? Be explicit about what changed and what didn't.
- **A straight answer on shippability**: usable in a released Operator today, dev-prototype only,
  or wait for GA. One of those three.
- **The smallest real experiment** that would settle it — ideally `fakechat` against one lane, or
  a minimal custom channel under the development flag. Describe it; do not build it.
- Keep your original per-fix table intact and mark what this supersedes. **The `task_status`
  finding stands regardless** — a per-turn completion signal is a lane→Operator call, unaffected
  by any of this, and it's still the strongest item on the list.

Sources to read directly, not via search: `/docs/en/channels.md`, `/docs/en/channels-reference`.
