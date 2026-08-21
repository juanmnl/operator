# Port ledger — DONE, except what was deliberately dropped

**Status 2026-08-20: 85 of the 91 seam methods are native in the Electron shell.** The six that
are not are `gridterm*` + `onGridUpdate`, dropped by decision. Everything below is kept as the
record of what each module cost and what it turned out to be; the "Effort" column is now
history rather than estimate.

| | |
|---|---|
| Native | **85** |
| Mock | 6 (all gridterm — dropped) |
| Modules ported | 12 |
| Tests in the shell | 84 |

Three of those tests found real bugs rather than confirming the port — see the notes on
`worktree.rs` and `transcript.rs` below.

---

# The original estimate — the 68 `invoke` commands, and what each costs in Node

Companion to `src/shared/operator-api.ts`, whose `SPEC` table is the machine-readable half:
every method is marked `native` (this shell answers it) or `mock` (falls through to
`dev/mock-bridge.ts`), and the file does not compile if a method in `src/renderer/env.d.ts` is
missing from it. This document is the estimate that goes with that ledger.

Counted from `src/operator-bridge.ts`: **68** distinct `invoke` command names. (The brief says
66; the two extra are `path_exists` and `project_replies`, both added since it was written.)
The renderer-facing contract is **90 methods** — the difference is events, the methods answered
without a backend hop, and the several that compose two commands.

Effort is **S** = under a day, **M** = a few days, **L** = a week or more, for someone who
already knows this codebase.

| Rust module | LOC | Commands | Node equivalent | Effort | Notes |
|---|---:|---:|---|:--:|---|
| `lib.rs` | 2780 | 20 | `node-pty`, `fs/promises`, `shell`, `dialog`, `nativeImage` | **M** ✅ | **DONE.** The pty half — spawn/start/write/resize/kill/list/history, deferred launch, base64 transport, retained history. What is left in this module is the dev-port registry, `preview_inspect_*` (a second `BrowserWindow`), moodboard/asset files, and the dock icon. |
| `worktree.rs` | 2665 | 12 | `child_process` around the `git` CLI | **L** | **DONE — and its test caught a real deletion-safety bug: `realOf()` compared a resolved path against a lexical one, so on macOS (`/tmp` → `/private/tmp`) `dangerousRemovalReason('/tmp', '/tmp/repo')` answered "safe". **Biggest by volume, smallest by risk: it already shells out to `git` — the port is argument-marshalling and output parsing, not logic. `worktree_reap_dry_run` (not exposed to the frontend) carries the provenance rules that must not be reimplemented loosely. |
| `transcript.rs` | 1638 | 2 | `fs.watch`/`chokidar` + a JSONL line reader | **M** | **DONE — and fixed a latent bug carried from the Rust: on rotation it resets the offset but keeps the parsed narration, so a truncated file appends onto stale state. **The tailer for `~/.claude/projects/<slug>/<uuid>.jsonl`, plus the `OPERATOR-DISPATCH` / `OPERATOR-REPLY` sentinel parsing. Mostly pure string work that ports line-for-line; the risk is the watch semantics (rename-on-write, truncation), not the parsing. |
| `planlimits.rs` | 625 | 1 | `execFile('claude', ['-p', '/usage'])` + parse + TTL cache | **S** | **DONE. **Self-contained: run a CLI, parse, cache 5 min. |
| `chatstore.rs` | 545 | 3 | `better-sqlite3` | **S** | **DONE. **A RETURN TRIP: `docs/tauri-migration.md` records this leaving `better-sqlite3` for `rusqlite`. The schema and queries come back nearly unchanged. |
| `core.rs` | 458 | 7 | `fs/promises` + atomic rename | **S** | **DONE. **`sessions.json` / `projects.json` / `role-defaults.json`. Crash-safe write = temp file + `rename`, same as the Rust. |
| `usage.rs` | 452 | 2 | JSONL reads + aggregation | **M** | **DONE. **Pure aggregation over transcript files; the cost is matching the numbers exactly, not writing it. |
| `gridterm.rs` | 418 | 5 | **none** | **DROPPED** | The one module with no Node equivalent: it embeds `alacritty_terminal` as a real VT parser and ships cell snapshots. Nothing on npm is that parser. The honest options are (a) drop it — it has been unreachable since 2026-06-30 and its own commit shelved it, or (b) keep a Rust sidecar binary just for it. This shell reports `grid: false` at spawn and mocks the five commands. |
| `mcp.rs` | 337 | 1 | `fs` read of `~/.claude.json` + project config | **S** | **DONE. **Read-only viewer. |
| `quit.rs` | 324 | 3 | `before-quit` + `dialog` | **S** | **DONE. ****Cheaper in Electron than in Rust.** `event.preventDefault()` on `before-quit` is the veto the Tauri version had to build around `RunEvent::ExitRequested`, and the 400 ms native-dialog fallback exists because Tauri could not be sure the webview would answer. |
| `artifacts.rs` | 271 | 3 | SQLite + an MCP stdio server | **M** | **DONE — the MCP server too, verified against the packaged+signed binary. **The read side is three queries. The write side is the part that matters: lanes reach it by launching `<current_exe> --mcp-serve`, so the Electron binary must serve MCP when invoked with that flag — an `app.commandLine`/`process.argv` branch that runs headless before `whenReady`. Not wired in this spike, deliberately: a lane pointed at an MCP server that does not exist is worse than a lane with none. |
| `agents.rs` | 235 | 3 | `fs` over `.claude/agents/*.md` | **S** | **DONE. **Front-matter read/write. |
| `folderprefs.rs` | 175 | 5 | `fs` over `settings.json` / `CLAUDE.md` | **S** | **DONE. **|

