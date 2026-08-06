# RESULT — the artifact plane, phase 1

`operator__report` + `operator__task_status`, lane → Operator only. **`operator__dispatch` is not
built and the sentinels are untouched.**

Build clean · `npm test` **637** · `cargo test` **140** (130 + 10 new).

---

## The thesis, tested the way the brief asked

> *A lane calls `operator__report` from a worktree and Operator reads it **without touching that
> worktree's filesystem**.*

Driven against the real server, from a cwd Operator has no path to:

```
$ cd /tmp/…/isolated-worktree && OPERATOR_TERMINAL_ID=probe-t1 operator --mcp-serve
→ {"result":{"content":[{"text":"Reported to Operator (#1). It is readable outside your
   worktree; you do not need to relay it."}]}}

$ # …then, from /Users/juanmnl/Developer/operator, no worktree path involved:
1|probe-t1|probe-task-1|phase-1 smoke test from an isolated worktree|
  [{"content":"content travelled, not a path","name":"proof.md"}]
```

The artifact crossed a filesystem boundary as **content**. `git check-ignore` on the store answers
*"outside repository"* — it is not in any checkout, ignored or otherwise.

---

## The four decisions, settled

**1. Where the store lives — `~/.operator/artifacts.db`, a SIBLING of `chat.db`.**
Outside every worktree and outside git, beside the durable state that already works this way. A
separate file rather than a table inside `chat.db` because two processes write here that never
touch chat.db — the app *and* a short-lived MCP server per lane — and `chat.db` carries a
migration/backup history (`.pre-v1.bak`) that should not acquire a second concurrent writer.
WAL mode, so a read by the app cannot make an unrelated lane's report fail on a lock: a report
lost to a lock is as lost as one left in a worktree.

**Append-only, and that is the concurrency design.** The server only INSERTs; the app reads and
marks rows applied. Neither updates a row the other might be writing. This is also why
`task_status` does **not** write `projects.json`: that file has exactly one writer (the renderer)
and gains nothing from a second one racing it. A status arrives as an **event**; the renderer
applies it.

**2. How a lane reaches the server — an stdio server Operator spawns per lane, and it is the SAME
BINARY.** `operator --mcp-serve`, registered inline at spawn:

```
--mcp-config {"mcpServers":{"operator":{"type":"stdio","command":"<current_exe>","args":["--mcp-serve"]}}}
```

Same binary because Operator is already signed and notarized, already on disk, and already knows
where `~/.operator` is — a second executable would add a runtime to notarize for a process whose
job is to insert one row. `current_exe()` means a lane always talks to the build it was launched
from. Inline JSON means no temp file to write, collide on, or leave behind.

**The user's own MCP servers are safe, and this was checked rather than assumed.** From `claude
--help` on this machine:

```
--mcp-config <configs...>   Load MCP servers from JSON files or …
--strict-mcp-config         Only use MCP servers from --mcp-config, ignoring all other MCP configurations
```

`--mcp-config` **adds**; only `--strict-mcp-config` would ignore the user's. That flag is not
passed — asserted by grep, and the comment above the code says why so nobody adds it as a
tidy-up. `paper` and `obsidian` keep loading in every lane.

**3. How a call identifies its caller — `OPERATOR_TERMINAL_ID`, and an unattributable call is
REFUSED.** It has been exported into every lane since `lib.rs:740`; this is what stops it being
vestigial. Project and role resolve from `sessions.json`, which is already keyed by terminal id.

Refusing is the point: an unattributable report is *worse* than no report — it lands looking like
data, and Operator cannot tell whose it is or which task it closes. Verified live:

```
$ env -u OPERATOR_TERMINAL_ID operator --mcp-serve
→ isError: True
  "unattributable call: OPERATOR_TERMINAL_ID is not set in this environment…"
