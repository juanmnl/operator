# Dev-server orphans in the Electron shell — root cause + reap strategy

**Scope:** research only, no code changed. Verified against the current worktree
(`electron/src/main/terminals.ts`, `index.ts`, `ipc.ts`, `store.ts`, `quit.ts`,
`src/shared/types.ts`) plus a live `ps` snapshot of ~20 real orphans on this machine.

## Root cause (verified)

`TerminalManager` (`electron/src/main/terminals.ts`) tracks exactly one pid per lane: the
login-shell pid returned by `node-pty`'s `spawn()` (`terminals.ts:148`, `t.pty.pid`). Everything
else — `claude`, and whatever `claude` or the user runs inside it (`npm run dev`, `vite`,
`esbuild`) — is invisible to it.

- `kill(id)` (`terminals.ts:219-228`) does exactly one thing: `t.pty?.kill()`, then deletes the
  map entry and frees the port reservation. No descendant walk, no port probe on close.
- `node-pty`'s `UnixTerminal.kill()` is `process.kill(this.pid, signal || 'SIGHUP')` — confirmed
  in the installed package (`lib/unixTerminal.js:226-231`). That's a **single-pid** signal, not a
  process-group signal (which would need a **negative** pid). It only reaches the login shell.
- `killAll()` (`terminals.ts:296-298`) is just a loop over `kill(id)` — same gap, called from
  `teardown()` on `will-quit` (`index.ts:114-123`). **App quit has the identical leak as lane
  close**, not a separate bug.
- There is **no next-launch reap**. Nothing in `boot()` (`index.ts:125-`) reads `sessions.json`
  and reconciles it against the live process table. `AgentSession` (`src/shared/types.ts:68-107`)
  has no `devPort` and no `pid` field at all — the durable store doesn't even carry the
  information a next-launch reap would need. `terminalId` isn't useable for this either: it's a
  per-process-lifetime counter (`t${this.next++}`, `terminals.ts:71-78`) that resets to `t0` every
  app start, so it can't be correlated across restarts.
- `PORT-LEDGER.md` at the electron root is **not** a port-lease ledger — it's the Tauri→Electron
  porting-effort scorecard. Don't be misled by the name; there is no existing lease-tracking file
  anywhere in the repo.

Net effect: whether a lane is closed individually, a project is closed, or the whole app quits
(including a clean quit, not just a crash), any dev server the lane started keeps running,
because Operator only ever signals the shell that launched `claude`, never the tree under it.

## Live evidence (`ps -axj`, this machine, right now)

```
juanmnl  11417     1 11415    0    0 SN  ??  npm exec vite --port 1422 --strictPort
juanmnl  11438 11417 11415    0    0 SN  ??  node .../vite --port 1422 --strictPort
juanmnl  11439 11438 11415    0    0 SN  ??  esbuild --service=0.21.5 --ping
```

- `PPID=1` on the job leader (`11417`): its immediate parent (the shell, or whatever forked it)
  is already gone and it was reaped by launchd. This is orthogonal to sessions/groups — it just
  means "parent died first," which is exactly what an unmodified `kill(shellPid)` produces.
- `SESS=0` on every row: the pty's original session is gone entirely. **There is no live session
  to signal** — you cannot "kill by session" because the session no longer has meaning once its
  leader (the login shell) has exited or been killed.
- `PGID=11415` is **not stale in the way it looks**: `ps -p 11415` returns nothing (the group
  leader process is dead), but the group id itself is still a live tag on the three surviving
  members. POSIX `kill(-pgid, sig)` signals by that tag, not by requiring the leader to exist —
  so **process-group kill still works even though the row for pid 11415 itself is gone.**

This confirms: session-based kill is a dead end (no session survives), but **process-group kill
is viable** — the orphans keep the pgid bash's job control assigned them at spawn time, and macOS
lets you signal a group whose leader has already exited.

## Answers to the four questions

**(1) Do orphans share the pty's session id / pgid — is kill-by-session viable?**
No to session (see `SESS=0` above — there's nothing left to address once the shell is gone), but
process-group kill *is* viable, with one caveat: Operator's `TerminalManager` never captures the
descendants' pgid at spawn time (it only has the shell's pid), so this only works if the pgid set
is **discovered at kill time**, not pre-recorded from spawn.

**(2) Is killing whatever listens on the leased port at lane close safe, and how without
lsof-per-pid?**
Don't go through the port at all — go through the process tree instead, and it sidesteps this
question entirely. `terminals.ts` already solved the TCC problem for a *related* need
(`noteSessionPort`, `terminals.ts:248-258`): it explicitly rejects per-pid `lsof` because it fires
a TCC "access data from other apps" prompt per inspected process, and the codebase has a standing
rule against it (`feedback_no_lsof_lane_detection` in project memory: `grep`/`ps` on `sessions.json`
info instead of per-pid `lsof`). `lsof -i :PORT -t` has the same problem in kind — it's still
lsof interrogating a process you may not own — so it should be avoided for the same reason the
per-pid form already is, not treated as a lighter-weight exception. A single **`ps`** snapshot of
the whole process table triggers no TCC prompt at all (confirmed by using it above, and by the
prior art already in this codebase reading `sessions.json` + one global `ps` for liveness) — `ps`
is public kernel process-table metadata, not another process's open file descriptors, which is
the specific thing TCC gates. So: never touch the port to find the pid. Walk the tree from the
pid Operator already owns (`t.pty.pid`) instead.

