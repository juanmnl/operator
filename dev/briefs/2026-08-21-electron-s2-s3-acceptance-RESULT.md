# Result — S2/S3 acceptance

**Accepted, with three divergences found and fixed.** No GUI launches, no installs, no tags —
headless probes, scenario tests, and comparisons against files the Tauri build itself wrote.

`electron/`: **191 tests** (up from 119), `tsc` clean. Root: **786 tests**, `tsc` clean.
Two probe suites: `npm run probe:s1` and `npm run probe:s2s3` (44 checks).

## The table

| Module | What was compared | Cases | Diffs | Fixed |
|---|---|---:|---:|:--:|
| `core.rs` stores | the **real** `projects/sessions/role-defaults.json` re-serialized through the Node writer, byte-for-byte; plus a fresh save in frontend key order | 3 files (1.3 MB) + 10 tests | **1** | ✅ |
| `agents.rs` | the **real** `~/.claude/agents/*.md`: frontmatter vs a hand-parse, tools-as-list-or-string, save→read round-trip, rename, delete | 2 files + 16 checks | 0 | — |
| `folderprefs.rs` | scope order/precedence, missing-file handling, merge-not-replace, MCP discovery from `~/.claude.json` + `.mcp.json` | 14 tests | 0 | — |
| `worktree.rs` | create/status/diff/branchDiff/commit/**merge**/**discard**/remove + the removal guard, on throwaway `/tmp` repos | 29 tests | 0 | — |
| `usage.rs` | the Rust's own cost numbers, rates by family, de-dup, grouping, insights | 22 tests | 0 | — |
| `planlimits.rs` | `/usage` prose parsing: percent, resets, labels, the unlabelled-weekly rule, note-on-unexpected | 10 tests | 0 | — |
| `mcp.rs` + `artifacts.rs` | `--mcp-serve` against a **copy** of the real `artifacts.db`; rows, refusals, two-writer discipline | 17 checks | 0 | — |
| `quit.rs` | `is_busy` scenarios | 3 tests | **1** | ✅ |
| updater | feed parsing / inert-by-design behaviour | 3 tests | **1** | ✅ |
| drop + navigation guard | origin vs prefix, `file://` scoping, scheme refusals | 9 tests | 0 | — |
| gridterm (dropped) | the six mocked methods fail soft through the real preload | 5 checks | 0 | — |
| dispatch/reply tailing | — | — | — | covered by S1's sentinel probe |

## The three divergences

### 1. The quit guard was silent about the lane it exists for

`is_busy` in `quit.rs` is `running | compacting | waiting`, and `waiting` is in there
deliberately — *"an agent blocked on YOU is the precise lane you forgot about"*. The Electron
wiring asked for `running || compacting` and dropped `waiting`, so a lane sitting on a question
would not have appeared in the dialog **and would have been counted as idle in the same breath**.

The one case the guard is for. `isBusy` is now a pure function beside its Rust counterpart, with
the Rust test's scenarios.

### 2. A fresh save would have rewritten every JSON object

The stores re-serialize the real `~/.operator/*.json` byte-for-byte — but only because those
files were already written by serde, whose keys are sorted. `serde_json` without `preserve_order`
backs an object with a `BTreeMap`; `JSON.stringify` writes insertion order. So the first save
from the Electron build would have reordered every key in `projects.json`, and a user moving
between the two builds would see the whole file churn on each save with no readable diff ever
again.

Nothing breaks — key order carries no meaning in JSON — and it cost one comparator. The evidence
that `preserve_order` is off: every object in the real `projects.json` is in exact alphabetical
order (`createdAt, id, lastActiveAt, name, path, railOrder, tasks`), which a frontend type does
not produce by chance.

**This is the divergence a round-trip cannot see**, and the reason the probe tests a fresh object
in frontend order as well.

### 3. `checkUpdate` could reject

`configure()` sat outside the `try`, so anything it threw — a malformed feed URL,
electron-updater reaching for `app.getVersion()` before the app exists — rejected the promise
rather than resolving `null`. The renderer chains `.then()` off it, and the Tauri bridge wraps
its own check in a catch for exactly this reason: an update checker that surfaces its own
plumbing is worse than one that stays quiet.

## One thing the brief assumed that is not true

**There is no `operator__brief` tool.** `mcp.rs` declares exactly two — `operator__report` and
`operator__task_status`. The port matching at two is correct, and the probe asserts the list is
exactly those two so a third appearing on either side becomes a failure.

## Structural change worth noting

`isAllowedNavigation` moved out of `index.ts` into its own pure module. It was private to a file
that imports `electron`, which meant the **drop backstop** — the guard for the 2026-08-14
accident, where a stray Finder drop navigated the webview to `file:///…/image.png` and closing
that window killed every lane's pty — could only be exercised by booting a window. A guard that
only runs inside a window is a guard nobody checks. It now has 9 tests, including the
lookalike-origin case (`http://localhost:1450.evil.test/` shares the prefix but not the origin)
and a sibling directory that must not pass as the app directory.

## Not ported, and deliberately so

- **`worktree_reap_dry_run`** — a `#[tauri::command]` in `lib.rs` but **not on the seam**: it
  appears in neither `env.d.ts` nor `operator-bridge.ts`, so no frontend can call it. Porting it
  would add a command nothing invokes. (`project_worktree_reap_current_state` records that no
  frontend calls it.) If the Settings surface in the worktree-lifecycle design is built, it
  becomes an S-something item with a caller.
- **The tray and `tray_anim.rs`** (220 LOC) — the Electron shell has no tray at all. The
  brief's "rasterisation test of tray frames vs the Rust output" has no counterpart to compare
  against, so there is nothing to test rather than a test that was skipped. Building the tray is
  its own piece of work; the animation port only matters once it exists.
- **The image cache on the user path** — carried over from S1, still true: `cacheImage()` exists
  but `applyUser` records `images: []`, because no transcript in the corpus exercised it.

## What only the user can verify

Everything below needs a window, and this session had no GUI. Each is a minute.

1. **A real Finder drop.** Drag any image onto the app window. Expected: the window does **not**
   navigate — the path is written into the active terminal instead. The unit tests cover the
   decision (`navigation.test.ts`); what they cannot cover is that the preload's `dragover`/`drop`
   listeners are actually attached to the real page.
2. **The quit dialog.** With one lane mid-turn and one sitting on a question, press ⌘Q. Expected:
   both are listed (this is fix #1 — before it, the waiting lane was missing), the idle count is
   right, and "Stay open" leaves everything running.
3. **The preview inspector.** Open a project with a dev server, switch to Preview, press ⌘E.
   Expected: elements highlight on hover, clicking one opens the compose card, and "→ Console"
   posts back. Its transport is unit-covered (the preload channel replaces Tauri's
   `operatorpick://` beacon), but the injected script's own DOM behaviour is not.
4. **The title bar.** Still not draggable — Electron has no programmatic window drag, and the fix
   is `-webkit-app-region: drag` on `DragRegion` in `src/renderer`. Unchanged from the port
   result; listed so it is not rediscovered as a bug.

## Reproducing

```sh
cd electron
npm test                 # 191
npm run typecheck
npm run probe:s1         # tailer + chat parity + sentinel round-trip
npm run probe:s2s3       # stores, agents, mcp/artifacts, gridterm  (44 checks)
```

Probes read the real `~/.operator` and `~/.claude` **read-only**; `artifacts.db` and `chat.db`
are copied first, and every write goes to a temp directory.
