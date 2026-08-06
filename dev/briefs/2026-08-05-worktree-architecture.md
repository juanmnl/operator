# RESEARCH: an app-wide architecture for agent isolation. Worktree lifecycle is unowned.

**Lane: Research. Investigate and report — change no product code.** Throwaway probes under `dev/`
are fine.

## The problem, measured tonight (not hypothetical)

A cleanup pass across this repo found:

| Symptom | Evidence |
|---|---|
| Worktrees never reaped | **33 worktrees** for one repo |
| Branches drift past mergeability | 48–137 commits behind; 3 branches now unmergeable because 11 of 16 files no longer exist |
| Work invisible outside its worktree | **20 files existed only inside worktrees**, incl. **3 RESULT documents believed never written** |
| Merges never happen | 9 commits sat unmerged for days; found only by an audit |
| Stale base inherited | `src-tauri/src/worktree.rs:80` creates each lane from the **caller's `HEAD`**, so a stale coordinator hands staleness to every lane it spawns |
| Orphaning on launch | Launching an idle lane creates a **brand-new** worktree instead of reusing its registered one, stranding whatever was in the old one |

Root cause is not git. **No component owns a worktree's lifecycle** — creation is ad-hoc, merge-back
is manual, reaping never happens, and artifacts written inside are addressable only by absolute
path. Point fixes are already dispatched (coordinator on main, branch from default branch). This
brief is the architecture question those fixes don't answer.

## The question

**What should Operator's isolation model be, such that lifecycle is owned rather than assumed?**
Concretely, every candidate must answer: where does an agent's work live, how does it get back to
main, when is its workspace destroyed, and how do other lanes see what it produced.

## Prior art to study — these are real, current, and solving exactly this

- **[Conductor](https://conductor.build)** (Melty Labs) — macOS app, parallel Claude Code agents,
  one isolated worktree each. Closest analogue to Operator. How does it merge back, and what does it
  do with a worktree when the task ends?
- **Crystal → [Nimbalyst](https://nimbalyst.com/blog/best-git-worktree-tools-ai-coding-2026/)** —
  Crystal was deprecated Feb 2026 and redirected to Nimbalyst. **Find out why the rewrite happened**;
  a deprecation is a design lesson someone already paid for.
- **Sculptor** (Imbue) — uses **containers instead of worktrees**. This is the strongest challenge to
  our model: what does container isolation give that worktrees can't, and what does it cost?
- **[Dagger container-use](https://github.com/dagger/container-use)** — same direction, MCP-shaped.
- **[diri](https://github.com/cristicretu/diri)** — "across git worktrees **or on remote hosts**"
  ([[project_competitor_diri]]). Read its actual worktree lifecycle code, not its README.
- **[awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators)** — sweep
  for anyone who wrote up the lifecycle problem specifically.
- **Claude Code itself** — the Agent tool takes `isolation: "worktree"` and, per its own docs, the
  worktree is **"auto-cleaned if unchanged."** That is a lifecycle policy shipping inside the product
  we host. Find out exactly what it does and whether we can defer to it instead of reimplementing.
- **Jujutsu (`jj`)** — worth one section, because it dissolves a failure mode rather than managing it:
  with no dirty state, "uncommitted work stranded in a worktree" cannot occur. Are agent tools
  adopting it? What breaks (the repo is git; lanes run `git`)?

## Options to evaluate — score each, don't just describe

1. **Worktrees + owned lifecycle** — created from the default branch, auto-committed at turn
   boundaries, auto-merged or auto-PR'd, reaped on completion. Least disruption; needs a real owner.
2. **Containers per lane** (Sculptor / container-use). Stronger isolation, no stale-checkout class at
   all — but what happens to the pty, the dev server, and per-project ports?
3. **Auto-commit / checkpoint everything** — no dirty state ever exists, so nothing can strand. What
   does that do to history, and to review?
4. **No isolation for some lanes** — the direction already taken for the coordinator. Which roles
   genuinely need isolation, and which just need a checkout?
5. **Artifact plane separate from the code plane** — whatever the isolation, briefs and RESULTs stop
   living in the worktree and move to a shared namespace addressed by logical name. Note
   `dev/mcp-control-plane-spike.md` already rates `operator__brief` / `operator__report` as a
   confirmed clean win, and tonight's 20 stranded files are the receipt. **Judge whether this alone
   fixes most of the pain** — it may be the highest ratio of benefit to disruption.

## What the output must contain

A **recommendation**, not a survey — one primary model plus the smallest first step that is useful
on its own and doesn't require the rest. For each option: what breaks, what it costs, what it fixes,
and what it does about the six symptoms in the table above. Say explicitly which symptoms your
recommendation does **not** address.

Also answer these, since they constrain every option:
- Can a lane's work be made durable **without** a merge (so nothing depends on a human noticing)?
- What is the correct trigger for destroying a workspace — task done, branch merged, idle timeout,
  or explicit only?
- Should a lane's branch outlive its worktree? (Tonight refs were kept while worktrees were reaped —
  cheap and lossless. Is that the general rule?)

Cite versions, dates, repos. "Tool X does worktrees" is not a finding; how it decides to delete one
is.

## Output

Write `/Users/juanmnl/Developer/operator/dev/briefs/2026-08-05-worktree-architecture-RESULT.md`
(absolute path — note this is the MAIN repo, not a worktree, deliberately: this brief is about
artifacts not getting stranded).
