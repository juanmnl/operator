# Result — what killed the Electron bench at 20:05 / 21:08 / ~21:55 UTC

Brief: `dev/briefs/2026-08-20-external-process-kills.md`. No code changed.

**Verdict up front: Operator is cleared, by direct PID/uptime evidence, not by absence of proof.
The actual signal-sender is NOT identified** — ordinary Unix signals between unrelated processes
leave no audit trail in macOS's unified log, only their effect does. What the effect shows points
away from Operator and toward the Code lane's own process tree / tooling, detailed below.

## 1. What actually happened, from `log show`

This machine's local zone is **UTC-5** (`date` → `-05`), so the brief's UTC times map to local
15:05 / 16:08 / 16:55 — all queried with `/usr/bin/log show` (the bare `log` command is a zsh
builtin, not `/usr/bin/log` — first attempts silently no-op'd on that).

**Kill #1 — 2026-08-20 15:04:52 local (20:04:52 UTC), three deaths within 45ms:**
```
15:04:52.904  WindowServer  Process death (Electron) pid: 49319
15:04:52.907  WindowServer  Process death (Electron) pid: 44288
15:04:52.938  WindowServer  Process death (Electron) pid: 55353
15:04:52.922  Electron[55353] windowShouldClose: prevented close   ← dies anyway, 16ms later
```
`loginwindow` confirms the bundle path on all three: `.../operator-c25838/spike/electron/
node_modules/electron/dist/Electron.app` — exactly the three bench arms (`m1-webgl`, `m1-dom`,
`m2-fleet`, one Electron main process each, per `scripts/bench-run.sh`). One of them logs its own
JS-level "prevented close" handler firing and dying 16ms later anyway — a graceful in-app close
guard cannot stop a process-level signal, which is the tell that this was a kill, not `app.quit()`.
Relaunch: three fresh Electron pids at **15:05:39–40** — **47 seconds later**.

**Kill #2 — 16:08:32–33 local (21:08 UTC), same three pids die, looser (0.58s / 0.74s apart):**
```
16:08:32.179  pid 44219 dies
16:08:32.762  pid 44220 dies
16:08:33.501  pid 44218 dies
```
These are the *exact* pids created after kill #1 — direct continuity. Relaunch this time took
**~2m24s** (two new pids at 16:10:57.669, a third at 16:13:44.194).

**Kill #3 area — 16:52–17:00 local (~21:52–22:00 UTC) is not one event but a crash loop:**
```
16:54:58.716  pid 78725 dies
16:54:59.665  pid 95209 created        ← 0.95s turnaround — too fast to be a human/agent noticing and re-typing a command
16:55:04.064  pid 78726 dies
16:55:04.811  pid 95451 created
16:56:57.159  pid 95209 dies            ← ~2 minutes after it was created
16:56:57.169  pid 95451 dies            ← 10ms later, near-simultaneous again
16:56:57.956  pids 99795, 99796 created
```
By now the pattern is die → restart within ~1s, sometimes live only ~2 minutes before dying again.
**No process is alive from this whole family right now** (checked live): the last restart
(`measurements/pids`: 72526/72528, launched ~21:57 UTC per `m1-dom-loads.log`'s `load#1
t+0s @21:56:58Z`) has also already exited.

## 2. Ruled out directly

- **Not jetsam / memory pressure.** No `com.apple.jetsam` entries in the window; the brief's own
  claim checks out.
- **Not sleep/wake.** `pmset -g log` and the power-management log show continuous `inFullWake:
  YES`, plugged in, through all three windows — no `Sleep`/`Wake`/`DarkWake` transition anywhere
  near 15:04:52, 16:08:32, or 16:54–16:57.
- **Not a scheduled Operator timer.** `grep -n "interval\|Duration::from_secs\|thread::spawn" src-tauri/src/*.rs`
  turns up no periodic sweep that touches ptys, worktrees, or processes — `worktree_reap` is
  classification-only and nothing in the frontend or backend calls it automatically (matches the
  existing memory note that no frontend calls `worktree_reap_dry_run`).

## 3. Operator's kill paths, read precisely — none of them can reach these processes

**`terminal_kill` (`src-tauri/src/lib.rs:1070-1077`)** takes an `id: String`, looks it up in
`mgr.ptys` (a `HashMap<String, Pty>` keyed by Operator's own generated ids like `t11`), and calls
`p.killer.kill()` on exactly that one entry. The bench's Electron/node processes were launched
by a plain `nohup node scripts/dev.mjs &` inside the Code lane's shell — they were never passed to
`terminal_spawn`, so **there is no `id` string in existence that could name them**. This call site
cannot reach them structurally, not just didn't-happen-to today.

**What `.kill()` actually sends is not SIGKILL.** `portable-pty` 0.8.1 (`~/.cargo/registry/.../
portable-pty-0.8.1/src/lib.rs:329-334`) implements `ChildKiller for std::process::Child` by sending
**`SIGHUP`** on Unix, not `SIGKILL`/`SIGTERM` — a single `libc::kill(pid, SIGHUP)` to the one pid,
never a `killpg`. `grep -n "killpg\|libc::kill\|SIGKILL\|SIGTERM\|pkill\|pgrep" src-tauri/src/lib.rs`
returns nothing — Operator's own code never sends a raw signal at all; every kill goes through this
one portable-pty method.

**Every lane's pty is its own isolated session, by design.** `unix.rs:194-247`'s `spawn_command`
calls `libc::setsid()` in the child's `pre_exec`, before `exec`, for *every* `terminal_spawn`.
That makes each lane's shell a session leader with its own fresh process group — confirmed live:
`ps -o pid,pgid` on the Code lane's own `claude` process (pid 38343) shows `pgid == pid == 38343`.
So even in the world where `terminal_kill` *could* reach a target, it cannot cross into a
different lane's group — there is no shared process group between lanes for a kill to leak across.

**The owning lane never died.** `~/.operator/sessions.json`'s entry for worktree `operator-c25838`
(`terminalId: t11`, `claudeSessionId: 2beebf9c-...`) matches the live process **1:1** — `ps -p
38343` shows that exact `--session-id` still running, unbroken, since **13:59:05 local**, spanning
all three kill events with no restart. If `terminal_kill` (or the pty being dropped) had fired on
`t11`, this shell would have died with it — it didn't.

**The release app itself never restarted.** `ps -o lstart -p 10860` → running continuously since
**09:19:25 local today**, before all three events. So this isn't the app crashing/relaunching and
taking children down in `RunEvent::ExitRequested` teardown, and it isn't the "WebKit renderer
killed and respawned hourly" behavior on record either — that's a `WebContent` child process
recycling under WKWebView memory pressure, entirely separate from the Rust process holding
`PtyManager`; a renderer respawn cannot touch pty state.

**`quit.rs`** only matters app-wide: `finish_quit` (`quit.rs:113-116`) calls `app.exit(0)`, which
would show up as the release app (pid 10860) exiting. It never did, so this path was never
exercised in the window — moot.

**Worktree remove/reap does not signal anything.** `remove_worktree` (`worktree.rs:1580-1603`)
shells out to `git worktree remove [--force] <path>` — pure file/metadata deletion via `git`, no
pid, no pgid, no process discovery by cwd at all. And the worktree is still on disk right now
(`git worktree list` shows `operator-c25838` present) — it was never even attempted for this one.

**Straight answer to the brief's question:** no, nothing in Operator's kill surface signals by
process group or by cwd/worktree path. Every mechanism is single-pid, and only reaches pids
Operator itself spawned and is still tracking.

## 4. What the evidence points to instead

Three independent supervisor trees (`node scripts/dev.mjs`, one per bench arm, different ports,
different PPIDs) died within the same sub-second-to-low-second window, more than once. Three
unrelated internal Chromium crashes landing in the same instant, three separate times, is not a
credible coincidence — this has a shared cause, and `dev.mjs` itself rules out an *internal*
shared cause: `electron.on('exit', () => { shutdown(); process.exit(0) })`
(`spike/electron/scripts/dev.mjs`, near the end) means the supervisor **self-terminates the moment
its own Electron process exits, for any reason** — there is no watch-triggered auto-relaunch
anywhere in this tooling. (`vite.config.ts` does exclude `measurements/**` from its dev-server
watcher specifically because an earlier run *did* trigger reloads from bench output — but that's a
documented, already-fixed *renderer*-reload bug, and a renderer reload inside a `BrowserWindow`
does not kill the Electron *main process* WindowServer reports dying here — different symptom.)

So each death is either three coincident external crashes (unlikely) or one shared trigger hitting
all three at once. Nothing currently running on the Code lane's process tree explains the trigger
directly: right now, `pstree` under pid 38343 (the Code lane's live `claude` process) has **no**
node/vite/electron descendants at all — whatever launched the bench has since exited or been
reparented to launchd (pid 1), which is exactly what `nohup ... &` from inside a `sh` script does
once its own parent shell moves on, and reparenting changes PPID, not the process's existing PGID.

The one number that argues hardest against "the agent manually restarted it": **0.95 seconds**
from the 16:54:58.716 death to the 16:54:59.665 relaunch. That is not a human or an LLM agent
noticing a crash, deciding, and issuing a new tool call — that round trip does not happen in under
a second. Something automated is doing the restarting, and by the same logic, something automated
is the more likely explanation for the kills too.

**My best-supported, not-fully-proven read:** this is most consistent with the Code lane's own
background-process lifecycle — either the `claude` CLI's own handling of a `run_in_background`
Bash job (this repo has no visibility into that binary's internals; it lives outside
`src-tauri/`), or a monitoring/re-arm loop the Code lane was running as part of babysitting a
2-hour bench. Either way, it is **not** Operator's Rust backend — every path in `src-tauri` that
can kill a process was read above and each is either scoped to ids Operator never had, or was
never invoked (the owning lane and the release app both ran unbroken through all three events).

## 5. What I could not establish

- **Who/what sent the signal, by pid.** macOS's unified log records the *effect* (`WindowServer`
  noticing a connection die) for GUI apps, not the *cause*, for an ordinary `kill()` between
  unrelated processes — that needs Endpoint Security instrumentation this investigation didn't
  have access to.
- **Whether Claude Code's own background-bash-job management is actually the mechanism.** That is
  the strongest remaining candidate given everything above, but it is inference from timing and
  elimination, not something read from source — the `claude` binary is outside this repository.
- **Why the cadence tightened from ~63/~47 minutes to a ~2-minute crash loop.** Could be the M2
  arm's 30-minute capture completing and not being relaunched (only two pids die in the third
  window, not three), could be state accumulating and crashing faster on each restart, or could be
  whatever the trigger is firing more often later on — not distinguishable from the logs available.
