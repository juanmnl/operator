# Lane MCP server as plain node — result (2026-10-16)

Branch `operator/90c000`. Brief: `dev/results/_scratch/mcp-serve-as-node-brief-2026-10-16.md`.
Not merged.

## Result

Each lane's MCP server now runs as `process.execPath <app>/out/main/mcp-serve.cjs` with
`ELECTRON_RUN_AS_NODE=1`, instead of `process.execPath [appPath] --mcp-serve`.

Measured on this machine with `footprint`, the same dev Electron binary, server idle after start:

| Form | Processes | Footprint |
|---|---:|---|
| old: `Electron <app> --mcp-serve` | 3 (main + 2 Electron Helper) | 32 MB + 11 MB + 6.8 MB = ~50 MB |
| new: `ELECTRON_RUN_AS_NODE=1 Electron out/main/mcp-serve.cjs` | 1 | 15 MB |

This matches the research figures (46 MB / 3 processes vs 15 MB / 1).

## Files changed

- `electron/src/main/mcp-serve-main.ts` (new): the entry. Imports `./mcp-serve` and calls `serve()`.
  Nothing else.
- `electron/scripts/build-main.mjs`: fourth esbuild target, `out/main/mcp-serve.cjs`, beside
  `index.cjs`. It carries a `no-electron` plugin that fails the build if anything reachable from the
  entry imports `electron` (checked: an added `import { app } from 'electron'` stops the build with
  a message naming the importer). Today's bundle has 0 `require("electron")`; 64 KB.
- `src/renderer/lib/launch-args.ts`: `mcpConfigArg(execPath, script)` now returns
  `{command: execPath, args: [script], env: {ELECTRON_RUN_AS_NODE: "1"}}`. The `appPath` parameter
  and the dev/packaged branch are gone: one form serves both.
- `electron/src/main/terminals.ts`: passes `join(__dirname, 'mcp-serve.cjs')`. `__dirname` is
  `out/main` in dev and `…/Resources/app.asar/out/main` packaged (confirmed in the built
  `index.cjs`: `join(__dirname, "mcp-serve.cjs")`).
- `electron/src/main/index.ts`: the `--mcp-serve` branch is kept unchanged, with a comment that it
  is the old form for lanes whose config an older build wrote.
- `electron/src/main/mcp-serve.ts`: header rewritten for the new launch form. The quarantine note
  now says the probe measured the hang with the full-app form, that the node form execs the same
  signed binary so the same Gatekeeper check applies, and that this combination is unmeasured.
- `electron/src/main/port-alloc.ts` (`NOT_A_LANE_SERVER`, `OPERATOR_BINARY_RE`) and
  `electron/src/main/dev-servers.ts` (`NOT_A_SERVER_RE`): added `\/mcp-serve\.cjs\b` beside
  `--mcp-serve`.
- `electron/scripts/release.mjs`: the packaged-app assertion now drives both forms: as node on
  `Contents/Resources/app.asar/out/main/mcp-serve.cjs`, and `--mcp-serve`. Either failing stops the
  release.
- `electron/README.md`: file map line for the new entry.
- Tests: `src/renderer/lib/launch-args.test.ts`, `electron/src/main/dev-servers.test.ts`,
  `electron/src/main/port-alloc.test.ts`.

## Decisions

- **Script path from `__dirname`, not `app.getAppPath()`.** The server bundle sits beside
  `index.cjs`, so the path is computed from the running bundle's own location and cannot point at a
  different build. The 2026-08-20 probe advised against node mode because it couples the config to
  the asar layout; this keeps the coupling inside one build, and the release assertion now checks
  that exact path in the packaged app.
- **Old flag kept in `index.ts`.** A lane started before the update has `--mcp-serve` in its
  `--mcp-config` and respawns the server from the same `execPath` (now the new binary) if Claude
  Code reconnects. Remove the branch, and its matcher alternatives, once no released build writes
  the old form.
- **`VERSION` lookup unchanged.** It reads `join(__dirname, '..', '..', 'package.json')`; the new
  bundle is in the same directory as the old one, so it still resolves. The live server reported
  `serverInfo.version = "0.28.3"`.
- **Matchers extended, not replaced.** Older-build lanes still show `--mcp-serve` in `ps`.

## Claude Code merges `env`, verified against the installed 2.1.302 binary