```

A lane present in the environment but not yet in `sessions.json` is still stored — the terminal id
alone is enough to find it; only a *missing* id is refused.

**4. When a lane doesn't call — silence is visible, because the store records who reported.**
Every row carries `terminal_id`, so "no report from Code" and "Code reported nothing" are different
queries, not the same absence. `artifacts_reports` gives Operator the list to compare against its
own dispatches.

**This is the decision I have LEAST covered, and I want to be plain about it.** The spike's warning
— *"same charter-dependency risk as sentinels, moved, not removed"* — still stands. The tools exist
and are reachable; **the charters have not been updated to ask for them**, because that is a
prompting change across six roles and the brief scoped this pass to the plumbing. Until they are,
this is a capability nobody invokes. The tool *descriptions* do the persuading for now (they name
the failure: "a file written inside your worktree is invisible to Operator"), but a description is
not a charter.

---

## `task_status` closes a task mid-turn — and I shipped a bug into it

`fix-session-task-lifecycle-RESULT.md` declared this structurally unreachable: *"Completion only
fires when a lane DIES… not fixable by reconciliation… Closing them needs a real completion
signal."* This is that signal.

Verified against the **durable write**, not the UI (which has lied about this before) — the
`saveProjects` payload after a status event for the mock's `task-3`, which starts `running`:

```
{ "acked": [1], "persistedTask3": { "status": "done", "doneAt": true } }
```

**The bug, and it is worth recording because it is the exact failure this tool exists to prevent.**
The poll first ran on mount, *before* `loadProjects` resolved — so every task looked unknown, the
unknown-task branch acked, and the event was gone forever. My own comment two lines above said
"dropping it once is the leak". The harness caught it (first run: `acked: [1]`, task still
`running`); the effect is now gated on `savedHydrated`. A signal dropped because we asked too early
is the same lost completion as no signal at all.

Acks happen only **after** the task is written through, so a renderer that dies mid-apply replays
rather than drops. Applying `done` twice is the same task; dropping it once is the leak.

---

## Verify — each bullet

| Bullet | Result |
|---|---|
| Lane reports from a worktree; Operator reads it without touching that filesystem | Driven from an isolated `mktemp` cwd; read back from the main repo |
| `task_status(id,'done')` closes a task mid-turn, checked against durable state | `saveProjects` payload shows `done` + `doneAt`; the lane process was never involved in the write |
| An unattributable call is rejected | Live, `isError: true`; plus a unit test |
| The user's `paper`/`obsidian` still work | `--strict-mcp-config` is absent (grep) and `--mcp-config` is additive (`claude --help`) |
| `npm test` / `cargo test` / build | 637 · 140 · clean |

10 new Rust tests: 5 on the store (survives its writer, newest-first, pending-until-applied, replay
on crash, ordering, opening an existing db keeps rows) and 5 on the server (initialize/tools-list,
notifications never answered, unknown method is an error not a panic, unattributable refused,
status enum enforced). One asserts `operator__dispatch` is **absent** from `tools/list`, so nobody
adds it without reading why.

## Out of scope, honoured

`operator__dispatch` not built. `OPERATOR-DISPATCH`/`OPERATOR-REPLY` untouched — this runs beside
them and a lane whose charter has not changed works exactly as before. No `dev/briefs/*.md`
migrated.

## Not done

- **The charters do not ask for these tools yet** — decision 4's real gap, above.
- **No UI for reports.** `artifacts_reports` is wired to the bridge and typed, but nothing renders
  it; Operator reads the store via the command. A reports panel is the obvious next step and was
  not in this brief.
- **Not exercised through a real `claude` process.** The server is driven directly over stdio,
  which is the same protocol Claude Code speaks, but no lane has yet been launched with the new
  `--mcp-config` in the shipped app. That needs a relaunch (Rust changed) and is your first
  real-world check.
- The store has no pruning. Reports accumulate; at report-sized rows that is fine for a long time,
  but it is unbounded and someone should decide a retention rule before it matters.

## Is this RESULT itself reachable by Operator?

The brief asks, and it is a fair test of whether the thing works. **Both ways, deliberately:** this
file is committed to the branch *and* filed through the plane itself — see the `operator__report`
entry whose artifact is this document's summary. The file is the human-readable copy; the report is
the one that does not depend on which checkout you are standing in.
