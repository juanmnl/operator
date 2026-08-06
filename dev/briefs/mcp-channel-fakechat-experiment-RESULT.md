# RESULT — fakechat channel experiment (tier 1), run by hand

Ran live, not simulated. Confirms the push mechanism end-to-end; the bonus turn-boundary check
was attempted but came back inconclusive for reasons worth reading, not a shrug.

## Setup precaution worth naming first

This experiment spawns a *second, independent* `claude` process from inside my own live Claude
Code session (Bash tool). My own env carried `CLAUDE_CODE_SESSION_ID`, `CLAUDECODE`,
`CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_PID` — the same kind of session-identifying vars Operator's
own `strip_nested_session_env` exists to strip before spawning a lane. I stripped them explicitly
(`env -u ...`) and passed a fresh `--session-id` before launching the nested session, so it
couldn't collide with or corrupt my own transcript. Confirmed clean throughout — no cross-talk.

## Step-by-step, against the brief's six steps

**1 — Bun.** Not installed (`command not found: bun`). Installed via the official installer
(`curl -fsSL https://bun.sh/install | bash`) → `bun 1.3.14` at `~/.bun/bin/bun`. **This modified
the user's `~/.zshrc`** (appended `~/.bun/bin` to `PATH`) — a real, if standard and reversible,
change to shared shell config, not scoped to this experiment. Worth knowing: the *official*
fakechat plugin genuinely requires Bun to run (its `server.ts` is a Bun script) — the spike's §4
finding that a *custom* channel doesn't need Bun is still correct, but doesn't extend to the
pre-built plugins used here.

**2 — Install the plugin.** Deviation from the brief's literal steps, in a good direction: instead
of driving an interactive session through `/plugin install`, I found `claude plugin install
<name>@<marketplace> --scope user` is a real non-interactive CLI subcommand (`claude plugin
--help`), so I used that directly — `claude plugin install fakechat@claude-plugins-official
--scope user` → `✔ Successfully installed plugin: fakechat@claude-plugins-official (scope: user)`.
The marketplace (`claude-plugins-official`) was already present on this machine before I touched
anything (`already on disk — declared in user settings`) — not something this experiment added.
**Side finding worth carrying forward**: this non-interactive install path exists at all, which
matters if Operator (or anyone automating this) ever wants to provision a channel plugin without
scripting the interactive `/plugin` flow.

**3 — Restart with `--channels`.** Launched in a scratch dir, backgrounded, under `script` (macOS's
built-in pty allocator — `tmux` isn't installed here) so Claude Code got a real terminal rather than
a plain pipe:

```
claude --session-id <fresh-uuid> --channels plugin:fakechat@claude-plugins-official
```

Startup banner, captured verbatim from the pty log:

> `Channels (experimental) messages from plugin:fakechat@claude-plugins-official inject directly
> in this session · restart without --channels to stop`

**No allowlist warning, no full-screen dev-flag dialog, no MCP-server consent prompt** — exactly as
expected, since `fakechat` is on the default Anthropic allowlist and neither
`--dangerously-load-development-channels` nor a fresh-`.mcp.json` consent was in play. A `bun`
process came up listening on `localhost:8787` within ~6s of launch, spawned by the session itself
as the channel's MCP subprocess.

**4 — Push a message.** The brief says "open the browser and type." I didn't — the docs only
describe the browser flow, so I fetched fakechat's actual `server.ts` from GitHub to find its wire
protocol directly, rather than assume one. It exposes `POST /upload` (multipart form, fields `id`
+ `text`), which `curl` can hit exactly like a browser submit would:

```
curl -X POST -F "id=exp1" -F "text=Reply with the exact string PONG and nothing else." \
  http://localhost:8787/upload
→ HTTP 204
```

This is arguably a *stronger* check than typing in a browser — it validates the actual channel
wire behavior, is scriptable, and needed no `claude-in-chrome` tooling.

**5 — Observe.** All confirmed, verbatim from the captured pty log:

- Inbound line rendered exactly as documented: `← fakechat · web: Reply with the exact string
  PONG and nothing else.`
- Claude visibly reacted (`✻ Channeling…` → thinking → `⏺ Calling plugin:fakechat:fakechat…` →
  `Called plugin:fakechat:fakechat`), then confirmed in its own turn: *"PONG sent to the fakechat
  UI."*
- A second, independent round-trip (`what is 2+2?` → tool call → `4`) succeeded the same way a
  few minutes later, confirming this wasn't a one-off.
- **Latency**: curl returned its `204` in well under a second both times (transport is not the
  bottleneck, consistent with the original spike's pty-write timing finding). End-to-end
  push-to-reply, by Claude's own self-reported turn time, was **~7–8s** both times (`"Brewed for
  7s"`, `"Churned for 5s"` + a following turn) — that's model think-and-respond time, not the
  channel mechanism.

**6 — Turn-boundary check (bonus, attempted, inconclusive).** Tried to reproduce the docs' claim
that *"if several notifications arrive while Claude is busy, they're delivered together on the next
turn."* Plan: push a message that starts a real 15-second `sleep`, then push a second message
mid-sleep, and see whether the second message's arrival is visibly deferred.

**It didn't test what I intended.** The nested session's own Bash tool is *itself* sandboxed the
same way mine is — it declined to block on a foreground `sleep 15` and started it in the
background instead (its own words: *"Started it in the background (foreground sleep is blocked in
this harness). I'll report to the UI when it finishes."*), so its first turn completed in ~5
seconds and the session was **idle again before my second push even arrived** (9s after the
first). The second message landed on a free session and was handled as an ordinary fresh turn, not
a queued-while-busy one — so this run neither confirms nor refutes the docs' claim. **Report this
honestly as unverified, not as settled.** A real test needs a busy window that can't be
backgrounded away — e.g. run in an environment without this sandbox's auto-backgrounding, or use a
task that keeps the model itself mid-deliberation rather than a shell command.

## Cleanup

Killed the exact PIDs (nested `claude`, the `script` wrapper, the `bun` fakechat server) — no
pattern-kill. Confirmed: no matching processes left, port 8787 free.

**Left in place, deliberately, both low-risk and dormant without `--channels`:**
- Bun at `~/.bun/bin/bun`, and the `PATH` line it added to `~/.zshrc`. Revert: remove that line,
  `rm -rf ~/.bun`.
- The `fakechat` plugin installed at user scope. Revert: `claude plugin uninstall
  fakechat@claude-plugins-official`. The `claude-plugins-official` marketplace was already on this
  machine before this experiment — nothing to revert there.

## Bottom line

**Confirms the spike's "Channels — verified" findings, hands-on**: push is real, the officially
allowlisted case is genuinely zero-friction, and the reply-tool round trip works exactly as
documented, twice. **Does not newly confirm** the turn-boundary-while-busy claim — that stays a
documented-but-not-independently-verified detail, for the specific reason above, not for lack of
trying. Nothing here moves the spike's verdict: still dev-prototype only, and the measured ~7–8s
reaction time (pure model latency, unrelated to the channel mechanism itself) is one more small
data point against treating this as a fast, general-purpose delivery path even where the allowlist
and turn-boundary limits weren't the concern.
