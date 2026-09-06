# Brief: can Operator route dispatches over Claude Code's session bus? (Research lane) — 2026-09-05

Context: lanes report back via the Operator MCP (`report`, `task_status`, `brief`;
electron/src/main/mcp-serve.ts). Dispatch and reply are still sentinel lines
(`OPERATOR-DISPATCH [lane] …`) scraped from the transcript and typed into the target pty. Known
costs: long dispatches split, a second dispatch to a launching lane is dropped, and the sender
never learns the outcome. Claude Code 2.1.261 ships a native local session bus: `ListAgents`
from a lane listed 20 peer sessions on this machine (names like `operator-7d9000-96 [e5c7c1]`,
with busy/idle), and `SendMessage` delivers to one. Prior notes: memory
project_native_cross_session_messaging (2.1.224 verified ListAgents+SendMessage) and
project_mcp_control_plane (hold dispatch until delivery into a busy lane is reliable).

Answer these, against the INSTALLED binary (`~/.local/share/claude/versions/2.1.261`) and by
experiment, not from memory:
1. Transport: how does the bus work? (Unix socket / files under ~/.claude / a daemon?) Find the
   registry that ListAgents reads and the send path. Can a NON-session process (Operator's MCP
   server, node) enumerate sessions and send a message, or is sending gated to a session's own
   identity? If gated, what does a session need (a secret, a pid, a socket)?
2. Delivery timing: send a message from one lane to a BUSY lane. Does it interrupt mid-turn,
   land at the turn boundary, or queue like a user prompt? What does the receiver see (role,
   wrapper text)? Does a message to an idle lane start a turn?
3. Identity mapping: how is the bus name derived (cwd basename + hash + suffix?), and is the
   bracket id stable for the session's life? Can Operator compute it from what it already has
   (session UUID, cwd, terminal id), or must it read the registry?
4. Failure modes: message to an offline/closed session; two senders at once; size limit.
5. Recommendation in one paragraph: dispatch/reply as Operator MCP tools that deliver over the
   bus (Operator remains the router with brakes + board), vs. bus with pty fallback, vs. keep
   pty typing but move to a tool for the return value. State which is buildable now.

Report only, no code. `dev/results/session-bus-spike.md` + `mcp__operator__report`.
