# Brief: dev servers that outlive their lane (Code lane) — 2026-09-05

Background: `dev/briefs/reap-dev-servers.md` (2026-08-29) and the machinery it produced in
electron/src/main/reap.ts + terminals.ts (`laneStrays`, `expandStrays`, `sweepTagged`,
`reapOrphanedDevServers` at boot, `staleTaggedRows`). The rule there is deliberate: a process is
reaped only when its `OPERATOR_APP_PID` names a DEAD Operator, or on lane close for that lane's
terminal id. Keep that rule for kills. The remaining holes, measured today (one `ps -E`):

- Servers tagged with the LIVE app pid (55647) whose lanes are still open have ppid 1
  (t0 mantel:1420, t1 el-encanto:1421, t13 mantel-landing:1430, t18 el-encanto-8c5180:1432+1434,
  t19 el-encanto-1ffdc0:1433). They are fine while the lane lives; the question is whether lane
  close reaps them. Verify `laneStrays` on close actually catches a ppid-1 server tagged with this
  terminal id + this app pid; write a test that simulates exactly this row shape.
- t18 holds two servers on two ports. A lane that restarts its server leaks the old one. On a
  new server appearing for a terminal id (port-attribution sees a second `OPERATOR_DEV_PORT`
  holder for the same terminal), nothing acts. Decide and implement: the lane's reserved port is
  the only sanctioned one; a second tagged server for the same terminal on another port is a
  stray, reap it at lane close as well (not immediately — the agent may be using it).
- Pre-tag orphans (no `OPERATOR_APP_PID`) are refused forever by design. Give the user the
  explicit action the code comment defers to: a "Dev servers" list in the Worktrees preferences
  section (reuse the dry-run/list-then-confirm pattern of "Remove N safe worktrees") showing every
  process with `OPERATOR_DEV_PORT` or a vite/next/astro/webpack command under a known project or
  worktree path: pid, port, cwd, age, owner (live lane / dead app / untagged). Kill on confirm,
  never automatically. One `ps -E` per refresh, no per-pid lsof (TCC).
- While the app is live, sweep every 10 minutes for tagged rows whose app pid is us but whose
  terminal id is not open in this process, and reap them (this is the "live app leaking while it
  is still up, which nothing ever revisits" case named in reap.ts).

Done: electron tests + tsc + build green; `dev/results/orphan-reaper-fix.md` listing each hole
and what now closes it; call `mcp__operator__report`. Commit on your branch; do not merge. Take
this after the settings prune.
