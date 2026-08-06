# Worktree/isolation architecture — result (2026-08-05)

## Recommendation, up front

**Primary model: Option 1 — worktrees + an OWNED lifecycle, not Option 2's containers.**
Nothing in the six measured symptoms is an isolation-boundary failure (no "two agents
corrupted each other's files" bug anywhere in the list); every one is a bookkeeping
failure — nobody registers, reaps, or tracks what a worktree is for. Containers would
add a hard Docker dependency and a whole new per-lane pty/dev-server/port story to fix a
problem Operator doesn't have, while leaving the *actual* bug untouched: `container-use`
and `diri` — the two tools I could verify at the source level — **both default new
environments to the current HEAD, exactly like Operator, container or not.** Isolation
technology was never the missing piece; ownership was.

**The smallest useful first step, standing entirely on its own: ship the MCP artifact
plane from `dev/mcp-control-plane-spike.md`** — `operator__report` + `operator__task_status`
first, `operator__brief` next. That spike already scoped this as a small, low-risk,
few-week effort, and it fixes the single most expensive symptom in the table (20 files
stranded, including 3 RESULT documents nobody knew existed) **without waiting for
worktree lifecycle to be redesigned at all.** Ship it first regardless of what happens
to the rest of this brief.

The full primary-model redesign, once that's shipped, borrows three concretely-sourced
mechanisms from tools that have actually solved pieces of this (details and citations
below):
1. A **durable per-lane registry** (from diri's `SessionRegistry`) so relaunching an idle
   lane reuses its own worktree instead of orphaning it.
2. An **explicit, age-based reaper** (from `container-use prune --before`) as a backstop
   for worktrees nobody ever closes by hand.
3. **No auto-merge** — every real tool studied (Conductor, container-use) keeps merge
   human-gated behind a review/CI check; instead, surface staleness/un-mergedness so it
   can't be silently ignored, rather than trying to make merging itself automatic.

---

## What was actually found in Operator's own code (not inferred)

- `src-tauri/src/worktree.rs:80` — `create_worktree` runs `git worktree add -b <branch>
  <path> HEAD` against whatever `source_cwd` currently has checked out. Confirms the
  brief's claim exactly; there's no default-branch resolution anywhere in this function.
- `DashboardView.tsx` `handleLaunchRole` (~line 1939-2003): when a role has no *live*
  session (`pickLaneTab` finds nothing), it unconditionally calls `handleLaunchSession
  (project.path, …)` — always the source repo root, never a previously used worktree
  path. **There is no registry mapping `(project.id, role.id)` to a durable worktree.**
  `worktreeBranch`/`worktreeBase` exist only as fields on the in-memory `TerminalTab` for
  the *current* session; once that tab is forgotten (`forgetSavedSession`), the
  association is gone. This is the exact mechanism behind "orphaning on launch."
- Reaping is real but 100% manual: `handleCloseSession` (`DashboardView.tsx:2253`) is the
  **only** call site for `worktreeRemove` anywhere in the app. It only fires on an
  explicit "close session" UI action — never on pty death, crash, app restart, or idle
  timeout. It deliberately keeps the branch ("user may want to merge or review later").
  Merge (`worktreeMerge`, `TaskDiffCard.tsx`/`DiffPanel.tsx`) and discard are equally
  manual, single-button, human-gated actions; `merge_branch` (`worktree.rs:244`) requires
  the source repo to be clean and on the base branch already.
- **Freshly reconfirmed tonight**: `git worktree list` shows 10 live worktrees, but
  `git for-each-ref refs/heads/operator/` shows **36 branches** — 26 of them already
  orphaned-but-kept exactly as designed. Drift has gotten *worse* since the brief's table
  was written: the worst branches are now **145 commits behind** main (was 48–137).
  Nothing has been merging them in the interim.

This means the six symptoms are not five different bugs — they're one bug (no
lifecycle owner) showing up in five places, plus one true architecture gap (artifacts
addressed by absolute path instead of logical name).

---

## Prior art — what was verified, not paraphrased from marketing pages

| Tool | Base branch/commit | Merge-back | Destruction | Registry for resume |
|---|---|---|---|---|
| **Conductor** (conductor.build) | Undocumented gap — their own docs never say | Manual: diff review → CI/comments/todos gate → PR → merge. `conductor.json`'s `setup`/`run`/**`archive`** hooks make archiving a named lifecycle stage, not just a button. | Manual archive only, "instant" as of **v0.46.0** (2026-04-05; pre-that, archiving itself was slow enough to need a dedicated fix). Archived ≠ deleted — restorable from a History pane. **Never truly destroys**, same philosophy as Operator. | Undocumented ("Fork workspace," v0.25.6, is the closest related concept but creates a *new* workspace, not a resume) |
| **Crystal → Nimbalyst** | N/A | N/A | N/A | N/A — **the "why the rewrite" question resolves cleanly: it wasn't a worktree-architecture failure.** Crystal's changelog (`stravu/crystal/CHANGELOG.md`, v0.3.5, 2026-02-26) gives no technical reason at all, just "successor product." Nimbalyst is **still git-worktree-based** — this was scope expansion (kanban, visual editors, mobile companion), not an architecture reversal. Their own worktree-tools blog draws 3 real lessons instead: (1) worktrees stop file collisions, not semantic ones; (2) **runtime isolation (ports/DB/test state) matters more than file isolation** — Operator already has this, via its per-project reserved-port system; (3) git can't check out one branch in two worktrees, so unique branch names are structurally required — Operator already does this (`operator/<hash>`). All three checked against Operator: **already handled.** |
| **Sculptor** (Imbue) | N/A (Docker) | "Pairing Mode" — bidirectional container↔local-IDE sync, mechanism unspecified. One Imbue page contradicted every other source by describing worktrees instead of containers — flagged as an unresolved discrepancy, weight of evidence says Docker is real. | Not documented | Not documented |
| **Dagger container-use** | `HEAD` by default (source-confirmed, `repository.go:185`), override-able via an explicit `source` param nobody is forced to pass — **the identical bug**, just override-able. | Real `git merge` via a human-run `container-use merge` CLI command (`cmd/container-use/merge.go`), auto-stashing the user's own dirty tree around it. Never automatic. | `container-use delete <env>` (explicit) **or `container-use prune --before <age>`** (default **1 week**, `--dry-run` supported) — a genuine age-based reaper, still user-invoked, not a background daemon. | **Git notes** inside a per-repo bare "fork" (`~/.config/container-use/repos/<hash>`) — the registry is git-native, not a side file. |
| **diri** | Also defaults to current HEAD (source-confirmed: `SessionRegistry.swift`'s worktree-creation call site never passes a `base` to `GitWorktrees.create`) — same bug as Operator. | Not exercised by diri's own design (no auto-merge found) | Explicit RPC/CLI only (`worktreeRemove`); a code comment states the philosophy directly: *"worktree is a hard stop (never destroy work)."* No auto-reap found. | **Yes — `SessionRegistry` + `PersistenceStore`, restored on daemon restart**, re-validating each session's live process via a socket handshake before offering it as resumable. This is exactly the registry Operator is missing. |
| **Jujutsu (jj)** | — | — | — | — |

**Jujutsu**: no tool studied uses it. The one real case study, `2389-research/agentjj`
(archived 2026-02-17, 6 stars — an abandoned experiment, not an adopted pattern), tried
exactly the idea this brief floats — no dirty working copy so nothing can be stranded —
and backed out of it. Their own stated reasons: jj's `absorb` behavior squashed
logically-distinct agent commits together, simultaneous agents' changes got bundled
unintentionally, and running colocated mode (`jj git init --colocate`) alongside raw
`git` commands (exactly what Operator's lanes do inside their sandbox) produced
contradictory state — files jj tracked could show as "deleted" from git's own
perspective. Their conclusion: *jj's core simplification removes the staging area, which
is friction for humans but is the exact mechanism agents need for selective, granular
commits* — the opposite of what the brief hypothesized. **Don't pursue jj**; this is
settled by a real (if small) prior attempt, not a theoretical guess.

---

## Options, scored

### 1. Worktrees + owned lifecycle — **recommended primary model**
- **Fixes**: S5 (stale base — enforce default-branch resolution structurally, not as a
  one-off patch, since every tool studied defaults to HEAD unless a caller actively
  overrides it — this bug reappears unless it's the *default*, not an option); S6
  (orphaning on launch — a durable `(projectId, roleId) → {path, branch, base}` registry,
  diri's pattern, checked/restored at launch instead of always creating fresh); S1
  (reaping — an explicit, age-based `prune`-style sweep, container-use's pattern, as a
  backstop behind the existing manual close, not a replacement for it); partially S2/S4
  (a registry + reaper make staleness visible and lanes reusable, which reduces how much
  work sits forgotten — but does not by itself force anyone to merge).
- **Does NOT fix**: S3 (artifacts stranded by path) — that's the separate architecture
  gap Option 5 answers. Auto-merge is explicitly **not** part of this recommendation (see
  below) — S2/S4 improve but aren't eliminated.
- **Cost**: moderate — a real registry (persisted, restore-on-restart, keyed the same way
  `sessions.json` already keys other durable state) and a reaper policy need a genuine
  owner and tests, but this is refactoring existing, already-understood code
  (`worktree.rs`, `DashboardView.tsx`), not new architecture.
- **Risk**: low. This is the least-disruptive option and the one every prior-art source
  converges on — even the container-based tools (container-use) still use git worktrees
  underneath for the actual workspace; the registry+reaper pattern is portable regardless
  of what sits inside the workspace.

### 2. Containers per lane (Sculptor / container-use)
- **Fixes**: nothing in the six symptoms that worktrees don't already fix just as well —
  confirmed directly: both container-based tools researched still default to HEAD (the
  #1 symptom), and container-use's own registry is git notes on a git worktree, not
  something containers uniquely enable.
- **Costs**: a hard Docker Desktop dependency (friction in a desktop consumer app that
  currently has none); per-lane image build/startup latency (Sculptor's own "10x faster"
  claim implies it was *slow* before optimization, no reproducible numbers published);
  Operator already runs one pty + one reserved dev-server port per lane directly against
  the host — containerizing multiplies that into port-forwarding/volume-mount plumbing
  for every lane, a real new failure class Sculptor's public writing doesn't discuss
  solving.
- **What it would actually buy**: stronger isolation on the *dependency/environment* axis
  (reinstalling deps per worktree vs. baked-in image layers) — a real cost today, but
  Nimbalyst's own lesson #2 (runtime isolation matters more than file isolation) is
  already substantially covered by Operator's existing per-project port reservation.
  Not worth the Docker dependency to fix a problem this app's own north star
  ([[project_direction]]: Operator hosts Claude Code's own CLI directly, not a
  container platform) already argues against taking on.
- **Not recommended** as the primary model.

### 3. Auto-commit / checkpoint everything
- **jj specifically**: refuted by the one real case study available (`agentjj`, above).
  Not recommended.
- **Plain git auto-commit at turn boundaries** (not jj): more promising, and partially
  already built — `TaskDiffCard.runMerge` already does `worktreeCommit` to sweep
  uncommitted edits into the branch before merging. Extending that to run automatically
  at every turn boundary (not just pre-merge) directly prevents "uncommitted work
  stranded when a worktree is force-reaped" without adopting jj at all.
- **Cost**: noisier history (many small commits) — mitigated the same way every
  human-gated-merge tool studied already handles it (squash-on-merge via the existing PR/
  merge UI). Worth folding into Option 1 as a bolt-on, not standing up as its own
  separate architecture.

### 4. No isolation for some lanes
- Already the direction taken for the coordinator (dispatched point fix: coordinator on
  main). The clean next candidate is **Research** — this lane never writes product code
  by charter, so it never needs a worktree at all; every worktree it's ever handed one
  is pure overhead contributing to symptom S1's raw count. (`mcp-control-plane-spike.md`
  independently flagged Research as "the obvious candidate" for the same reason, in a
  different context — lowest interrupt-need, already file-based.) Review/QA lanes that
  are primarily read-only are the next tier to examine.
- **Fixes**: reduces the *volume* of worktrees created in the first place (fewer needless
  ones), which shrinks S1's raw count, but doesn't touch the lifecycle problem for lanes
  that genuinely mutate files (Code/Design still need everything in Option 1).
  Complementary, not a substitute.

### 5. Artifact plane separate from the code plane — **the smallest first step**
- Already scoped in `dev/mcp-control-plane-spike.md` (read directly, not re-derived
  here): `operator__report(taskId, summary, artifacts[])` and `operator__task_status`
  are rated a "confirmed clean win" — pure lane→Operator calls, the direction MCP tool
  calls are built for, no delivery-race risk. `operator__brief(name)` resolves briefs by
  logical name against Operator's own store instead of a path relative to whichever
  worktree happens to be reading it — "worktree isolation stops being able to break it,
  by construction."
- **Fixes directly**: S3 (the 20 stranded files, including 3 unseen RESULT docs — this
  is the exact failure this spike was written to solve) and, per that spike's own
  analysis, closes the *specific* mechanism behind the task-lifecycle leak that a prior,
  independent investigation called "not fixable by reconciliation" — a real
  `operator__task_status(id,'done')` call from inside a turn is the completion signal
  that's been structurally missing, which materially helps S4 and gives Option 1's
  reaper a trustworthy "is this lane actually done" signal to key off of.
- **Does NOT fix**: S1, S2, S5, S6 — it never touches worktree creation, basing, or
  destruction at all. It's purely an artifact-visibility and completion-signal fix.
- **Cost**: small, per the spike's own estimate — "a small, few-week effort," comparable
  in scope to already-shipped features (task lifecycle, agent-to-agent delivery).
  Sentinels/`*-RESULT.md` stay as fallback throughout — zero risk to lanes whose charter
  hasn't been updated yet.
- **Why it's the right first step**: it's useful entirely on its own, doesn't require the
  registry or reaper to exist first, and is already de-risked by prior research (the
  spike already answered the hard "does MCP even fit Operator's sync Rust backend"
  question: yes, a channel/tool server is a stdio subprocess, not an HTTP stack bolted
  onto the app).

---

## Answers to the three constraining questions

**Can a lane's work be made durable without a merge?** Yes, and this is already
Operator's de facto behavior (26 of 36 `operator/*` branches are orphaned-but-kept right
now) — every tool studied agrees: durability = commit + keep the ref, independent of
whether or when a human merges (Conductor archives without deleting; container-use keeps
the branch unless `--delete` is explicitly passed; diri's own code comment: *"never
destroy work"*). What's missing isn't a merge — it's (a) reliable auto-commit so nothing
uncommitted gets lost when a workspace is reaped (Option 3's bolt-on), and (b) artifacts
reachable by logical name so durability doesn't depend on the worktree directory still
existing (Option 5).

**What is the correct trigger for destroying a workspace (the directory, not the
branch)?** Two triggers, both needed, neither alone: **explicit close** (today's only
trigger — keep it) **plus an idle-timeout backstop** modeled on `container-use prune
--before` (age-based, e.g. dir untouched N days *and* its terminal/session is confirmed
dead) for the abandoned/dispatched lanes nobody ever explicitly closes — which is
exactly how 33 worktrees accumulated. **Never** trigger on "branch merged" alone (a
worktree may still be mid-review) and never on "task done" alone without confirming the
lane isn't live (mirror the existing `laneLive` gate `TaskDiffCard.tsx` already uses for
its merge/discard buttons).

**Should a lane's branch outlive its worktree?** Yes — unanimous across every tool
studied (Conductor, container-use, diri) and already Operator's accidental practice.
Make it an explicit, permanent policy rather than a side effect: cheap (a ref is nearly
free to keep), lossless, and it's the only reason tonight's 20 stranded files are even
recoverable at all.

---

## What this recommendation does not address

Stated plainly, per the brief's own requirement: this recommendation does not solve
**S2 (branch drift) or S4 (merges never happening) as a hard guarantee** — it makes
staleness and un-merged work *visible and reusable* (via the registry and reaper), not
automatically resolved, because every real tool studied deliberately keeps merge
human-gated behind review/CI, and blind auto-merge is a correctness risk none of them
took on. If unmerged work piling up for days is judged unacceptable rather than merely
undesirable, that needs a separate, explicit decision to accept the risk of automated
merging (or auto-PR creation, which is safer than a blind merge and is Conductor's actual
model) — not something this architecture question resolves by itself.
