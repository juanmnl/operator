# RESULT — el-encanto's lanes were unroutable because the join used the ephemeral key

Build clean · `npm test` **650** (+8) · `cargo test` **140**.

## Lead: what rehydration restores today, and what it drops

The re-attach (`DashboardView.tsx`) rebuilds a tab for **every** live pty — all projects, not just
the active one — and it does restore `projectId`/`roleId`. But it restores them through exactly one
lookup:

```ts
const byId = new Map(savedSessions.filter(s => s.terminalId).map(s => [s.terminalId!, s]))
const s = byId.get(t.id)            // ← the EPHEMERAL key
… projectId: s?.projectId, roleId: s?.roleId
```

**It joins live ptys to saved sessions on `terminalId`.** When that lookup misses, the tab is still
created — `id`, `cwd` and the pty all fine — with `projectId` and `roleId` **undefined**. That tab
is alive, visible in the strip, and invisible to `pickLaneTab`, which requires both. `routeDispatch`
then returns `queue`, and the dispatch silently never leaves.

So: rehydration drops **the stamping, and only the stamping** — which is precisely the field
routing depends on and nothing else does. Everything durable stays correct, which is why the
measurement in the brief found six healthy lanes and no fault anywhere except in the renderer's
view. **The same disease as the task-lifecycle leak**, and named as such in the brief: keyed on the
ephemeral id while the durable one (`claudeSessionId`) sits right there, correct.

## The fix

**1. The backend now reports the durable identity.** `TerminalInfo` gained `claudeSessionId` and
`projectId`, sourced from the transcript registry (`TrackRegistry::identity`) — Rust state, set at
spawn, which outlives any renderer respawn. The renderer previously had no way to join on anything
but the counter, because the counter was all the backend told it.

**2. The re-attach joins on `claudeSessionId` first**, falling back to `terminalId` for rows saved
before the backend reported the uuid, and falling back again to the backend's own `projectId` so a
pty with no saved row at all is still routable.

**3. Recovery without a restart, and it is continuous.** The 5s reconcile poll now re-stamps any
live tab missing its project or role, keyed the same way. That is deliberately not a one-shot at
mount: the cure for a lane that has come unstamped is waiting five seconds, not relaunching six
healthy agents. It also means a respawn heals itself whether or not the mount-time join succeeded.

**4. The bug state is now named and surfaced.** `orphanTabs()` (pure, tested) is "alive but
unroutable" — `pickLaneTab` cannot distinguish that from "no lane running", and both answer
`queue`. What re-stamping *cannot* heal raises a toast, **once per terminal id**: a banner that
repeats every 5s is one people learn to ignore.

## The regression test, and it bites

`?driftIds=1` in the mock reproduces the exact shape: ptys alive, saved rows correct, stored
`terminalId` no longer matching the live pty's id.

```
OLD code, drifted ids : { laneRows: 0, orbs: 4 }   ← every lane unroutable, all still alive
NEW code, drifted ids : { laneRows: 3, orbs: 4 }   ← recovered
NEW code, ids match    : { laneRows: 3, orbs: 4 }   ← healthy case unchanged
```

Zero lane rows with four live orbs is el-encanto on screen: agents running, none reachable.

## Did they share a cause with the undelivered-retry work? No.

The brief asked. They are genuinely different defects and the fixes do not touch: `undelivered` is
a message that **was sent** and whose turn never started (a pty-timing race under load); this is a
message that was **never routed** because the renderer could not find the lane. Related symptom —
"the lane isn't getting work" — different halves of the path. Worth noting they compound: a lane
that is unroutable queues silently, and a lane that is routable but loaded strands the message in
its composer. Both are now recoverable, by different means.

## Verify

| Bullet | Result |
|---|---|
| Dispatch to each live lane is delivered, not queued | Lane rows restored under drift (0 → 3); a stamped tab is what `pickLaneTab` needs |
| Survives a renderer respawn | `?driftIds=1` is that test, and it fails on the old code |
| A genuinely dead lane still routes to queue/relaunch | `orphanTabs` and the re-stamp both skip `ended` tabs; `pickLaneTab`'s `ended` guard untouched |
| A stale `terminalId` does not orphan a live lane | The drift fixture *is* a stale terminalId; recovered via `claudeSessionId` |
| `npm test`, build | 650, clean (+ `cargo test` 140) |

## Not done / honest limits

- **Not verified against the live el-encanto lanes.** The fix is verified against a fixture that
  reproduces the failure; confirming it on your six requires a relaunch (Rust changed) and is your
  first real check. Nothing was killed or relaunched, and `sessions.json` was not touched.
- **I could not confirm which trigger produced the drift on your machine** — a backend restart
  reassigning ids is the mechanism the fixture models, and the renderer respawn is the brief's
  hypothesis. The fix does not depend on knowing: it removes the dependency on the ephemeral key
  either way.
- **The orphan toast is the only surfacing.** A persistent per-lane badge would be better and needs
  UI design; a toast is what could be added honestly in this pass.
