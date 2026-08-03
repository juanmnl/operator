# Result — the TCC "access data from other apps" prompt is gone

`lsof` is no longer invoked anywhere at runtime. Port attribution now comes from a **candidate
set** the app already owns, filtered by a plain loopback connect. Nothing inspects another
process by any mechanism.

`npm run build` ✅ · `npm test` (515) ✅ · `cargo test` (125, 5 new) ✅ · no new compiler warnings.

---

## ⚠ One premise in the brief was wrong, and it changed the work

> "Banner sniffing from our own pty output — **already built and already wins** over the lsof path"

**It was built, unit-tested, and wired to nothing.** `TerminalPane` declares
`onDevServerDetected` and `detectDevServer` opens with:

```ts
const cb = devServerCbRef.current
if (!cb) return
```

No call site anywhere passed that prop — `TerminalSurface` (the only renderer of
`TerminalPane` outside `ShellSheet`) didn't accept or forward it, and `DashboardView` didn't
pass it. So the callback was always null and the detector returned on its first line. Every
sniffed port the brief was counting on **did not exist**; `SessionToolbar`'s
"sniffed port outranks everything else" comment described an intention, never a behaviour.
The chip and the Preview were fed 100% by the `lsof` path.

Consequence: I could not simply swap `session_ports`' body, or attribution would have
collapsed to the reserved port alone — which projects routinely ignore. **Wiring the sniff was
a prerequisite, not a bonus.** This is the same shape as the fixtures-must-match-reality
lesson: a green unit test on `detectDevServerPort` stayed green through the entire outage,
because it tested the pure function and not the wire.

---

## What changed

### Backend — `src-tauri/src/lib.rs`

| | |
|---|---|
| **Deleted** | `listening_ports()` (the sole `lsof` spawn) and `listening_ports_from()` (its parser) |
| **Deleted** | `descendants()` / `descendants_from()` — the `ps` tree walk, now unreachable |
| **Added** | `port_alive(port)` — `TcpStream::connect_timeout` on `127.0.0.1` **and** `[::1]`, 120 ms |
| **Added** | `live_ports(candidates)` — keeps the candidates that answer |
| **Added** | `PtyManager.sniffed: Mutex<HashMap<String, BTreeSet<u16>>>` + `note_sniffed_port` / `candidate_ports` |
| **Added** | `note_session_port(id, port)` command (registered in the invoke handler) |
| **Rewrote** | `session_ports(id)` → `live_ports(&mgr.candidate_ports(&id))`. Signature unchanged, as the brief asked |

`release_port` now also drops the session's sniffed set, so a recycled port can't keep
answering under a dead session's id.

Both loopback families are probed because they genuinely disagree — a Vite server here bound
IPv6-only, so a v4-only check reports a live server as dead.

### Renderer

- **`TerminalSurface.tsx`** — accepts and forwards `onDevServerDetected`. *This is the line
  whose absence was the bug.*
- **`DashboardView.tsx`** — passes `onDevServerDetected={(port) => window.operator.noteSessionPort?.(t.id, port)}`
  for **every** pane, not just the active one: a background lane's server is still its server,
  and the banner scrolls past exactly once.
- **`operator-bridge.ts` / `env.d.ts`** — `noteSessionPort` added.

### Comments corrected

The brief listed three (`lib.rs:47`, `DashboardView:131-135`, `AppPreviewPanel:111-113`). There
were **six** — all now say candidate-set/loopback instead of process-tree:
`lib.rs` (pid field, `session_ports` doc), `DashboardView:131`, `AppPreviewPanel:76` and `:140`,
`lib/preview-port.ts:5`, plus the bridge.

---

## The new attribution path

```
pty output ──sniff──► noteSessionPort(id, port) ──► PtyManager.sniffed[id]
                                                          │
                    alloc_port ──► PtyManager.ports[id] ───┤
                                                           ▼
                                        candidate_ports(id) = reserved ∪ sniffed
                                                           │
                                       live_ports: TCP connect v4 ∥ v6, keep answerers
                                                           ▼
                                                    session_ports(id)
```

