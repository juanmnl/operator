# Design references — layout targets for Operator

Running note. Screenshots the user has pointed at as "what we're aiming for", and what each one
actually contributes. Not a backlog: some of this is already briefed, some conflicts with a
recorded decision, some is just worth knowing.

---

## 1 · Codex (2026-07-31)

Briefed as `dev/briefs/channel-codex-layout.md`.

- **Three zones**: thread sidebar · conversation column · detail pane.
- **Narrow conversation measure (~70–80 chars).** The window's extra width becomes a *second pane*,
  not longer lines. This corrected our `PROSE = 900` (151 chars).
- **Muted one-line activity rows** — `Ran 5 commands, edited 1 file`.
- **Collapsible inline cards** — `2 active child threads`, `Uncommitted · 25 files, +3,104 −116`.
- **Composer docked in the column** with a contextual status bar (folder, worktree, branch, model).
- Scope, per the user: arrangement, button placement and message box — **not** typography or
  identity. **Avatars stay.**

---

## 2 · PR-centric agent tool (2026-07-31) — "Ask Michael"

Not briefed. Recorded for the ideas below.

### What it does that we don't

**Left nav groups work by STATE, not by project.** `Awaiting review 1` · `In progress 2` ·
`Ready to merge 4` · `Backlog 7`, each with a count, each item showing elapsed time (`24:32`,
`1:11`). It is a work queue, not a directory.

> **Maps directly onto our open questions.** "The agents button should be just for active agents"
> is a smaller version of this. Our lanes already have states — running / waiting / idle / queued —
> and tasks already have `running` / `done` / `abandoned`. We render them grouped by *project* and
> then by live-vs-idle. Grouping by **state** across projects, with elapsed time, is a strictly
> better answer to "what is happening and what needs me" and it is the same data.

**The right panel is TABBED context**: `Info` · `Changes 145` · `Terminal` · `Agents 1`.

> **The Terminal is a TAB in the context panel, not the main surface.** That is a real
> architectural suggestion for us and it agrees with the recorded hybrid direction — structured UI
> as the primary surface, terminal kept as the fidelity escape hatch. Today our terminal *is* the
> main surface and Console/Chat/Preview overlay it. Worth its own brief if pursued; it collides
> with the existing Plan/Diff panel, same as Codex's detail pane does.

**Collapsible activity rows in the conversation**: `> Review findings · PR #3673 · 13h`,
`> Worked · 6m 23s · 51 steps`.

> Confirms the digest direction from a second product. Note the shape: a *verb*, a *duration*, a
> *step count* — a summary that reports work done rather than truncating prose.

**Per-message duration and actions**: `58s`, `6m, 34s` with copy / more beneath each block.

> We have this data (`Churned for 1m 22s` appears in our own transcript) and don't surface it in
> the channel.

**Git state as first-class panel content**: `Ready to merge` with a Merge action, `15 commits
behind main` with a Pull action, checks, comments, files changed.

> We have `CanvasDiffPanel` and worktrees; we do not surface branch state or offer actions on it.

### What NOT to take

**The cost readout in the composer** (`$1.48` beside the model picker).

> ⚠️ **This contradicts a recorded decision.** Operator's direction is economy-**as-config** —
> Model + Effort + Verbosity as pills — and explicitly *not* a cost display; the per-model $/Mtok
> hint was deliberately hidden. Don't let a reference reopen a settled call by accident. If the
> user wants to revisit it, that's a decision, not a layout detail.

---

## How to use this file

When a reference arrives: record what it *does*, then separate (a) what maps onto a real Operator
problem, (b) what is a different product's answer to a problem we don't have, and (c) what
conflicts with something already decided. The third category is the one that causes damage if it
goes unnoticed.