**Totals:** ~11.2k LOC of Rust, of which one module (`gridterm.rs`, 418 LOC) has no equivalent
and one (`worktree.rs`, 2665 LOC) is bulk rather than difficulty. Roughly **3–5 weeks** of
focused work to reach parity, with `transcript.rs` and `artifacts.rs` the two that decide
whether the port is trustworthy — they are the ones the orchestration product is made of.

## The one thing that does not map

**`startWindowDrag` has no Electron counterpart.** Tauri exposes `startDragging()`, which the
custom title bar calls on `mousedown`; Electron drags a frameless window only through the CSS
`-webkit-app-region: drag`, which must be set on the element. That element is `DragRegion` in
`src/renderer`, so making the title bar draggable under Electron requires a renderer change —
the single place where "the renderer ports unchanged" is false. It is a one-line CSS change,
but it is a change, and `data-tauri-drag-region`'s known macOS failure (the handler goes dead
after the first drag) is *why* the app moved to the imperative call in the first place. Under
Electron the CSS approach is the supported one, so this is a revert, not a regression — but it
needs re-testing on the same gestures.

## Signing, notarization, and the update path

**Today:** Tauri's bundler signs with `Developer ID Application: Juan Cornejo (UJS4C5GUCW)`,
`createUpdaterArtifacts: true`, and the app checks
`https://github.com/juanmnl/operator-releases/releases/latest/download/latest.json` against a
minisign public key baked into `tauri.conf.json`. Bundle id `com.operator.app.tauri`.

**Under Electron:** `@electron/osx-sign` + `@electron/notarize` do the signing (the same
Developer ID certificate works); `electron-updater` (Squirrel.Mac) or `update.electronjs.org`
replaces the updater. Roughly equivalent work, already-solved ground.

**Can existing installs be migrated across shells?** *Probably yes, once, and it is a one-way
door.* The Tauri updater verifies the payload against the baked-in minisign key and then
replaces the `.app` bundle in place — it does not check what is inside the bundle. So a release
whose payload is the Electron `.app`, signed with the same Developer ID and carrying the same
bundle identifier, should install over the existing app like any other update. Two caveats,
both real:

1. **Verify before believing this.** It is an inference from how the updater works, not
   something this spike tested. Getting it wrong strands every installed copy.
2. **After the swap, the Tauri updater is gone**, and the Electron one takes over — so the
   changeover release must ship a working `electron-updater` feed or the next update has no
   path at all. There is no going back through the same door.

The standing rule still holds and gets sharper here: **never regenerate the updater key.** It
is the only thing that makes the one migration release installable.
