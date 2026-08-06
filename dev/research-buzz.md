# Research — Block's Buzz vs. Operator's project channel

No brief existed at `dev/briefs/research-buzz.md` — this file is the deliverable, per the direct
ask. Read alongside our own prior art rather than re-deriving it: Q3/Q6 of
`research-project-chat-return-path-RESULT.md` (identity, addressability) and the two shipped
guardrail layers in `agent-to-agent-delivery-RESULT.md` + `harden-lane-dispatch-authority-RESULT.md`
(delivery, authorization) are the baseline everything below is measured against.

## What Buzz is

Block (Jack Dorsey) shipped Buzz 2026-07-21: an open-source, self-hostable Slack/Discord-style
workspace where AI agents are full members — not slash-command bots — with their own accounts,
posting in channels/threads, reviewing code, running approved automations. Built on Nostr (each
agent gets an independent cryptographic keypair); hosts agents via the Agent Client Protocol
(Claude Code, Codex, Block's own goose). Git hosting is built in: feature branches auto-become
channels, with CI results and review comments preserved alongside the discussion that produced
them. Status is explicitly "early stages" per Dorsey. [SiliconANGLE](https://siliconangle.com/2026/07/21/block-launches-buzz-open-source-workspace-humans-ai-agents/) · [TechCrunch](https://techcrunch.com/2026/07/21/jack-dorsey-is-taking-on-slack-with-buzz-a-group-chat-platform-for-teams-and-their-ai-agents/) · [eesel](https://www.eesel.ai/blog/buzz-app) · [SD Times](https://sdtimes.com/open-source-ai/block-rolls-out-buzz-ai-collaboration-workspace/)

## Point-by-point against what we already have

**Agent identity — Buzz's sharpest idea, and it lands on a gap we already found.**
Buzz: every agent is a first-class, cryptographically distinct member — a message's author is
never ambiguous. Operator's own Q5 finding: a lane is `Role.id` on the roster (fine), but **a
human typing directly into a lane's pty is byte-identical to a dispatched task** — both are just a
`"user"` turn in that lane's transcript, distinguishable only by cross-referencing the separate
`DispatchRecord` log. We don't need Nostr keys to fix this (single-user local desktop app, one
install — there's no federation or multi-tenant trust problem to solve). But the *principle* —
every actor visibly stamped on every message — is cheap to adopt narrowly: the lane→lane reply
prefix (`[Operator · message from Code] `, already shipped in `agent-delivery.ts`) could extend to
human→lane channel sends, so a receiving lane's own transcript can tell "a person said this" from
"a dispatch commissioned this" without a second lookup. **Recommend: adopt, small.**

**Threading / addressability — Buzz treats it as table stakes; we explicitly don't have it.**
Q6 named this as the single biggest gap between what we ship and "chat with your agents": no
message ids, no thread, nothing ties a reply to the question that prompted it — what we have is a
fire-and-forget project-scoped feed, not a conversation. Buzz's plain thread model (and its
sharper branch-as-channel version, below) is direct validation that this gap is real and visible
to users, not a nice-to-have. We already have most of the plumbing: `replyId` and hop-inheritance
in the agent-to-agent guardrails prove a message can carry a stable identity and a lineage — it's
just folded into one row instead of surfaced as an actual thread. **Recommend: adopt, medium
effort** — the next channel iteration should let a human open a specific dispatch/reply and see
its chain, not just its collapsed outcome chip.

**Branch-as-channel / unified review — genuinely new, not something we're part-way toward.**
Buzz auto-creates a channel per feature branch and threads CI + review comments + merge decision
into it. Operator has the adjacent pieces (worktree per lane, `CanvasDiffPanel`, a Review lane in
the roster) but no unifying thread — a diff review today is a separate panel, not a conversation
with a record. This is the one idea in Buzz with no existing Operator analog at all. **Recommend:
worth a design pass, not urgent** — it's a bigger bet than the channel work already in flight, and
should wait until the plain-thread gap above is closed (no point threading a diff review before
threading a text reply works).

**Multi-agent roles ("one does the work, one does QA") — we're already there, arguably ahead.**
Buzz's write-up describes a user configuring 2-3 agents by role ad hoc. Operator's roster
(`Operator·Research·Code·Review·Design·QA`, each pinned to model/effort/worktree, seeded by
default) is the structured version of the same idea. Nothing to adopt here — if anything this is
confirmation the roster model is the right shape, not a correction.

**Authorization / "agents sign their own work" — comparable concept, coarser granularity, and
already shipped.** Buzz: narrowly-scoped, owner-signed per-agent authorizations. Operator: the
just-shipped dispatch-authority gate (`harden-lane-dispatch-authority-RESULT.md`) — a
non-coordinator lane's dispatch is held for explicit human approval, never auto-delivered.
Coarser (binary coordinator/non-coordinator, not per-action scopes) and not cryptographically
verifiable, but it's the same instinct — an agent's ability to *commission* work is gated, not
implicit — and it's already live. **No action needed**; if this gets revisited, per-action scope
(e.g. "Code may dispatch to QA but not to Design") is the natural next increment, not crypto
signing.

**Interrupt / mid-task addressing — Buzz doesn't actually solve this either.** It's tempting to
read "agents post in channels like coworkers" as solving Operator's known gap (no way to inject an
out-of-band question into a busy lane, `submitQueue` is FIFO-only). But Buzz hosts agents over the
same kind of session-based protocol (ACP) we host Claude Code's CLI over — nothing in the coverage
describes it pausing a running agent to inject a priority message. Treat this as a shared open
problem, not a place Buzz is ahead. **No action** — don't chase a solved-elsewhere fix that isn't
actually solved elsewhere.

**Subagent authorship — not from Buzz, but Buzz raises the bar we're already short of.** Q5 found
`NarrationEntry` (the text a chat view actually renders) carries no `caller` field — a subagent's
prose is indistinguishable from its parent lane's own text, even though `ToolBlock.caller` is
populated on 100% of real tool calls. Buzz's every-message-has-an-author framing is a preview of
what users will expect once channel/chat is a real surface. **Recommend: prioritize the existing,
already-identified fix** — thread `caller` through to narration, not just tool blocks — ahead of
building anything new that would inherit the same gap.

## Explicitly not recommended

- **Nostr / cryptographic keypairs.** Solves federated multi-tenant trust; Operator is a
  single-user local app with one install. Complexity with no corresponding problem.
- **Model-agnostic hosting via ACP.** Already a deliberate, recorded NORTH STAR call — Operator
  hosts Claude Code's own CLI/transcript on purpose; multi-provider is explicitly deferred. Buzz
  launching model-agnostic doesn't change that trade.
- **Full Slack-replacement scope** (voice, DMs, org-wide workspace chat). Operator's channel is
  project-scoped coordination for one person's agent fleet, not a team communication platform —
  different product, don't grow toward Buzz's breadth.

## Bottom line

Buzz mostly validates decisions already made here (agents as first-class roster members, a gated
dispatch-authority layer) rather than revealing a new direction. The two ideas worth actually
taking: **stamp human-authored channel sends with the same author-prefix convention lane replies
already use** (closes a named gap, ~small), and **treat the Q6 threading gap as confirmed-important
rather than deferrable** now that a real shipped product treats it as baseline. Branch-as-channel
is the one genuinely novel idea worth a future design pass, but it's downstream of threading, not a
substitute for it.
