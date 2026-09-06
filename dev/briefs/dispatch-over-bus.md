# Brief: dispatch and reply over Claude Code's session bus (Code lane) — 2026-09-06

Spike: `dev/results/session-bus-spike.md`. Prior verdict: memory project_mcp_control_plane.
Branch from main. Take after the bottom bar.

Facts: each session listens on `/tmp/cc-socks/<pid>.sock` (pid = the `claude` process Operator
spawned, so the address is computable with no registry read); `~/.claude/sessions/<pid>.json`
carries name/status/cwd; `SendMessage` from a session returns `{success, msg_id}` or a
structured failure; a message to an idle lane starts a turn, to a busy lane it is injected at
the next tool-result seam with the CLI's own "finish your current unit first" wrapper. The wire
protocol from a NON-session process is not reverse-engineered and must not be (live blast
radius); the peer token's role is unknown.

Design (decided): Operator stays the router; the bus is the transport; the lane does the send.
1. New MCP tools in `mcp-serve.ts`: `operator__dispatch(lane, task)` and `operator__reply(lane, line)`.
   The server applies exactly what the sentinel path applies today (hop brakes, role resolution,
   task creation with provenance, the board entry, launch of an idle lane with the task as its
   opening brief) and returns `{outcome: 'send' | 'launching' | 'refused', to: 'uds:/tmp/cc-socks/<pid>.sock', reason?}`.
   On `send`, the CALLING lane then calls Claude Code's native `SendMessage` to that address with
   the text the tool returns (already wrapped with the same header the pty path types today).
   On `launching`, Operator delivers the opening brief itself as now and returns; the lane sends
   nothing. Document this two-step in the coordinator's `--append-system-prompt` text.
2. Delivery confirmation: the tailer already parses tool_use/tool_result; record the
   `SendMessage` tool_result for a dispatch's msg as its delivery outcome on the task (delivered /
   failed with the CLI's message), replacing the pty delivery-confirm watchdog for bus dispatches.
3. Keep the `OPERATOR-DISPATCH` / `OPERATOR-REPLY` sentinels working unchanged for one release;
   log which path each dispatch used.
4. Never let a lane address a session outside its project: the tool resolves lane ids to
   addresses; free-form `SendMessage` to other names is out of Operator's hands and is noted,
   not blocked.
Tests: tool outcomes for idle/busy/unknown lanes and brake refusals; the tailer's tool_result →
task outcome mapping with a synthetic jsonl. `dev/results/dispatch-over-bus.md`;
`mcp__operator__report`. Do not merge.
