# Build the artifact plane: `operator__report` + `operator__task_status`

**Phase 1 of `dev/mcp-control-plane-spike.md`.** That spike already did the analysis — read it
first, especially the per-fix table and "Incremental migration path". This brief is the
implementation of its step 1 only. **Do not build `operator__dispatch`** — the spike is explicit
that it waits until the push/pull question is answered honestly.

## Why now — the receipt arrived

Tonight's worktree audit found **20 files that existed only inside a worktree**, invisible to the
coordinator and to every other lane. Three were RESULT documents believed never written, including
`stream-json-alongside-pty-RESULT.md` — whose conclusion I reported as "the question was never
answered" hours before finding the answer sitting in `operator-4c2728`. Earlier, on 2026-07-30,
**nine dispatches pointed at brief paths no lane could read**.

Every one of those is the same defect: **artifacts are addressed by filesystem path, and each lane
has a different filesystem.** The worktree lifecycle work (33 worktrees → 4, lanes now forking from
the default branch) reduced how often it bites. It cannot fix it — a path-addressed artifact in an
isolated checkout is broken by construction.

## What to build

Two tools, both **lane → Operator only**. No push, no delivery, no timing race — the spike rates
both "Confirmed" and this direction is the one MCP handles cleanly.

### `operator__report(taskId?, summary, artifacts?)`
The return path. Today a lane's answer reaches Operator only if a human relays it or Operator goes
looking in the right worktree. After this, a lane hands its result to Operator directly. `artifacts`
carries content or named blobs — **not paths into the caller's worktree**, which is the whole point.

### `operator__task_status(id, status)`
The completion signal. This one is worth more than it looks: `fix-session-task-lifecycle-RESULT.md`
already concluded, about the ~200 tasks stuck in `running`, that *"Completion only fires when a lane
DIES… there is no per-turn completion signal… **Not fixed here and not fixable by reconciliation**…
Closing them needs a real completion signal."* This call **is** that signal — a prior independent
investigation declared the leak structurally unreachable without exactly this.

## The four decisions to settle (the spike leaves these open)

1. **Where the store lives.** Not in any worktree, and not in a git-tracked path — the artifact
   plane must be immune to checkout isolation. `~/.operator/` is where the durable state already
   lives (`sessions.json`, `projects.json`, `chat.db`). Prefer the existing SQLite (`chat.db` or a
   sibling) over loose files, so reports are queryable and can't be half-written.
2. **How a lane reaches the server.** Nothing today passes MCP config to a lane —
   `folderprefs::get_mcp_servers` reads the *user's* servers for display, and the spawn (`lib.rs`
   ~700-760) passes no `--mcp-config`. Decide and document: an stdio server Operator spawns per
   lane, or one shared endpoint. **Do not silently overwrite the user's own MCP configuration** —
   `~/.claude.json` already carries `paper` and `obsidian` servers.
3. **How a call identifies its caller.** `OPERATOR_TERMINAL_ID` is already exported into every
   lane's environment at `lib.rs:740` (memory calls it "vestigial" — it stops being vestigial here).
   Project and role are resolvable from it via `sessions.json`. A report that can't be attributed to
   a lane is worthless, so the server must reject an unattributable call rather than accept it.
4. **What happens when a lane doesn't call.** The spike names this honestly: *"same
   charter-dependency risk as sentinels, moved, not removed."* A tool a lane never invokes fixes
   nothing. So: the charters must ask for it, **and** Operator must be able to tell the difference
   between "no report" and "reported nothing" — silence has to be visible, not indistinguishable
   from success.

## Explicitly out of scope

- `operator__dispatch` — later, and only per the spike's condition.
- Removing the `OPERATOR-DISPATCH` / `OPERATOR-REPLY` sentinels. This runs **beside** them; the
  sentinel path keeps working untouched. Nothing gets cut in this pass.
- Migrating existing `dev/briefs/*.md`. They stay files; new reports go to the store.

## Verify

- A lane calls `operator__report` from a worktree and Operator reads it **without touching that
  worktree's filesystem** — that is the entire thesis, so test it by pointing the lane at a
  worktree Operator has no path to.
- `operator__task_status(id,'done')` closes a task **mid-turn**, while the lane is still alive —
  not on pty death. Verify against the durable state, not the UI (the UI has lied about this before).
- An unattributable call is rejected.
- The user's own MCP servers (`paper`, `obsidian`) still work in every lane afterwards.
- `npm test` green (637 on `main` = `c06fa61`), `cargo test` green (130), build clean.

## Output

Write `/Users/juanmnl/Developer/operator/dev/briefs/2026-08-05-artifact-plane-RESULT.md`
(absolute path, main repo). State which of the four decisions you settled and how, and — since this
is the fix for artifacts getting lost — confirm the RESULT itself is reachable by Operator.
