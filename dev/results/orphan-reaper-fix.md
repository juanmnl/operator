# Result — dev servers that outlive their lane (Code lane), 2026-09-05

Brief: `dev/briefs/orphan-reaper-fix.md`. Branch: `operator/e78fc0`, rebased onto `8309900`.

Everything below was checked against **one live `ps -eww -o pid,pgid,command -E`** on the dev
machine, not against the brief's description of it. Three of the four holes turned out to be
slightly different from the brief's reading, and one of them was the opposite of what it looked
like — details under each.

## Gates

| Gate | Result |
|---|---|
| `cd electron && npm test` | **446 pass / 0 fail** (was 412; +34) |
| `cd electron && npm run typecheck` + `build` | clean |
| `npm test` (renderer) | 1008 pass / 0 fail |
| root `tsc` + `npm run build` | clean |
| `cargo test` | 183 pass / 0 fail |

---

## Hole 1 — does lane close reap a ppid-1 tagged server? **Yes. Verified, now tested.**

Measured row, lane t14 open at the time:

```
28458  ppid=1  OPERATOR_TERMINAL_ID=t14  OPERATOR_DEV_PORT=1431  OPERATOR_APP_PID=55647
       node server.mjs
```

`laneStrays` catches it: `terminalId` matches, `appPid` matches, and the tree walk never sees it
because there is no `ppid` path from the pty shell. The tag survives reparenting, which is the
whole reason the tag exists. **No fix needed — the machinery was already correct.** What was
missing is a test pinning that exact row shape, which now exists, along with the three refusals
around it (another Operator's run, an untagged owner, a row the tree walk already reaches).

**A near miss worth recording,** because it is why the untagged refusal must never be relaxed:

```
 9061  ppid=1  OPERATOR_TERMINAL_ID=t0  OPERATOR_DEV_PORT=1420  (no app pid)
       /opt/homebrew/.../postgres -D /opt/homebrew/var/postgresql@16
85586  ppid=1  OPERATOR_TERMINAL_ID=t1  OPERATOR_DEV_PORT=1421  (no app pid)
       /Applications/Xcode.app/.../Python3
```

Homebrew's postgres and an Xcode Python, both carrying lane tags they inherited from a shell where
those variables were exported, both naming a lane that was open at the time. With an app pid they
would have been killed. There is a test for postgres specifically.

## Hole 2 — the second server. **Real, but not for the reason the brief gives.**

The brief reads "t18 holds two servers on two ports (1432+1434)". The measurement says otherwise:
t18 had **three** server trees alive at once — 25919, 26903, 36462 — and every row carried the
**identical** `OPERATOR_DEV_PORT=1432`.

That is the important correction. **`OPERATOR_DEV_PORT` is the RESERVATION, inherited from the pty
env — not the port a process bound.** A lane that restarts its dev server three times produces
three trees all carrying the same value, whatever each one is actually serving. So "a second
tagged server on another port" is not a state the tag can express, and the real port would need
per-pid `lsof`, which is forbidden.

Which makes the existing rule in `refuseStray` a leak rather than a guard:

```ts
if (lane.devPort != null && r.devPort !== lane.devPort) return `OPERATOR_DEV_PORT=… is not this lane's …`
```

It never separated a restarted server from the current one — they share the value. What it *did*
separate was a row whose reservation had since drifted, and it refused that one **permanently**,
because nothing in the lifecycle revisits what a close declined. **Removed.** `terminalId` +
`appPid` already identify a lane uniquely: ids come from a monotonic counter per app run and are
never reused, so within one app pid there is exactly one `t18`, and anything carrying both tags
descends from that lane's pty. There is nothing left for a third check to disambiguate.

The old test that pinned the rule is replaced by one pinning the new behaviour, and the two
refusals in that fixture that are still correct (another run's app pid, no app pid) are asserted
to be untouched.

## Hole 2b — the double allocation, from the port brief's correction. **Found the cause.**

The correction says the 1425 holder was our own lane t8, so the same app double-allocated. Measured,
both lanes alive, both from app 55647:

```
93480  OPERATOR_TERMINAL_ID=t8   OPERATOR_DEV_PORT=1425   …/huridocs/uwazi_app/app/node_modules/.bin/vite
 2885  OPERATOR_TERMINAL_ID=t25  OPERATOR_DEV_PORT=1425   claude  (the operator checkout)
```

The cause is not the scan, it is the release. Same-cwd sharing hands **one** port to every lane in
a directory, while `portsByCwd` has room for one entry and no notion of how many lanes hold it.
Close released it unconditionally:

```ts
if (t.devPort && this.portsByCwd.get(t.cwd) === t.devPort) this.portsByCwd.delete(t.cwd)
```

So the **first** lane out of a shared directory dropped the reservation while its siblings kept
serving on it — and the next scan, finding that port in neither `portsByCwd` nor a lease it
recognised, handed it to a lane in a different project. `shouldReleaseCwdPort` now releases only
when no other live lane in that cwd still holds the port. The bind-check added in the port task
would catch the symptom, but a reservation map that lies is worth fixing at the source; the check
is a backstop, not a bookkeeping system.

## Hole 3 — the pre-tag orphans the code refuses forever. **Now a user surface.**

`electron/src/main/dev-servers.ts` + a **Dev servers** panel in Worktrees preferences, built on the
same list-then-confirm shape as "Remove N safe worktrees". One `ps` pair per refresh, no per-pid
`lsof`, nothing on a timer, and no select-all — this list contains live lanes' servers, and a
select-all beside a kill button is how someone takes their own work down by reflex.

Each row is classified by how it was attributed, ordered safest-first so a careless click lands on
the harmless row:

| Owner | Meaning |
|---|---|
| `dead-app` | Tagged with an Operator pid that is no longer running. Safest. |
| `abandoned-lane` | Tagged with THIS Operator, but no such lane is open. |
| `untagged` | Dev-server-shaped, under a known project or worktree root, no Operator tag. |
| `live-lane` | A lane is open and using it. Offered, with a warning in the confirm. |

Two deliberate scope limits: an **untagged** row must sit under a project or worktree root the user
owns, or the panel becomes a kill list for every `vite` on the machine; and a **tagged** row is
listed whether or not its command looks like a dev server, because the tag is stronger evidence
than the command shape — t14's measured leak was `node server.mjs`, which matches no dev-server
pattern at all. Operator's own `--mcp-serve` helpers and each lane's `claude` are excluded by name;
they carry the full tag set and killing them frees no port.

The port column is labelled as the **reservation**, not an observed binding, because that is all
the tag can honestly claim.

## Hole 4 — the live app leaking while it is still up. **Now swept every 10 minutes.**

`abandonedLaneRows` + `TerminalManager.sweepAbandoned`, on a 10-minute `setInterval` (unref'd, and
cleared in teardown).

This needed a new predicate rather than a reuse: `staleTaggedRows` returns false for
`r.appPid === selfPid` — "ours, right now" — which is the boot sweep's single strongest reason to
leave a row alone, and ten minutes into a session means the opposite. The distinguishing fact is
the one only a running app has: **which terminal ids are open in it**, read at fire time and not
captured when the timer was armed, so a lane opened during the interval is not reaped as abandoned.

Ten minutes because the cost is one `ps -E` pair (the expensive form) and the leak is measured in
hours and days.

**Dry-run against the live machine:** with 19 lanes open it selects **0 rows**, and correctly
refuses postgres and both Xcode Pythons on the no-app-pid rule. Every safety refusal is separately
tested: another Operator's rows, untagged rows, Operator itself by pid and by group, and pid/pgid 1.

## Tests — 34 new

`dev-servers.test.ts` (28) is organised by hole, with the row shapes transcribed from the live
snapshot rather than invented — the reason the port rule looked defensible for so long is that
nobody had checked what the tag actually contains on a leaked server. `port-alloc.test.ts` gains 6
for `shouldReleaseCwdPort`, including the sibling-still-holding case that is the double allocation.

## Not done

- Nothing merged. One commit on `operator/e78fc0`.
- **No GUI verification.** The Dev servers panel is unexercised in a real window; its handlers and
  classification are covered by tests, but nothing rendered it. Given every row is a kill button,
  this is the part worth looking at before it ships.
- The 10-minute sweep has not been observed firing in a long-running app — only its predicate is
  tested, plus the dry run above.
- **Noticed, not changed:** `envTag` can yield a junk terminal id from a shell whose environment
  contains quoting (`tid='"'"'],` appeared once in the live sweep). Harmless today because such
  rows carry no app pid and are refused anyway, but it means a terminal id read out of `ps` is not
  guaranteed well-formed.
