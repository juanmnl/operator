# The dev-server reaper

**Branch:** `operator/a30080` · commit `316336e` · 2026-08-24 · Code lane
**Built from:** `dev/results/devserver-orphans-research.md` (copied onto this branch)

## What was leaking

`TerminalManager` tracked exactly one pid per lane — the login shell `node-pty` returned — and
`UnixTerminal.kill()` is `process.kill(this.pid, 'SIGHUP')`: a **single-pid** signal, not a group
signal. `claude`, and the `npm run dev` → `vite` → `esbuild` tree under it, were never signalled
at all. The kernel's automatic SIGHUP-on-session-leader-death only reaches the **foreground**
process group of the controlling tty, and a backgrounded dev server sits in its own group. So
lane close, project close, and a *clean* app quit all leaked identically — `killAll()` was only
ever a loop over the same broken `kill()`.

While writing this, a sweep of this machine found **~60 live orphans** across nine projects,
holding ports 1420–1431.

## The kill path

`kill(id)` in `electron/src/main/terminals.ts`, mechanism in the new `electron/src/main/reap.ts`:

1. **One** `ps -axo pid,ppid,pgid,command` snapshot, taken *before* anything is signalled — at
   that instant every descendant is still attached to the shell by `ppid`, whatever its own pgid
   is, so one snapshot is the whole map.
2. BFS the tree from `t.pty.pid` (`descendantsOf`), with a seen-set — a `ps` snapshot is not a
   consistent instant and a cycle here would hang the quit path. pid 0/1 are never followed:
   every orphan re-parents to launchd, and walking from it collects the machine.
3. Collect the distinct pgids (`pgidsFor`), **excluding our own group, pgid 0 and pgid 1**.
   `kill(-ourOwnGroup, SIGKILL)` is Operator killing itself mid-quit, and `kill(0, …)` means
   exactly that to `kill(2)`.
4. `SIGTERM` each `-pgid`, then the shell pid.
5. Grace period, **polled at 100ms rather than slept**: the brief's 1.5s is the deadline, not the
   cost. Everything is normally gone in ~100ms, and a flat 1.5s would be felt on every lane
   close.
6. Survivors are re-checked with `kill(pid, 0)` against the *original* pid set — same answer as a
   second `ps` for a fraction of the cost, and it cannot widen the blast radius to a pid that
   appeared after the snapshot. Remaining groups get `SIGKILL`.
7. Then the existing map/port bookkeeping, then the lease release.

`killAll()` is the same path: one shared snapshot for the whole fleet, lanes reaped
**concurrently** (serialising ten grace periods would be a visible multi-second stall on quit).

`teardown()` awaits it. Electron gives `will-quit` no way to await, so the shape is: veto once,
await the memoized teardown, quit again. Without that hold, `app.quit()` tears the process down
microseconds after the SIGTERM goes out and the servers survive the fix. A 4s ceiling guarantees
the app can always be quit — an app that won't quit is worse than a leaked server.

`terminalKill` in `ipc.ts` now awaits. That is deliberate: `handleCloseSession` removes the
worktree directory right after it resolves, so the tree holding files open in there is now
provably gone before `git worktree remove` runs.

**No `lsof` anywhere.** Per-pid `lsof` is a TCC prompt per process and `lsof -i :PORT` is the
same thing in kind; the port is never how anything is found. `ps` reads the public kernel process
table and prompts for nothing.

## The lease

`~/.operator/dev-leases.json`, written when a port is handed out (at pty exec, not at `spawn()` —
before exec there is no tree to orphan), deleted on a clean kill, and cleared for this instance
at teardown. Keyed by **`sessionId`** (the Claude session uuid): `terminalId` is a per-run
counter that resets to `t0` every boot, so it correlates nothing across restarts. Atomic write
(temp + rename) like `store.ts` — a crash is the exact scenario this file exists to survive.

**Deviation from the brief, stated plainly.** The brief asked for `devPort` "on the session
record". `sessions.json` is written *wholesale by the renderer* and is opaque to main, so main
patching it would race the renderer — and the renderer cannot write anything during the crash
this is meant to survive. The lease is therefore a main-owned file whose per-session field is
literally `devPort`. If you'd rather it live on `AgentSession`, that is a renderer change and I
can do it, but it will not survive a force-quit.

