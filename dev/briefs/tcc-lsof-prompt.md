# Brief — kill the recurring macOS "Operator would like to access data from other apps" prompt

## Symptom
The user gets the macOS TCC modal **"'Operator' would like to access data from other apps."** over and over,
during normal use — not tied to any particular action. It steals focus and blocks the UI.

## Root cause (verified by reading the code, high confidence)

`session_ports` shells out to **`lsof -p <pid,pid,…>`** over the session's whole pty process tree.
Per-pid `lsof` is exactly what fires this TCC prompt on modern macOS — once **per target process**, which is
why it never stops: every new lane / dev server / child process is a fresh prompt.

Call chain:
- `src-tauri/src/lib.rs:1058` `session_ports(id)` → `descendants(pid)` (a `ps -Ao pid=,ppid=` — harmless)
  → `listening_ports(&pids)` at `src-tauri/src/lib.rs:418`
- `src-tauri/src/lib.rs:423` spawns `lsof -nP -a -p <list> -iTCP -sTCP:LISTEN -F n`

Two pollers keep it running forever:
- `src/renderer/views/DashboardView.tsx:341-353` — polls `sessionPorts(activeTerminalId)` every **5s**,
  for the active session, **always**, regardless of which surface (Console/Chat/Preview) is showing.
  This is the one that makes it constant.
- `src/renderer/components/session/AppPreviewPanel.tsx:114-132` — polls every **4s** while Preview is mounted.

`ps` is fine and stays. **`lsof` is the only offender in the repo** (grep confirms: `lib.rs:423` is the sole
spawn site; the other hits are tests/comments).

## Required outcome
Zero `lsof` invocations from the app at runtime. No polling loop may inspect another process's file
descriptors, ever — not with `lsof`, not with `libproc`/`proc_pidfdinfo` (same TCC gate), not with a
"cheaper" variant. This is a hard constraint, not a preference.

## Why we can afford to lose lsof's pid→port attribution

Attribution already has two better sources that don't touch other processes:

1. **Banner sniffing from our own pty output** — already built and already *wins* over the lsof path:
   `src/renderer/components/terminal/TerminalPane.tsx:286` (`detectDevServer`), consumed at `:431`,
   with `src/renderer/lib/terminal.ts` doing the escape-stripping and `terminal.test.ts:34` covering it.
   `SessionToolbar.tsx:56` documents that the sniffed port already outranks everything else.
2. **The reserved `OPERATOR_DEV_PORT`** — we allocate it ourselves per cwd (`PtyManager::alloc_port`,
   `lib.rs:469`) and expose it via `dev_ports()` (`lib.rs:498`) / `getDevPorts` — polled in
   `DashboardView.tsx:331-337`.

And liveness of a *candidate* port needs no privileges at all: a plain TCP connect to `127.0.0.1:<p>` and
`[::1]:<p>`. Note both families matter — a Vite server here bound IPv6-only, so `127.0.0.1` alone returns
connection-refused for a port that is genuinely live.

## Suggested shape (yours to refine — read the code first)

Keep the `session_ports` command and its signature so callers don't churn; **replace its body**:
build the session's candidate set (reserved port for that terminal + any port sniffed from its banner),
TCP-connect each on both loopback families, return the ones that answer. No process inspection.

What this gives up: auto-discovering a port the project chose that we never reserved *and* never printed a
URL for. That residue is already covered by `AppPreviewPanel`'s explicit **Scan** (`AppPreviewPanel.tsx:103`,
HTTP-pings `COMMON_PORTS`), which is user-initiated and also TCC-free. Losing a silent fallback is a fair
trade for killing a modal that fires every few seconds.

Also worth doing while you're in there: `DashboardView.tsx:341` polls even when Preview isn't visible, purely
to feed a toolbar chip. Even with the cheap implementation, don't poll a surface nobody is looking at.

## Guardrails
- Keep `listening_ports_from`'s unit tests meaningful or delete them honestly with the parser — don't leave
  tests asserting on a code path that no longer exists.
- Update the now-wrong comments that describe lsof as the mechanism: `lib.rs:47`, `DashboardView.tsx:131-135`,
  `AppPreviewPanel.tsx:111-113`.
- `npm run build` (tsc) and `cargo test` must both pass.

## Output
Write findings to `dev/briefs/tcc-lsof-RESULT.md`: what changed, what the new attribution path is, what
coverage was deliberately dropped, and how you verified no `lsof`/proc-inspection remains.
