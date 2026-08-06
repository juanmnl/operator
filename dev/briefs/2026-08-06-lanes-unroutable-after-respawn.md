# el-encanto's lanes are ALIVE but unroutable — the renderer lost its tabs, not the ptys

User, 2026-08-06: *"lanes got disconnected and are not receiving dispatches in el-encanto project."*

## Measured first — nothing is disconnected

`~/.operator/sessions.json` vs live processes, all six lanes:

```
research  tid=t23  claudeSessionId=e0f4ee0c  LIVE
operator  tid=t21  claudeSessionId=950269e7  LIVE
review    tid=t25  claudeSessionId=e86fd61e  LIVE
qa        tid=t26  claudeSessionId=56458bc9  LIVE
code      tid=t22  claudeSessionId=6f3ae517  LIVE
design    tid=t24  claudeSessionId=9eb2d0f8  LIVE
6 live, 0 stale — every row carries projectId el-encanto-799f5
```

The ptys are running, the durable records are correct and complete, and `claudeSessionId` matches a
live `--session-id` for **every** lane. **The failure is entirely renderer-side.**

## The mechanism

`pickLaneTab` (`src/renderer/lib/dispatch.ts:49`) counts a tab as a role's live lane only if
`t.projectId === projectId && t.roleId === roleId && !t.ended`. `routeDispatch` then returns
`{kind:'send'}` only when that lookup succeeds — otherwise `{kind:'queue'}`. So a dispatch to a lane
whose **tab** is missing or unstamped is silently queued rather than delivered, no matter how alive
the pty is.

**Most likely trigger: the renderer respawn.** `dev/briefs/2026-08-05-forget-and-sidebar-restart-RESULT.md`
established the WKWebView renderer is being killed and respawned under memory pressure (currently
peaking ~944MB; watcher log at `/tmp/webcontent-watch.log`). A respawn wipes renderer state and
re-hydrates. If rehydration does not rebuild the tab list **with `projectId` and `roleId` restored**,
routing dies exactly like this while everything durable stays healthy — which is precisely what was
measured.

**This is the same disease as the task-lifecycle leak**: state keyed on the ephemeral `terminalId`
while the durable key (`claudeSessionId`) sits right there, correct. That leak's fix keyed on
`claudeSessionId`; routing did not get the same treatment.

## Build this

1. **Find out what rehydration actually restores.** `terminalList()` is called at
   `DashboardView.tsx:470` and `:1895`. Determine whether, after a respawn, tabs are rebuilt for
   **every** project or only the active one, and whether `projectId`/`roleId` survive. Report the
   answer — it decides everything below.
2. **Re-link tabs by `claudeSessionId`, not `terminalId`.** Every record needed is already in
   `sessions.json` (`claudeSessionId`, `projectId`, `roleId`, `cwd`). Rehydration must restore the
   role/project stamping on reattached terminals so `pickLaneTab` can find them. A `terminalId`
   reassigned by a new Rust process must not orphan a lane.
3. **Make an unroutable-but-alive lane visible.** Today it fails silently into `queue`. If a lane's
   pty is alive and its record is valid but no tab matches, that is a **bug state**, not a "no live
   lane" state — surface it rather than quietly queueing. Six lanes stopped receiving work and the
   only signal was the user noticing.
4. **Recovery without a restart.** Given valid durable records, Operator should be able to re-attach
   and re-stamp on demand. Killing six healthy agents to fix a renderer bookkeeping error is not an
   acceptable remedy.

## Do not

- Do not "fix" this by pruning or rewriting `sessions.json` — it is **correct**. The bug is in the
  renderer's view of it.
- Do not kill or relaunch the six live lanes as part of the fix.
- Do not entangle this with the undelivered-retry work
  (`2026-08-06-undelivered-retry-and-open-lane.md`). That repairs messages that were *sent* and
  never arrived; this is messages that were **never routed at all**. Related symptoms, different
  defects — say so in the RESULT if you find they share a cause.

## Verify

- With the six el-encanto lanes running, a dispatch to each is **delivered**, not queued.
- Simulate a renderer respawn (reload the webview) and re-test — routing must survive it. This is
  the actual regression test; without it the fix is unproven.
- A lane whose pty is genuinely dead still routes to `queue`/relaunch as before.
- A stale `terminalId` in `sessions.json` does not orphan a lane whose `claudeSessionId` is live.
- `npm test` green (637 on `main` = `c06fa61`), build clean.

## Output

Write `/Users/juanmnl/Developer/operator/dev/briefs/2026-08-06-lanes-unroutable-after-respawn-RESULT.md`
(absolute path, main repo). Lead with what rehydration restores today and what it drops.