## The boot sweep — and the finding that redesigned it

One `ps -eww -o pid,pgid,command -E | grep OPERATOR_TERMINAL_ID=` at boot, before the first port
is handed out (a previous run's orphan bound to 1422 is how "the dev server won't start" becomes
the user's problem).

I ran that sweep for real before trusting it. **The env tag alone is not evidence of an orphan.**
Everything a lane ever starts inherits `OPERATOR_TERMINAL_ID`, and the sweep returned:

```
93190 93190 /Applications/Operator.app/Contents/MacOS/Operator   OPERATOR_TERMINAL_ID=t0
93276 93276 claude                                               OPERATOR_TERMINAL_ID=t0
 9061  9061 postgres -D /opt/homebrew/var/postgresql@16 -p 5433  OPERATOR_TERMINAL_ID=t0
```

The first is **the running Operator itself** — launched from a tagged shell, so it inherited the
tag; `kill(-93190)` at boot is the app killing itself. The second is one of eleven **live lanes**.
The third is **the user's database**, started inside a lane at some point. The obvious rule
("tagged, and not obviously ours ⇒ reap") destroys all three. My own `ps | grep` inherited the tag
too.

So the sweep has **three gates, all of which must pass**:

1. `OPERATOR_APP_PID` (new env tag, set at spawn) must name an Operator that is **dead**. No tag
   ⇒ **skipped**, because a live Operator's lane and a dead one's leavings are indistinguishable
   without it.
2. A **stale lease** must name the same terminal id *and* port — proof that this exact lane never
   shut down cleanly, not merely that some lane once touched this process.
3. The leased port must **still be held**, by loopback connect (`port-probe.ts`, extracted from
   `terminals.ts` so both callers give the same answer). Nothing answering ⇒ nothing to free ⇒
   nothing signalled. This is what spares the postgres: it is on 5433, not on the lease.

`sessions.json` is read and joined in: tagged rows owned by a live app pid mark live terminal
ids, and the roster maps those to session uuids, which is the key leases are filed under — so a
lease can be spared on the strength of the roster, not only its own `appPid`.

**Consequence, stated because it is a real limitation:** the ~60 orphans already on this machine
carry no `OPERATOR_APP_PID`, so they will **not** be auto-reaped. Their owner is unprovable and
guessing kills a running app. Orphans created from this build onward are covered. To clear the
existing ones by hand:
`ps -eww -o pid,pgid,command -E | grep OPERATOR_TERMINAL_ID=` and kill the groups you recognise
as dev servers.

## Tests

37 new unit tests over the pure decisions, against fake `ps` tables (`reap.test.ts`,
`leases.test.ts`) — tree walk across group boundaries, root inclusion, pid-1 refusal, cycle
termination, distinct-pgid collapse, self-group / pgid-0 / pgid-1 exclusion, env-tag parsing
(including the suffix-collision case), the three gates, and the lease store's replace / release /
corrupt-entry behaviour. The three not-orphans above are a test fixture verbatim, so the naive
rule cannot come back.

| | |
|---|---|
| `tsc --noEmit -p electron/tsconfig.json` | **0** |
| `vitest run` (electron) | **265 passed, 18 files, 0 failed** (was 226) |
| `tsc --noEmit` (root) | **0** |
| `npm test` (root) | **765 passed / 33 failed — unchanged from the clean tree** |

The 33 root failures are the pre-existing jsdom-25-under-Node-26 breakage (`localStorage`
undefined) documented in `dev/results/titlebar-drag.md`; nothing here touches `src/`.

## Not verified

The signalling itself is not exercised end-to-end — that needs a real lane with a real dev server
and a real quit, which is a GUI check. What *is* verified: both `ps` invocations run correctly on
this machine, the sweep returns the rows above, and every decision function is unit-tested.
Worth an eyeball: close a lane running `npm run dev` and confirm the port frees; quit the app
with two such lanes open and confirm the same.
