# Result — `--mcp-serve` from a packaged, signed Electron `.app`

# Verdict: **works — with one condition, and the condition is currently unmet by the shipped app.**

The transport survives the shell change completely. Every question the brief asked came back
positive: `process.execPath` resolves to the bundle's main executable, stdio is clean, the three
methods answer byte-identically to `mcp.rs`, and headless startup is **85 ms** — the same as
unpackaged. A real `claude` lane, configured exactly the way `terminal_spawn` configures one,
called `operator__report` on the signed `.app` and got the right answer with the right caller
attribution.

**The condition: notarization is load-bearing, not cosmetic.** A quarantined, *unnotarized*,
correctly-Developer-ID-signed bundle spawned as a subprocess produces **no output, no error, and
no process** — it hangs until the client gives up. That is precisely how every lane's MCP server
would fail, and it would fail silently.

**And the shipped `Operator.app` has no stapled notarization ticket today.** Apple's own
`syspolicy_check` calls it `Notary Ticket Missing … Severity: Fatal`. That is a live finding about
the *current* Tauri release, not a hypothetical about Electron — see the last section.

Probe lives at `spike/electron/mcp-probe/`. Nothing under `src/` or `src-tauri/` was touched, and
nothing was written to `~/.operator`.

---

## What was built

`mcp-probe/main.cjs` — a single file, no dependencies, that mirrors `src-tauri/src/mcp.rs` where
it matters: JSON-RPC 2.0, **one object per line**, the same three methods (`initialize`,
`tools/list`, `tools/call`) plus `ping`, the same notification rule (no `id` → no answer), the
same `-32601` / `-32700` codes, and the same caller-attribution refusal keyed on
`OPERATOR_TERMINAL_ID`. `--mcp-serve` is checked at the top of the file, before anything requires
`electron`, so the MCP path never opens a window, takes a lock, or touches the dock.

It deliberately **does not persist**. The question is whether the binary can *be* the server;
writing rows into the user's real artifact store to answer that would be a side effect nobody
asked for. The tool returns what it *would* have recorded.

`mcp-probe/scripts/drive.mjs` — a dependency-free external driver. It writes newline-delimited
JSON to stdin and reads it back from stdout, because that framing *is* what is under test; an MCP
client library would paper over exactly the failure this probe exists to find. It captures every
stdout line **including non-JSON**, which is the stdout-hygiene check.

---

## Results

All seven checks pass in every mode: `initialize`; a notification is *not* answered (verified by
sending `notifications/initialized` then a `ping` and confirming the next line carries the ping's
id — if the notification were answered, every later response would be off by one); `tools/list`;
`tools/call`; unknown method → `-32601`; a malformed line → `-32700` **and the server survives
it**; and stdout carrying only JSON-RPC frames.

The refusal path works too: with `OPERATOR_TERMINAL_ID` unset, `tools/call` returns
*"unattributable call: OPERATOR_TERMINAL_ID is not set in this environment…"* — the same contract
`resolve_caller` enforces.

### Startup latency (spawn → first protocol byte, 5 runs each)

| Mode | min | **median** | max |
|---|---:|---:|---:|
| A — unpackaged, via the spike's Electron ("under dev") | 82 ms | **85 ms** | 105 ms |
| B — packaged + signed `.app`, full Electron | 82 ms | **85 ms** | 91 ms |
| C — packaged + signed `.app`, `ELECTRON_RUN_AS_NODE=1` | 65 ms | **66 ms** | 85 ms |

**Packaging costs nothing.** B is identical to A. The Chromium boot everyone worries about does
not show up here, because nothing on the `--mcp-serve` path creates a window.

**One-time cost worth knowing about:** the *very first* run of a freshly signed bundle took
**1739 ms**, then dropped to ~90 ms and stayed there. That is macOS validating the new signature
once and caching it — it is not a per-spawn cost, but it *is* a real 1.7 s on the first lane after
an update installs.

### `process.execPath` under asar — the fact the artifact plane rests on

```
execPath      …/OperatorMcpProbe.app/Contents/MacOS/OperatorMcpProbe
argv[0]       …/OperatorMcpProbe.app/Contents/MacOS/OperatorMcpProbe
resourcesPath …/OperatorMcpProbe.app/Contents/Resources
__dirname     …/OperatorMcpProbe.app/Contents/Resources/app.asar
insideAsar    true
```

`process.execPath` is the bundle's main executable — stable, re-executable, and exactly what
`terminal_spawn` needs to write into each lane's `--mcp-config`. `require()` **works from inside
`app.asar`** (the server reported its version out of the packed `package.json`). This is a direct
one-for-one replacement for Rust's `std::env::current_exe()`.

### Stdout hygiene

Clean in every mode: 8 lines, all JSON, **stderr empty**. But it is clean *because it was made*
clean, not by luck. The first thing `main.cjs` does is rebind `console.log`/`info`/`debug` to
stderr and keep a private handle to the real `process.stdout.write` for the protocol writer.
Chromium's own logging already goes to stderr, but that is an assumption about someone else's
code, and stdout corruption here is a silently-mangled frame rather than a crash.

