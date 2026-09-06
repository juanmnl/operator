# Result — dev-port allocation that checks reality (Code lane), 2026-09-05

Brief: `dev/briefs/port-allocation-fix.md`. Branch: `operator/e78fc0`, rebased onto `8a5a27f`.

## The new contract, in one paragraph

Operator hands a lane a dev port only after proving it is available at that instant: the port is
not in this process's own reservation map, no lease in `dev-leases.json` claims it (which covers a
second Operator instance and an orphan the boot sweep has not reaped), and a real `bind()` on both
`127.0.0.1` and `[::1]` succeeds. A lane in a directory that already has a reservation still shares
it — that rule is unchanged and deliberate — but only when the shared port is either unbound (the
sibling has not started its server yet) or held by a process we can prove one of our own lanes
started, inferred from the `ps -E` tag sweep exactly as the preview's attribution does it. If a
stranger has taken the port over, the new lane gets a fresh one and the cwd's reservation is
repointed. Because that is now true, the system-prompt hint can state it: the agent is told the
port was verified free at launch and is only ever shared with another session in the same
directory, so anything already answering on it is that server and should be reused rather than
duplicated — and is told explicitly not to try to identify the process holding a port, since the
call that would answer it (`lsof`) fires a macOS TCC prompt and is forbidden here.

## What changed

**`electron/src/main/port-alloc.ts` (new).** The decision, pure over three injected probes
(`isFree`, `leased`, `sharedHolderIsOurs`). It lives outside `TerminalManager` for the same reason
`port-attribution.ts` does: the manager needs a pty and an Electron `app` to exist at all, so the
branches worth testing cannot be reached from a test while they live inside it.

**`electron/src/main/port-probe.ts`.** Added `isPortFree` beside the existing `isPortLive`. They
are not the same question and the file now says so: a `connect()` asks "is something accepting
here", a `bind()` asks "could I take this", and they disagree exactly where it matters — a socket
bound with no accept loop, or bound to one loopback only. Both families are probed, mirroring
`port_free` in `lib.rs`, and `exclusive: true` stops a `SO_REUSEPORT` share from reporting an
occupied port as free.

**`electron/src/main/terminals.ts`.**
- `allocPort` is now async and delegates to `allocatePort`, supplying the real bind, the real lease
  file, and the real process table.
- `sharedHolderIsOurs` answers the ownership question with `snapshotPs` + `sweepTagged` +
  `ownDeepPids`. The claimant must be **deeper than `claude`**: `OPERATOR_DEV_PORT` is set on the
  pty itself, so a lane's own shell and its `claude` child carry the tag forever whether or not a
  dev server is running — matching on the tag alone would call every reservation "ours" and
  reinstate the bug. It **fails closed**: if the process table cannot be read, we do not know the
  holder is ours.
- A displaced reservation logs under `[ports]`, so the 2026-09-05 failure is now visible at the
  moment it is caught rather than inferred later from a wrong preview.
- `reportStillBound` runs after `reapAndForget`: if the port is still bound once the lane is
  reaped, it names the holder from the `ps` snapshot — a tagged process still carrying the port, or
  a command line mentioning it — and says plainly when it cannot attribute the holder, rather than
  naming a plausible pid. Never awaited by the kill path; a diagnostic must not slow a close or
  fail one.
- `buildCommand` and `spawn` became async (one `await` added at the `ipc.ts` call site).

**Allocation is serialized.** This is the one hazard the async rewrite introduced and it is worth
calling out: the old scan was synchronous, so "pick a port" and "record it" could not interleave.
With awaits between them (a lease read, a bind per candidate), two lanes launching at once — open a
project, or *Start all* — would both scan the same window, both find the same first free port, and
both take it. A promise chain in `TerminalManager` makes each allocation wait for the previous one
to have written its reservation. Two tests cover it, including one that deliberately demonstrates
the unserialized collision so nobody removes the gate as redundant.

## Tests — 16 new, in `electron/src/main/port-alloc.test.ts`

The three the brief asked for, each isolating one rule:
- **skips a bound port** — the 2026-09-05 failure, a stranger holding the reservation.
- **skips a foreign lease** — and the test states why a bind-check alone is not enough: a leased
  port can be entirely unbound, because the lane holds it while its server is starting or between
  restarts.
- **re-allocates when the shared holder is a stranger** — and asserts the cwd is repointed, so the
  next lane joins the new port instead of re-deciding against the same stranger.

Plus: the ordinary path still shares a cwd port with a sibling; a bound port whose holder **is**
ours is still shared; the three exclusions combine rather than one masking another; a failed
re-allocation leaves the old reservation in place instead of stripping it; the window being full
returns `undefined` so the lane still launches; and `isPortFree` is exercised against **real
sockets** rather than a stub, including a v6-only listener — the case a v4-only probe reads as free,
which is the bug `port_free`'s own comment in `lib.rs` records.

## Gates

| Gate | Result |
|---|---|
| `cd electron && npm test` | **404 pass / 0 fail**, 23 suites (was 390/22) |
| `cd electron && npm run typecheck` | clean, both tsconfigs |
| `cd electron && npm run build` | clean, main + renderer |
| `npm test` (renderer) | 1008 pass / 0 fail — untouched by this change |
| `cargo test` | 179 pass / 0 fail — untouched |

## Rust: not mirrored, and why

`alloc_port` in `lib.rs` **already** bind-checks fresh allocations via `port_free`, so the headline
gap does not exist on that side. The gap it does share is the same-cwd share branch, which returns
the sibling's port with no check — and mirroring the fix there is not trivial, which is the
condition the brief set. The check requires proving the holder is ours, and the evidence for that
is the `ps -E` tag sweep plus `dev-leases.json`; the Rust side has neither, and its port registry
is in-memory only (`PORT-LEDGER.md:37` already flags this as unreconciled between shells). A
bind-check alone cannot substitute: a legitimately shared sibling's server is *also* bound, so
re-allocating on "bound" would delete same-cwd sharing rather than make it safe. Electron is the
shipping shell; this stays a known divergence.

## Not done

- Nothing merged. One commit on `operator/e78fc0`.
- **Out of scope by the brief:** the reparented-orphan reaper (`reap.ts:319`). `reportStillBound`
  makes its failures visible but does not close the hole.
- **Noticed, not changed:** Rust keys `portsByCwd` on `canonical_cwd(cwd)` while Electron keys on
  the raw string, so `/tmp/p` and `/private/tmp/p` share a port under Tauri and not under Electron.
  It affects sharing granularity, not the correctness of this fix, and normalising it would change
  which lanes share a port — a behaviour change that belongs in its own brief.
- No GUI verification. The allocation path is exercised by tests against real sockets, but no lane
  was launched from a packaged app.
