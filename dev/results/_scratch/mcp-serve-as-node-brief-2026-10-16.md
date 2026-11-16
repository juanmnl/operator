# Brief: run each lane's MCP server as plain node, not full Electron

## Why
Every lane starts `Operator --mcp-serve` (src/renderer/lib/launch-args.ts:22 `mcpConfigArg`, used by
electron/src/main/terminals.ts:303). It is the full Electron binary without `ELECTRON_RUN_AS_NODE`, so
Chromium also starts a GPU helper and a network helper for every lane. Measured footprint: about 46 MB
per lane (28 + 11 + 6.5 MB) and 3 processes. With `ELECTRON_RUN_AS_NODE=1` the same binary footprints
about 15 MB with no helpers. With 18 lanes that is about 560 MB and 36 processes saved.
Research: /Users/juanmnl/Developer/operator/dev/results/memory-footprint-research-2026-10-16.md
(Q1 and option 3 in the options table).

## What to build
1. A dedicated MCP-server entry that does not import `electron`. Today electron/src/main/index.ts:487
   checks `--mcp-serve` and calls `serveMcp()` after the Electron app module has loaded. The server
   needs only stdin/stdout JSON-RPC, `better-sqlite3` through `ArtifactStore`, and
   `evaluateWorktreeDone`. Build it as its own bundle in the electron build (vite config / electron
   build config), and make sure it is included in the packaged app (inside or beside the asar, wherever
   node can load it with `ELECTRON_RUN_AS_NODE`).
2. Change `mcpConfigArg` to launch `process.execPath` with that entry as its script and
   `"env": {"ELECTRON_RUN_AS_NODE": "1"}` in the MCP server config. Check that Claude Code's MCP config
   merges `env` with the parent environment and does not replace it (verify against the installed CLI
   binary, not from memory). Keep the server's `VERSION` lookup working from the new location.
3. Keep the old `--mcp-serve` flag working in index.ts for lanes that are already running with an old
   config when the app updates, and for one release of compatibility.
4. `better-sqlite3` is built for Electron's ABI. Confirm it loads under `ELECTRON_RUN_AS_NODE` (it
   should, since it is the same binary and ABI). If it does not, stop and report.
5. Update the command-line matchers that recognise this process: `NOT_A_LANE_SERVER` /
   `NOT_A_SERVER_RE` in electron/src/main/port-alloc.ts:211 and electron/src/main/dev-servers.ts:62,
   and anything else that matches `--mcp-serve` or "Operator Helper" (grep the repo).
6. The note in electron/src/main/mcp-serve.ts:8-10 says an unnotarized, quarantined bundle spawned this
   way hangs. Keep that comment accurate for the new launch form.

## Done means
- Unit tests for the new `mcpConfigArg` output and the updated matchers.
- A real check that the new entry runs: start it the way Claude Code would (the built dev bundle with
  `ELECTRON_RUN_AS_NODE=1`), send `initialize` and `tools/list` over stdin, and confirm the replies and
  that `better-sqlite3` opened the store. Use an isolated OPERATOR_DIR, never ~/.operator.
- If you can, run the dev app (isolated OPERATOR_DIR, port 1431) with one lane and confirm with `ps`
  that the lane's MCP server is one process with no Operator Helper children, and that a `report` or
  `task_status` call from the lane works.
- `npm test` green in both suites. Report the counts.
- Write `/Users/juanmnl/Developer/operator/dev/results/mcp-serve-as-node-2026-10-16.md`: files changed,
  decisions, what is untested (in particular the packaged, signed build), anything you could not do.
- Commit on your lane branch. Don't merge.