**Recommendation: use B (full Electron), not `ELECTRON_RUN_AS_NODE`.** The 19 ms C saves is not
worth what it costs: C must be handed the script path *inside the asar*
(`…/Contents/Resources/app.asar/main.cjs`) as `argv[1]`, which couples every lane's MCP config to
the app's internal layout — a second path to get right, and one that breaks silently if the bundle
is ever restructured. B needs only `<exe> --mcp-serve`, which is exactly the shape `mcp.rs` and
`terminal_spawn` already use. Keep the option documented as a fallback if startup ever matters.

### End-to-end from a real lane

Config, shaped as `terminal_spawn` writes it:

```json
{"mcpServers":{"operatorprobe":{"type":"stdio",
  "command":"…/OperatorMcpProbe.app/Contents/MacOS/OperatorMcpProbe",
  "args":["--mcp-serve"],
  "env":{"OPERATOR_TERMINAL_ID":"t-probe-lane"}}}}
```

`claude -p --mcp-config … --strict-mcp-config` returned:

```
probe ok — would record for terminal t-probe-lane (29 chars, 0 artifacts). Nothing persisted.
```

The tool was discovered, called, and attributed. No Gatekeeper prompt, no TCC prompt.

---

## The condition: Gatekeeper

Signing was done with the Developer ID already in the keychain
(`Developer ID Application: Juan Cornejo (UJS4C5GUCW)`), hardened runtime on, with the standard
Electron entitlements. `codesign --verify --deep --strict` → *valid on disk*, *satisfies its
Designated Requirement*.

**Notarization could not be run locally.** The App Store Connect key *is* present
(`~/.appstoreconnect/private_keys/AuthKey_W67T48CC5G.p8`), but `notarytool` also needs the issuer
ID, which lives only as the CI secret `APPLE_API_ISSUER` (`.github/workflows/build.yml`). There is
no `notarytool` keychain profile. So, per the brief, I stopped at signing — and then tested what
that costs:

| Bundle | Quarantined? | Spawn as MCP server |
|---|---|---|
| Signed, **unnotarized** | yes | **hangs — no output, no error, no process** |
| Signed, unnotarized (same bundle, `xattr -d` quarantine) | no | works, 139 ms |
| **Notarized** (control: `Claude.app`, Anthropic PBC) | yes | runs |

The middle row is the proof it is quarantine and nothing else: the *same bundle*, one extended
attribute removed, works. The third row is the reason this is a condition rather than a blocker —
a properly notarized bundle spawns fine even quarantined.

**Why this is dangerous rather than merely annoying:** the failure is *silent*. No dialog reached
the terminal, no error on stderr, no exit code — the driver simply waited. A lane would sit with a
dead MCP server and no indication why.

---

## The incidental finding, which is about today's app

While looking for a notarized control I checked the shipped app:

```
$ xcrun stapler validate /Applications/Operator.app
Operator.app does not have a ticket stapled to it.

$ syspolicy_check distribution /Applications/Operator.app
Notary Ticket Missing — Severity: Fatal
    A Notarization ticket is not stapled to this application.

$ spctl -a -vvv -t exec /Applications/Operator.app
rejected   source=Unnotarized Developer ID
```

The method is sound: `Claude.app`, `Google Chrome.app` and `Visual Studio Code.app` on the same
machine all return *"The validate action worked!"*.

So **`/Applications/Operator.app` is signed but carries no stapled notarization ticket.** It runs
today because it was never quarantined — the Tauri updater replaces the bundle in place, and
in-place replacement does not set `com.apple.quarantine`. A user who downloads the `.dmg` in a
browser gets a different experience.

This is worth chasing on its own merits, and it is a **precondition for the Electron plan**: if
the changeover release ships the way releases ship today, the artifact plane hangs for anyone
whose copy carries quarantine. Two things to check in CI: whether `notarytool` is actually
succeeding, and whether `stapler staple` runs against the `.app` *inside the updater artifact* and
not only against the `.dmg`.

---

## The recipe to carry into the real shell

1. Check `--mcp-serve` at the **top of the main entry**, before anything requires `electron` —
   so the path also works under `ELECTRON_RUN_AS_NODE` and never touches window/dock/lock.
2. **Take stdout away from everything but the protocol writer** on the first line: rebind
   `console.log`/`info`/`debug` to stderr, keep a private `process.stdout.write`.
3. Use `process.execPath` for the `--mcp-config` command. It is correct under asar and is the
   direct analogue of `std::env::current_exe()`.
4. Spawn as `<execPath> --mcp-serve`. Do not adopt `ELECTRON_RUN_AS_NODE` for 19 ms.
5. Exit when stdin closes (`readline` `close` → `process.exit(0)`), matching the Rust loop.
6. **Notarize and staple, and verify with `stapler validate` in CI.** This is not a release-
   polish item; the control plane depends on it.
7. Budget ~1.7 s for the first lane spawned after an update installs, ~85 ms thereafter.
