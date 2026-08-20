# Brief — the riskiest item first: `--mcp-serve` from a packaged, signed Electron `.app`

**Probe, half a day.** Lives next to the spike (`spike/electron/`, your worktree). No edits under
`src/` or `src-tauri/`. Output: **`dev/briefs/2026-08-20-electron-mcp-serve-probe-RESULT.md`**.
Runs alongside M1 — do not stop M1's 2 h window for this.

## Why (from `dev/briefs/2026-08-20-electron-migration-plan-RESULT.md`, "Order of risk")

The operator MCP control plane (`src-tauri/src/mcp.rs` 337 LOC; `operator__report`,
`operator__task_status`, `operator__brief`) works because `main.rs` checks `--mcp-serve` before
the app starts and the **same signed binary doubles as the MCP server**, spawned per lane. If
`process.execPath` inside a packaged/signed/notarized Electron `.app` (asar + helpers) doesn't
give a stable, re-executable entry that takes that flag and speaks stdio JSON-RPC cleanly, the
whole control plane breaks silently — and only at release time. Prove it now on the thinnest
possible app.

## Do

1. Thinnest packaged app from the spike's toolchain: on `--mcp-serve` (checked at the very top of
   main, before `app.whenReady()`), do NOT create a window; run a `readline` JSON-RPC 2.0 loop on
   stdin/stdout answering `initialize` → `tools/list` (one tool) → `tools/call`. Mirror
   `mcp.rs`'s exact three methods and framing (newline-delimited). Make sure nothing else writes
   to stdout (Electron/Chromium log lines are the classic poisoner — route them to stderr or
   silence; check `ELECTRON_RUN_AS_NODE` as an alternative and report which you chose and why).
2. Package it (`electron-builder`/`@electron/packager`), **sign** with the Developer ID already in
   the keychain (`Developer ID Application: Juan Cornejo (UJS4C5GUCW)`), hardened runtime on;
   notarize only if the App Store Connect key is available locally (look before you assume;
   if not, say so and stop at signing).
3. Run `…/Operator.app/Contents/MacOS/<exe> --mcp-serve` from OUTSIDE dev (a plain shell, and
   once from a `claude` lane's `.mcp.json`-style stdio config if cheap) and drive the three
   methods. Compare byte-for-byte with the same under `electron-vite dev`.
4. Also answer: does `process.execPath` resolve to the bundle's main executable under asar; any
   Gatekeeper/TCC prompt on first spawn; startup latency of the headless path (Electron boots
   Chromium even headless — how many ms, is that acceptable per lane spawn or do we want
   `ELECTRON_RUN_AS_NODE=1` to skip it).

## Report shape

Verdict first: works / works-with-conditions / fails — with the conditions. Then timings, the
stdout-hygiene finding, and the recipe you'd carry into the real shell.