Static: in the stdio branch of the MCP client, the spawn environment is
`env: {...base, CLAUDE_PROJECT_DIR, CLAUDE_CODE_SESSION_ID, CLAUDECODE: "1", ...r.env, ...}`,
where `base` is Claude Code's own environment (minus `CLAUDE_CODE_CHILD_SESSION` and
`CLAUDE_CODE_CHROME_MCP_ORG_DENIED`) and `r.env` is the config's `env`. The config's object is spread
on top; it does not replace the base.

Live: `claude -p --model haiku --strict-mcp-config --mcp-config <output of mcpConfigArg>` with an
isolated `OPERATOR_DIR` and test `OPERATOR_TERMINAL_ID` / `OPERATOR_PROJECT_ID` / `OPERATOR_ROLE_ID`:

- `report` → "Saved as report #1 in Operator's store…"; the row in the isolated `artifacts.db` is
  stamped `t-e2e | p-e2e | code`. The server refuses calls without `OPERATOR_TERMINAL_ID`, so the
  lane's variables did reach it.
- `task_status` → "Task nonexistent-e2e marked done."
- `ps` during that call: the server (pid 16015, parent = the `claude` process) had **no child
  processes**.

## Checks run

- Driver (`probes/mcp-probe/scripts/drive.mjs`, `RUN_AS_NODE=1`) against the built dev bundle,
  isolated `OPERATOR_DIR`: initialize, notification not answered, tools/list (report, dispatch,
  reply, worktree_done, task_status), tools/call `report` (row written, so `better-sqlite3` opened
  the store under node mode), -32601, -32700 + recovery, stdout only JSON-RPC. All ok. `probe/env`
  fails as expected (only the probe app implements it; `release.mjs` already ignores it).
- `cd electron && npm run typecheck`: clean. Root `tsc --noEmit -p .`: clean.
- Root `npm test`: **122 files, 1895 tests passed.**
- `cd electron && npm test`: **not green.** Three runs: 16 failed / 3 files; 1 failed / 1 file;
  4 failed + 8 skipped / 2 files, out of 985. Every failure is in `worktree.test.ts` or
  `worktree-cleanup-gaps.test.ts` and is a timeout (`Test timed out in 30000ms`,
  `Hook timed out in 10000ms`) or the 50 ms clone-cap test reporting the cap instead of a timeout.
  The machine's load average was 100–217 throughout (plain `node -e 0` took 0.4 s), and the failing
  set changed between runs. Neither file imports anything this branch changed (their graph is
  `worktree`, `worktree-reap`, `worktree-trash`, `store`, `reap`, `port-probe`, `login-shell`).
  The matcher and config tests touched here all pass. I did not rerun the suite on `main` for a
  baseline; that run should be repeated on an idle machine before merge.

## Not tested

- **The packaged, signed, notarized build.** Nothing here ran a packaged `.app`. Specifically
  unverified: that node mode can run a script from inside `app.asar` in our build (the 2026-08-20
  probe showed it in a probe app, 66 ms; `release.mjs`'s pty smoke test already relies on node mode
  reading the asar), that the `RunAsNode` fuse is on (no fuse flipping exists in the build scripts,
  and that smoke test would fail otherwise), and that `better-sqlite3`'s unpacked `.node` loads
  under node mode from the asar path. The new release assertion checks all three on the next
  release build.
- **A quarantined, unnotarized bundle in node mode.** Expected to hang like the full-app form;
  not measured.
- **The dev app with a real lane.** Not run. The `claude -p` check above uses the same config
  `mcpConfigArg` produces and the same server process a lane would start, but it does not exercise
  `terminals.ts` building the flag inside a running app; that part is covered by reading the built
  `index.cjs` only.
- **Startup time.** The first driver run timed out at 15 s with no output, then later runs took
  0.8–5.6 s for node and 0.4–1.3 s for the full-app form. Under this load the numbers do not
  compare the two forms; the probe's idle figures were 66 ms vs 85 ms. Worth one remeasure on an
  idle machine.
- `NOT_A_LANE_SERVER` is not exported; its new alternative is only reachable through
  `provesOwnServer`, and the new-form helper command does not match `DEV_SERVER_RE` in the first
  place, so the added `port-alloc.test.ts` case pins behaviour but would pass without the regex
  change. The `dev-servers.test.ts` case does fail without it (checked by reverting the regex).
