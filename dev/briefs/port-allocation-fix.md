# Brief: dev-port allocation that checks reality (Code lane) — 2026-09-05

Live failure (2026-09-05): Operator reserved port 1425 for the operator lane
(`--append-system-prompt "Operator reserved localhost port 1425…"`), but pid 93480,
`node …/huridocs/uwazi_app/app/node_modules/.bin/vite --port 1425 --strictPort`, a different
project's server, already held it. The lane's startup rule ("if the port already answers, another
lane serves the same code — use it") therefore attached to a stranger. Background and trace:
`dev/results/simplify-audit.md` part 3. Electron is the shipping shell; fix Electron. Mirror the
Rust side only if trivial.

Fix set (electron/src/main):
1. `TerminalManager.allocPort` (terminals.ts:113) must bind-check like Rust's `port_free`
   (lib.rs:333: try binding 127.0.0.1 AND ::1). Skip a port that is bound by anyone. It also must
   consult `dev-leases.json` (leases.ts) so a lease held by another live app instance or a
   not-yet-reaped orphan is skipped, not only this process's `portsByCwd` map. allocPort becomes
   async; adjust `buildCommand`/spawn accordingly.
2. Same-cwd sharing stays, but only when the sharing lane's server is provably ours: the holder
   of the port is tagged with `OPERATOR_DEV_PORT`/`OPERATOR_APP_PID` (port-attribution.ts already
   classifies sniffed/reserved/shared/claimed/orphan). If the shared port is now held by a
   stranger, allocate a fresh one for the new lane instead of joining.
3. The contract the system-prompt hint (terminals.ts:155) promises must become true: Operator
   only hands out a port that is free at spawn time, or held by a lane in the same cwd whose
   server is tagged ours. Then the agent's rule is simply "if it answers, it is ours; else start
   the server on this port". Reword the hint to say exactly that, and drop any wording that asks
   the agent to probe port owners itself (per-pid `lsof` fires TCC prompts; forbidden).
4. On lane close/quit, the lease is released (already) — additionally, if the port is still
   bound after `reapAndForget`, log the holder pid+command under `[ports]` so the leak is visible.
5. Tests: unit tests for allocPort skipping a bound port (bind a throwaway server in the test),
   skipping a foreign lease, and re-allocating when the shared holder is a stranger.

Out of scope: the reparented-orphan reaper (reap.ts:319) — separate brief.
Done means: electron tests + tsc + build green; `dev/results/port-allocation-fix.md` with the
new contract in one paragraph and the tests added; call `mcp__operator__report`. Commit on your
branch; do not merge. If you are mid-way through the Chat/Files removal, finish that first and
take this second, on the same branch or a new one, your call.

## Correction (2026-09-05 14:40, one `ps -E` snapshot)
The 1425 holder is NOT a stranger: pid 93480 carries `OPERATOR_APP_PID=55647 OPERATOR_TERMINAL_ID=t8
OPERATOR_DEV_PORT=1425`, and t8 (cwd `~/Developer/huridocs/uwazi_app`, session f3f25561…) is
still in sessions.json and in dev-leases.json with devPort 1425. So the SAME app instance handed
1425 to two live lanes in different cwds. Find how: `portsByCwd` is per-process and should have
refused; candidates are a resume/relaunch path that restores a session's saved devPort without
re-registering it in the map, or the map entry being dropped when a lane in that cwd closed while
a sibling lane in the same cwd stayed. The lease file is the durable truth; allocPort must check
it first. Also in the snapshot: t18 (el-encanto-8c5180) has TWO vite servers (1432 and 1434), and
t0/t1/t13/t18/t19 servers all have ppid 1 while tagged with the live app pid.
