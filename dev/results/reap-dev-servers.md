# Result — Dev servers now die with the lane, the session and the app

Branch `operator/reap-dev-servers`, cut from `origin/main` (`d22538b`), one commit `d33e85d`.
Local `main` was **not** used: the worktree sat on `operator/d16e40`, which carried the 11
unpushed commits the brief warned about. Those are untouched and still on that branch.

## What was already there, and what was actually broken

Most of the machinery the brief pointed at exists on `origin/main` and works: `reapTree` walks
the pty subtree and kills by process **group**, `kill()` runs it on lane close, `killAll()` runs
it on quit, and a boot sweep cleans up after a dead Operator. None of that needed rebuilding.

The hole is narrower and worse than "the kill path misses grandchildren". `reapTree` walks
**down from the pty shell**, which is complete only for processes still attached to it. A dev
server the agent starts — `npm run dev &`, `nohup`, a backgrounded Bash tool call — outlives the
intermediate shell that launched it, and reparents to launchd **at that moment**, while the lane
is still open. By the time the lane closes there is no `ppid` path from the shell to it, so the
walk cannot see it and no signal is ever sent.

Measured on this machine, mid-task, with `ps -eww -o pid,ppid,pgid,command -E`:

```
29977  ppid=1  pgid=29958  OPERATOR_TERMINAL_ID=t0 OPERATOR_DEV_PORT=1420 OPERATOR_APP_PID=28793
```

`ppid 1`, and 28793 is the **running** `Operator.app`. So this is not a crash leftover that the
boot sweep would eventually collect — it is a live app leaking while it is up, which nothing in
the lifecycle ever revisited.

## The three lifecycle points

All three already funnel through one method, so the fix rides that path rather than sitting
beside it:

| # | Point | Route | Where |
|---|---|---|---|
| 1 | Lane close | `terminalKill` → `kill()` | `electron/src/main/ipc.ts:148` → `terminals.ts:321` |
| 2 | Session / project close | `closeProject` → `handleCloseSession` → `terminalKill` → `kill()` | `DashboardView.tsx:1114` → `terminals.ts:321` |
| 3 | App quit | `teardown()` → `killAll()` → `kill()` | `index.ts:150` → `terminals.ts:505` |

All three land in `reapAndForget` (`terminals.ts:330`), which is where the stray sweep was added.
Quit was checked against the brief's warning about `ef75b14`: `teardown()` is memoized and is
reached from every branch that proceeds (`QuitGuard.decide`, the non-asking branches, the update
path, and `will-quit`). The reap adds no new veto — it cannot `preventDefault()` anything — and
it inherits the existing `TEARDOWN_DEADLINE_MS = 4000` race at `index.ts:124`, so it cannot hang
a quit. Both `snapshotPs` and `sweepTagged` already swallow their own errors and return empty.

## How attribution is proven

`laneStrays` (`reap.ts:388`) is pure over a `ps -E` sweep. A row is reaped only when **all** hold:

1. `OPERATOR_TERMINAL_ID` equals the closing lane's id;
2. `OPERATOR_APP_PID` equals **this** Operator's `process.pid`;
3. `OPERATOR_DEV_PORT` equals the lane's reservation (when it reserved one);
4. it is not pid/pgid ≤ 1, and not Operator's own pid or group;
5. it is not already reachable by the tree walk.

**Gate 2 is the one that matters, and it is not optional.** Terminal ids come from `nextId()` as
`t0`, `t1`, … **per app run**, so `t0` in this run and `t0` from a run eleven days ago are the
same string and a different lane — in the live snapshot, a different *project*. Matching on the
terminal id alone would make closing a lane in `operator` kill an 11-day-old server in `mantel`.
That is the cross-project accident, and the app pid is the only thing that rules it out.

Every near miss — a row carrying this lane's id that was still refused — is logged with its
reason (`terminals.ts:351`). Rows belonging to other lanes are skipped silently; logging every
tagged process on the machine would bury the one line that matters.

No pattern matching anywhere. Nothing greps for `vite` or `node`; the only inputs are the env
tags and the `ppid`/`pgid` columns. `ps` only, never `lsof`, per the standing TCC rule.

Kill order is unchanged and now covers strays in the same pass: SIGTERM to each distinct group,
poll for up to `GRACE_MS = 1500`, then SIGKILL the survivors **by group** (a survivor is usually
a supervisor that would respawn its worker). Strays join the tree's pid set *before* the groups
are collected, so a close still costs one grace period, not two.

## Two other defects fixed on the way

- **A pty that had already exited skipped the reap entirely.** `reapAndForget` did all its work
  inside `if (pid)`, and `t.pty` is null once the pty exits on its own (the agent quits
  `claude`). The lane's dev server was then never signalled by anything. The sweep now runs with
  or without a live pty; `reapTree(0, …)` walks nothing and signals only the strays.
- **`killAll` now shares one `ps` pair** across the fleet rather than one per lane. The tagged
  sweep dumps every process's environment, so per-lane it would be the most expensive thing
  quitting does.

## quit.ts — the freeze and the two-dialog race

Raised mid-task and fixed in the same commit; both defects were in the same six lines.

- **The freeze.** `dialog.showMessageBox(options)` with no parent window is Electron's
  application-modal branch — `[NSAlert runModal]`, a nested run loop on the browser process's UI
  thread. Every window stops painting and the app stops answering. Both call sites now pass the
  window, taking the `beginSheetModalForWindow:` branch, and `modalParent()` (`quit.ts:73`)
  restores/shows/focuses it first: a sheet on a minimized window is a question nobody can see
  attached to an app that will not quit, which is the freeze again from the user's side.