**(3) Env-tagging (`OPERATOR_LANE_ID`) + `ps -E` as a fallback?**
Partially already built and unused: `terminals.ts:122` already sets `env.OPERATOR_TERMINAL_ID =
id` on every spawned pty, and env is inherited by every descendant (`npm` → `vite` → `esbuild`)
unless something explicitly clears it or double-forks with a scrubbed environment. So there's no
need to add a new `OPERATOR_LANE_ID` var — reuse the one that's already there. But treat this as
a **fallback only**, not the primary mechanism: `ps -eww -o pid,command -E` dumping every
process's environment is comparatively expensive and messier to parse than a plain
`pid,ppid,pgid` snapshot, and it only helps at all against a process that genuinely double-forked
and detached from Operator's process tree (rare for `npm run dev`/`vite`, which don't daemonize).
Reserve it for the **next-launch reap** path (§ below), where there's no live pty pid to start a
tree-walk from and env-grepping the global process table is the only way back to "this belongs to
a lane Operator started."

**(4) App quit / next launch?**
App quit should run the *same* reap sequence as lane close, once per still-open lane, before
`app.quit()` actually tears the process down — see `teardown()` above already being the single
call site for both individual-kill and quit-time kill, so one fix covers both. Next launch needs
a **durable lease record**, which doesn't exist today: `sessions.json`/`AgentSession` carries no
`devPort` and no pid/pgid. Recommend adding a small persisted map — either a `devPort` field on
`AgentSession` (simplest, reuses the existing atomic-write store) or a dedicated
`~/.operator/dev-servers.json` keyed by `savedKey`/cwd, written whenever `allocPort` assigns a
port and cleared on a clean `kill()`. On boot, before/alongside `TerminalManager` construction,
diff that record against a single `ps -axo pid,ppid,pgid,command` snapshot filtered to `PORT=` /
`OPERATOR_TERMINAL_ID=<savedKey>`-tagged rows (env-grep fallback from point 3, since there's no
live parent pid to walk from after a restart) and reap anything still bound to a leased port that
has no corresponding live lane in the freshly-loaded `sessions.json`.

## Recommended reap strategy — one approach

**Discover the tree at kill time, signal by process group, grace-period escalate. Do this both on
lane close and on app quit (same code path); add a lease record + env-grep sweep for next-launch.**

Exact sequence for `kill(id)` (and each iteration of `killAll()`):

1. Before touching the pty, take **one** snapshot: `ps -axo pid,ppid,pgid,command` (no TCC — pure
   process-table read, no lsof, no per-pid inspection).
2. Build a `pid → {ppid, pgid}` map from it and BFS/DFS from `t.pty.pid` (the shell) to collect
   every live descendant pid — this reaches `claude`, and `npm`/`vite`/`esbuild` under it,
   including a currently-running background job, because at this instant (before anything is
   killed) they are still attached to the shell's subtree by `ppid` even though their `pgid`
   differs from the shell's own.
3. Collect the **set of distinct pgids** present among those descendants.
4. Send `SIGTERM` to the shell pid *and* to each collected pgid via `process.kill(-pgid,
   'SIGTERM')` (negative pid = process-group target). This reaches vite/esbuild's whole job-control
   group in one call each, without needing their individual pids.
5. Wait **1.5s** (vite/esbuild/node dev-server teardown is fast — well under 1s in practice; 1.5s
   gives slow file-watcher flushes headroom without making every lane-close feel laggy).
6. Re-snapshot `ps` filtered to just the previously-collected pids. For any still alive, escalate:
   `process.kill(-pgid, 'SIGKILL')` for each surviving pgid, plus `process.kill(pid, 'SIGKILL')` on
   the shell itself if it's still around.
7. Only then do the existing bookkeeping: delete the `terminals` map entry, free the port
   reservation (`terminals.ts:227` — unchanged).

This directly answers (1)+(2)+(3) with one mechanism: no lsof, no port probing, one `ps` call per
kill (not per-pid), and it reuses the env tag already in place as the next-launch fallback rather
than inventing a new one.

**Next launch (new, doesn't exist today):**
- Persist the port lease (`devPort` + `savedKey`/cwd, or a small dedicated JSON) whenever
  `allocPort` assigns one; clear it on a clean `kill()`.
- On boot, before/while restoring lanes: one `ps -axo pid,ppid,pgid,command` +
  `ps -eww -o pid,command -E | grep OPERATOR_TERMINAL_ID=` sweep, cross-referenced against the
  persisted lease file. Anything whose leased port is still bound but has no matching live lane in
  the just-loaded `sessions.json` is unambiguously stale — run steps 3-6 above against it (its
  pgid, discovered from the same `ps` snapshot) before the fresh `TerminalManager` starts handing
  out that same port range again.

## What NOT to do

- Don't add per-pid `lsof` anywhere in this path — the codebase already has a hard rule against
  it (TCC prompt per process; see `feedback_no_lsof_lane_detection` project memory) and `lsof -i
  :PORT` inherits the same problem.
- Don't rely on `terminalId` to correlate across restarts — it's a fresh in-memory counter every
  boot, not a durable key.
- Don't assume `SIGHUP` alone (today's default) will cascade to background jobs — the kernel only
  auto-SIGHUPs the *foreground* process group of the controlling tty when a session leader dies;
  a backgrounded `npm run dev` job is typically in its own group and is not in the foreground
  group, so it survives untouched. This is the mechanism behind the ~20 live orphans found above.
