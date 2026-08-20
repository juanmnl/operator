# Brief — what killed long-running processes on this machine at 20:05 / 21:08 / ~21:55 UTC?

**Investigate and report. Change no code.** Output:
**`dev/briefs/2026-08-20-external-process-kills-RESULT.md`**.

The Code lane's Electron bench (`spike/electron/` in worktree `operator-c25838`, a long-running
Electron process replaying a pty into xterm) was killed externally at roughly **20:05, 21:08 and
~21:55 UTC on 2026-08-20** (`dev/briefs/2026-08-20-electron-shell-spike-RESULT.md`, M1 section).
Not jetsam (no memory-pressure entry, 24 GB with plenty free). Unidentified. If the killer is
Operator — the release app, the `npm run tauri dev` instance that ran ~20:30–21:05 UTC, a worktree
reap, `terminal_kill`, the quit guard, or a lane ending and taking its process GROUP with it —
then lanes' own long-running children are exposed, and that is a product bug.

## Do
1. `log show --start '2026-08-20 20:00:00' --end '2026-08-20 22:10:00' --predicate '…'` around
   each time: look for SIGKILL/SIGTERM/SIGHUP senders (`kernel`, `launchd`, `ReportCrash`,
   `operator`, `Operator`, `Electron`, `node`), `exited due to signal`, `killed by`. Narrow by
   the Electron process names the spike used (read `spike/electron/scripts/*.mjs` and the
   `measurements/*-loads.log` in the worktree for exact names/pids if logged).
2. Map the times to what Operator was doing: `~/.operator/sessions.json` mtimes, lanes that
   ended/started then, whether the release `Operator.app` relaunched (renderer respawn), and the
   tauri-dev instance's lifetime (it exited when its window closed ~21:05 UTC — does Tauri's exit
   SIGHUP/SIGTERM the whole process group, i.e. children of a shell started from that cwd?).
3. Read Operator's kill paths in `src-tauri/src/lib.rs` (`terminal_kill`, pty drop → `portable-pty`
   child kill, `quit.rs`, worktree `remove`/reap) and say precisely what each signals and to whom
   (pid vs pgid). Does any of them kill by process group or by cwd/worktree path?
4. Verdict: cause found / not found; if Operator, the line; if the shell/terminal (e.g. the Code
   lane's own `claude` turn ending and the harness's `nohup` missing), say that.
