# Brief — Dev servers must die with the lane, the session, and the app

## The evidence (real, measured on the user's Mac today, 2026-08-29)
24 orphaned vite dev servers were live at once, the oldest **11 days**, spread
across mantel, mantel-landing, el-encanto, enfant-terrible and operator itself.
EVERY ONE had a parent chain terminating at launchd (ppid 1) — no live session
owned any of them. One had been squatting port 1420 since Aug 20 and blocked a
new session from taking its own reserved port. Load average was 3.83.

Shape of a typical orphan:
    npm exec vite --port 1423 --strictPort        (ppid 1)
     └─ node .../node_modules/.bin/vite --port 1423 --strictPort

## Why the existing kill path misses them
`kill_and_reap` / `terminal_kill` kill the pty's **direct child**. A dev server
is started by the AGENT inside the pty (`npm run dev &`, `nohup`, a background
Bash tool call), so it is a grandchild that reparents to init the moment its
shell exits. Killing the pty child therefore leaves it running forever, holding
its port. This is why the ports are never freed and the count only grows.

## You already have most of the machinery — USE IT, do not rebuild it
- `electron/src/main/port-attribution.ts` — reads `ps -E` rows and matches
  processes whose `OPERATOR_DEV_PORT` equals a given port. Its own header warns
  that a naive env check does not work and explains the subtlety; read it first.
- `electron/src/main/reap.ts:248` — already pulls `OPERATOR_DEV_PORT` via
  `envTag(command, ...)`.
- `electron/src/main/terminals.ts:193` — where `env.OPERATOR_DEV_PORT` is set,
  i.e. the tag that makes a descendant attributable to a lane.

## What to build
Reap a lane's dev servers at THREE lifecycle points. All three, not one:
1. **Lane close** — closing a single lane/terminal.
2. **Session/project close** — `closeProject` routes every lane through
   `handleCloseSession`; the reap must ride that path, not be bolted beside it.
3. **App quit** — including the quit-guard path in `src-tauri/src/quit.rs` /
   its Electron equivalent. NOTE: `ef75b14` showed the quit guard can
   `preventDefault()` a quit; make sure the reap still runs on the paths that
   DO proceed, and that adding it cannot itself veto or hang a quit. A reap that
   blocks quitting is worse than the leak.

Prefer killing the process GROUP (or every process carrying that lane's
`OPERATOR_DEV_PORT` tag) over the direct child alone — the tag is what survives
reparenting and is the only reliable link back to the lane.

## Hard constraints
- **NEVER pattern-kill.** No `pkill -f vite`, no `killall node`. Resolve to
  explicit PIDs, attributed to a lane by its port tag, and kill those. The user
  has other projects' dev servers running that must survive.
- **Never kill an unattributable process.** If the tag does not link it to the
  lane being closed, leave it alone and log why.
- SIGTERM first, escalate only if it is still alive after a grace period.
- Free the reserved port in Operator's registry as part of the same teardown.

## Also wanted (smaller, same area)
A way for the user to reap existing strays without restarting the app —
`worktree_reap_dry_run` already exists in Rust with NO frontend caller. A
Settings surface listing orphaned dev servers with their port, project and age,
and a button to kill the selected ones, would have prevented today entirely.
Do this ONLY after the three lifecycle points above are done and tested.

## Deliverable
Branch off `origin/main` (NOT local main — it has diverged, 11 unpushed
commits). Write `dev/results/reap-dev-servers.md`: what you changed, the three
lifecycle points with file:line, how attribution is proven, test results, and
anything deliberately left out. Add unit tests for the attribution and the
escalation logic. Do not GUI-verify — that is the user's.