- **The race.** A renderer acking after `DIALOG_ACK_MS = 400` has already shown its own dialog,
  so two were up and the guard obeyed both. Worse, native **"Stay open" fell off the end without
  closing the question**, so a later "Quit anyway" from the stale dialog quit an app the user had
  just chosen to keep. `decide()` is now latched — first answer wins, the second is dropped — and
  native records both answers. A second ⌘Q re-emits to the renderer (deliberate, for a respawned
  renderer) but no longer re-arms the timer or clears the latch.

The two fixes reinforce each other: a document-modal sheet blocks the web contents underneath, so
a stale renderer dialog left by a late ack cannot be clicked while the sheet is up.

## Tests

`electron/src/main/reap.test.ts` +19, `quit.test.ts` +8, on tables modelled on the real snapshot.

- **Attribution** — reaps a reparented server carrying this lane and this run; refuses the same
  terminal id from another Operator run (the cross-project case); refuses a row with no
  `OPERATOR_APP_PID`; refuses a foreign port; never returns Operator itself; ignores other lanes
  without reporting them; drops rows the tree already reaches.
- **Escalation** — SIGTERM only when the tree dies inside the grace period; SIGKILL **by group**
  when it does not; never signals our own group *even when Operator is inside the tree being
  reaped*; strays reaped alongside the tree in one grace period; strays reaped with no tree at all.
- **Quit** — the dialog is parented; a minimized window is raised first; a contradicting second
  answer is dropped; native "Stay open" closes the question; a second ⌘Q raises no second dialog.

Every new test was **mutation-checked**: each of the five guards (self-pgid exclusion, the app-pid
gate, the `decide` latch, native "Stay open" closing the question, the parent window) was removed
in turn and the matching tests failed. None of them is a test that cannot fail.

```
electron:  tsc -p tsconfig.json && tsc -p tsconfig.renderer.json   clean
electron:  vitest run                     23 files, 404 tests passed (was 381)
root:      tsc --noEmit                                            clean
```

**The root renderer suite has 33 pre-existing failures** (`forgotten-projects`, `ghost-probe`, 3
others) — `Cannot read properties of undefined (reading 'clear')`, a jsdom `localStorage` problem.
Verified identical in your own `~/Developer/operator` checkout, and the root vitest config only
includes `src/**`, so nothing in `electron/` can reach them. Not mine, and not fixed.

## Deliberately left out

- **The Settings surface for existing strays.** The brief gates it behind the three lifecycle
  points, which are done — but it is a frontend feature (main-process enumeration, IPC, preload,
  a Settings section, a kill action) that I cannot GUI-verify, and half of it is worse than none.
  Recommend dispatching it as its own task.
- **The pre-tag orphans are still unreachable by any automatic path.** They carry no
  `OPERATOR_APP_PID`, so nothing can prove whose they are, and gate 2 refuses them by design —
  the same trade `staleTaggedRows` already makes. Weakening it is how a running app gets killed.
- **A long-lived side effect started by a lane of this run *will* now be reaped when that lane
  closes** (the `postgres -p 5433` shape noted in `reap.ts`). This is deliberate and consistent:
  the tree walk already killed such a process without any port gate when it was still a
  descendant, so applying a stricter rule to the reparented case would be incoherent. The boot
  sweep keeps its stricter three gates. Flagging it because it is a real behaviour change.
- **Not GUI-verified**, per the brief. No process on this machine was signalled by me.

## Clearing today's 24 — explicit PIDs, no pattern-kill

Still live as of 2026-08-29 13:00. Eleven groups, each 3 processes. Only `29958` carries an app
pid (28793, your running Operator) — the rest predate the tag, which is exactly why the new code
refuses them and why this list has to be a decision you make:

| pgid | port | project | started | app pid |
|---|---|---|---|---|
| 10886 | 1423 | mantel-9f4a40 | Aug 18 20:58 | none |
| 29958 | 1420 | operator | Aug 29 10:57 | 28793 |
| 31277 | 1446 | mantel-landing | Aug 19 08:25 | none |
| 35117 | 1452 | mantel | Aug 20 13:26 | none |
| 39121 | 1425 | enfant-terrible | Aug 20 14:00 | none |
| 51775 | 1447 | mantel-9f4a40 | Aug 19 11:24 | none |
| 65576 | 1431 | mantel-29a880 | Aug 21 20:28 | none |
| 73623 | 1428 | operator | Aug 21 08:57 | none |
| 75682 | 1432 | mantel-landing | Aug 24 19:12 | none |
| 83637 | 5188 | el-encanto-3bae00 | Aug 22 15:06 | none |
| 98553 | 1426 | el-encanto | Aug 20 19:21 | none |

Group `29958` is the one holding **port 1420** — the squatter the brief describes. To end them,
by group id, after re-checking the list is still current:

```sh
ps -axo pid,ppid,pgid,lstart,command | awk '$2==1' | grep -E 'npm exec vite|bin/vite'   # re-check
for g in 10886 29958 31277 35117 39121 51775 65576 73623 75682 83637 98553; do kill -TERM -$g; done
```

I have not run this. Note `1420` is Operator's own dev port — if you have `npm run dev` open on
this repo right now, drop `29958` from the list first.