Attribution comes from the **candidate set**, never from the probe. Every candidate is this
session's by construction: either Operator handed it the port, or the session's own pty printed
the URL. A sibling lane's `:5173` is not in the set, so it cannot be attributed here no matter
who is listening — the property the process walk existed to guarantee, preserved without
touching another process.

The sniffed map lives in the Rust `PtyManager`, which outlives a renderer reload — so a banner
that scrolled past before a reload stays attributed. (The history-replay path writes straight to
`term.write` and does *not* re-sniff; it doesn't need to.)

---

## Coverage deliberately dropped

**A port the project chose that we never reserved and never printed a URL for.** The old walk
found it; nothing does now. Covered by `AppPreviewPanel`'s user-initiated **Scan**, which is
TCC-free. Accepted per the brief.

**Deleted tests** (they asserted on removed code — the guardrail):
`listening_ports_dedupes_across_address_families`, `listening_ports_ignores_unparseable_names`,
`descendants_walks_the_whole_tree`, `descendants_excludes_unrelated_processes`,
`descendants_survives_a_cycle`. Note the second of those documented itself as *"the whole reason
we walk pids instead of probing localhost"* — leaving it would have asserted the opposite of
what the code now does.

**Replaced with 5 tests of the real behaviour:** candidate set = reserved ∪ sniffed with no
cross-session leak; sniffed ports accumulate, dedupe and reject port 0; release drops the set;
`port_alive` true for a bound listener and false once dropped; `live_ports` keeps only answerers.

---

## How I verified no process inspection remains

```
grep -rn "lsof" src-tauri/src/ src/          → 5 hits, ALL comments describing the removal
grep -rniE "libproc|proc_pid|proc_listpids|KERN_PROC|sysctl" → only the comment naming them as forbidden
grep -niE "sysinfo|libproc|procfs|netstat" src-tauri/Cargo.toml → NONE
```

Audited **every** `Command::new` in the backend — 5 remain, none inspect a process's file
descriptors: `git` (worktree), `/bin/sh` (check command), shell→`claude` (plan limits),
`kill`, and one `ps -Ao pid=,%cpu=,comm=` in `recover_hung_webview`. That last is a whole-table
`ps` on a recovery path, not a poller, and `ps` is the sanctioned TCC-free form.

**New driver `dev/drive-devport-sniff.mjs`** — proves the hop the unit tests structurally
cannot reach. It pushes a real banner through the pty stream and asserts it arrives at the
backend, is filed under the lane that printed it, doesn't leak onto another lane, and dedupes
on repeat.

**It is armed.** I severed the one forwarding line in `TerminalSurface` — i.e. reproduced the
exact dead state the code was in before this change — and confirmed `2 FAILED`, exit 1. Restored
and re-verified green.

This required two honest fixture fixes: the mock had no `noteSessionPort` (added, recording to
`window.__notedPorts`), and `onTerminalData` was the no-op `sub` stub, so **the harness could not
deliver pty output at all** — now a real subscription driven by `window.__mockTerminalData(id, text)`.

`dev/drive-roster.mjs` re-run as a regression check: all structural checks pass.

---

## Deviation from the brief — flagged for your call

> "`DashboardView.tsx:341` polls even when Preview isn't visible… don't poll a surface nobody is
> looking at."

**I left this poll running, deliberately.** It doesn't feed Preview — it feeds the
`localhost:NNNN` open-in-browser chip in `SessionToolbar`, which is visible in **all three** main
views (Console/Chat/Preview). Gating it on `mainView === 'preview'` would blank a chip that is
on screen, trading a modal-every-few-seconds bug for a visibly-broken affordance.

The cost premise is also gone: one poll is now 1–3 loopback connects that resolve in
microseconds, against a candidate set that is usually a single port. `AppPreviewPanel`'s poll was
already mounted-only and still is.

If you'd rather the chip go quiet off-Preview, that's a one-line change — say so and I'll make it.
