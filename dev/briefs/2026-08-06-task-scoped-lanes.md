# Lanes become task-scoped: spawn on demand, close when the work is reported done

User, 2026-08-06: *"if idle lanes are a problem, why not auto-close when they finish their task?
maybe just Operator manages that and spawns agents just when needed, that could even polish the
worktree management."*

## Why this is possible now and wasn't yesterday

`fix-session-task-lifecycle-RESULT.md` concluded, about ~200 tasks stuck in `running`:

> *"Completion only fires when a lane DIES… there is no per-turn completion signal…
> **Not fixed here and not fixable by reconciliation**… Closing them needs a real completion signal."*

That is why auto-close was never viable — the only "done" signal was the thing you were trying to
trigger. **`operator__task_status(id, 'done')` shipped in v0.14.0 is that signal.** The idea and its
enabler landed the same day. Do not build a heuristic for "finished"; the explicit report exists now.

The routing already supports on-demand spawning: `routeDispatch` (`src/renderer/lib/dispatch.ts:75`)
returns `{kind:'send'}` for a live lane, `{kind:'queue'}` for a rostered lane that isn't running, and
`{kind:'create'}` for a preset that isn't in the roster yet. **This change makes `queue`/`create` the
normal path rather than the exception** — it is not a new mechanism.

## THE INVARIANT: close means detach, never forget

A closed lane must remain **readable and resumable**:

- **Resumable** — `sessions.json` stores `claudeSessionId` per lane (verified correct and durable
  tonight against live processes). Relaunching with `claude --resume <id>` restores the thread. Same
  mechanism herdr uses to survive its own restarts.
- **Readable** — chat reads the transcript JSONL and `chat.db`, both of which outlive the process.
  Verify a closed lane's history is still browsable; if it isn't, that is a blocker, not a polish item.

If "close" ever means "gone", this whole design is wrong. Everything below assumes suspend, not kill.

## Behaviour to build

1. **Close on explicit completion.** A lane that reports `task_status done` and has no further queued
   work closes — after a **keep-warm grace window**, not instantly (see cost, below).
2. **Spawn on demand.** A dispatch to a role with no live lane launches it and delivers, via the
   existing `queue`/`create` routes. Reuse `--resume` when a prior session exists for that role so
   the lane keeps its thread instead of starting cold.
3. **Worktree lifetime = task lifetime.** This is the "polishes worktree management" half, and it is
   the stronger half: research recommended a registry plus an **age-based** reaper
   (`2026-08-05-worktree-architecture-RESULT.md`), which is cleanup triggered by *time*. Task-scoped
   closure makes the trigger *semantic* — a branch cannot drift 137 commits behind if it only exists
   while work is happening. The reaper stays, demoted to a backstop for anomalies.
4. **Snapshot uncommitted work before reaping, unconditionally.** Precedent exists and worked: the
   `"WIP preserved before reaping this worktree"` commits from 2026-08-05. Never remove a directory
   with loose edits in it.
5. **Reuse the existing teardown route.** `handleCloseSession` already kills the pty, finishes running
   tasks, removes the worktree dir **keeping the branch**, and drops the saved session — and
   `closeProject`'s comment is explicit that there must be *"no second teardown route, and nothing
   pattern-kills"*. Do not write a parallel one. Note the four-bug fix made that path resilient to a
   hung lane; keep that property.

## The three decisions — my recommendations, argue if you disagree

1. **What counts as finished.** `task_status done` only. **`idle` is NOT finished** — a lane waiting
   on a permission prompt is indistinguishable from a lane with nothing to do, and closing that one
   kills a turn mid-flight. Operator's own status vocabulary already separates `waiting` (your turn)
   from `idle`; respect it.
2. **The charter-dependency risk**, named honestly in `dev/mcp-control-plane-spike.md` as *"the same
   risk as sentinels, moved, not removed"*: a lane that never calls `task_status` never closes. So
   backstops are **not optional** — pty exit, plus a long idle timeout. Critically, **distinguish
   "reported done" from "went quiet"**: they mean different things and probably deserve different
   treatment (the second is a bug signal, not a lifecycle event). Surface the difference; do not
   silently treat silence as success.
3. **Uncommitted work** — snapshot, always, per (4) above.

## The cost, stated plainly

A live pty is instant; a spawned one pays process start plus context rehydration on every dispatch.
Bursty dispatch traffic would thrash — spawn, work, close, spawn again. **A keep-warm grace window
(close only after N minutes idle *following* a completion report) gets nearly all the memory benefit
without the churn.** Pick N, justify it, make it configurable.

## Out of scope — do not touch

- **The dispatch protocol.** `OPERATOR-DISPATCH` / `OPERATOR-REPLY` sentinels, and
  `operator__dispatch` (deliberately unbuilt pending the push/pull question). This changes lane
  *lifecycle* only.
- The coordinator. It runs in the repo and is long-lived by design — it is not task-scoped.
- Auto-merging a task's branch. Research found every tool studied keeps merge human-gated; that
  stands.

## Verify

- A lane reporting `done` closes after the grace window; its worktree is handled and **its branch is
  kept**.
- Re-dispatching to that role **resumes the same thread** (`--resume`), not a cold session.
- A closed lane's transcript/chat history is still readable.
- A lane that goes quiet **without** reporting does not close on the short path, and is visibly
  distinguished from one that completed.
- A lane in `waiting` (prompt on screen) is never auto-closed. This is the one that will bite.
- Uncommitted edits are snapshotted to a commit before any directory is removed.
- Measured: idle lane count and renderer RSS before/after. Tonight's baseline is **27 lanes, 2
  working, renderer peaking 1.1–1.2GB and being killed hourly**.
- `npm test` green (650 on `main` = `cbdd4ef`), `cargo test` green (140), build clean.

## Output

Write `/Users/juanmnl/Developer/operator/dev/briefs/2026-08-06-task-scoped-lanes-RESULT.md`
(absolute path, main repo). Lead with the grace-window value you chose and why, and state what
happens to a lane that goes quiet without ever reporting.
