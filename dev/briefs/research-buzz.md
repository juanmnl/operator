# Brief — research Buzz (Block/Dorsey), and what Operator should take from it

**Investigate and report. Change no code.** Output: `dev/research-buzz.md` (see Output below).

## What Buzz is (my 10-minute scan — verify all of it, correct me where I'm wrong)

Open-source team-chat platform from **Block**, launched **2026-07-21** (nine days ago, pre-1.0).
AI agents are first-class members of channels. Points I picked up but did NOT verify:

- Slack-like channels; agents live in them as members alongside humans.
- Each agent gets a **cryptographic identity, scoped permissions, and a signed record of its
  actions**.
- **Hosts Git projects** in the same window — chat, code review and agents in one place.
- Self-hosted relay built on the **Nostr** protocol; bring your own model; own your history.
- Agents connect over the **Agent Client Protocol (ACP)**. **Goose** (Block's agent framework,
  ~50k stars) is one of three native harnesses.

Start here, then go deeper — primary sources first:
- https://block.xyz/inside/introducing-buzz-where-humans-and-agents-work-together
- The Buzz GitHub repo(s) and any docs/spec for ACP — **the repo is the highest-value source**;
  press coverage will not tell us how dispatch, delivery, or permissions actually work.
- https://techcrunch.com/2026/07/21/jack-dorsey-is-taking-on-slack-with-buzz-a-group-chat-platform-for-teams-and-their-ai-agents/
- https://www.devtoolsdaily.com/blog/a-week-with-buzz-coding-agents/ — a hands-on week-long
  account; likely the best source on what it's actually like to USE, including what's annoying.

## Why I care — the overlap is specific

Operator already has a **project channel** (`src/renderer/components/session/ProjectChannel.tsx`)
where lanes post and dispatch to each other, with delivery states (`POSTED` / `DELIVERED` /
`N QUEUED`) and a global agent↔agent pause. Buzz is a much larger swing at the same idea. I want
to know what they got right that we haven't thought of.

**Answer these, concretely, with evidence:**

1. **Agent identity.** How is an agent represented in a channel — same entity as a human member,
   or a distinct kind? What does its cryptographic identity actually buy the user day to day?
   We currently have lanes with an accent colour and initials, and nothing more.
2. **Addressing and dispatch.** How does a human give an agent work? How does an agent hand work
   to another agent? Is there an explicit dispatch primitive or is it just @-mention in prose?
   **This is our sharpest open question** — our dispatch is a sentinel line
   (`OPERATOR-DISPATCH [lane] task`) parsed out of a transcript, which is fragile (we have live
   bugs where long dispatches split mid-line).
3. **Delivery semantics.** Does Buzz distinguish "posted to the room" from "delivered into an
   agent's context"? How does a user know a message actually reached an agent? Does anything
   queue, and is the queue visible? We have exactly this distinction and it currently reads as
   three near-identical grey chips.
4. **Runaway control.** Two agents that can each answer the other ping-pong forever. Operator
   ships agent↔agent delivery **paused by default** for this reason. What does Buzz do — rate
   limits, turn-taking, human-in-the-loop, permissions, nothing? Real answer, not a guess.
5. **Reading a busy channel.** How do they keep a feed readable when agents emit long output?
   Threads? Collapsing? Summaries? Separate surfaces for chatter vs work product? **We have an
   open design task on exactly this** (`dev/briefs/channel-view-improvement.md`) — anything you
   find here can change that design, so be specific and fast on this one.
6. **Work product vs conversation.** When an agent produces a diff/file/report, where does it
   go — inline in chat, a linked artifact, a PR? We force every lane to write a result FILE
   because a chat answer is invisible to other lanes. Does Buzz solve that better?
7. **ACP.** What is the Agent Client Protocol, who else implements it, and is it a real
   cross-vendor standard or Block's house protocol? Would a Claude Code-hosting app like ours be
   able to speak it at all?
8. **What's bad about it.** Pre-1.0, and TechCrunch says don't port your team yet. What
   specifically doesn't work? The failure modes of a shipped competitor are worth more to us than
   its feature list.

## The constraint you must respect when recommending

Operator's north star: **a harness *orchestrator*** that hosts Claude Code's own CLI and reads its
transcript. Explicitly **not** a general agent gateway, and **multi-provider is deferred**.

So: Buzz's *architecture* (Nostr relay, ACP, multi-harness, self-hosted, Git hosting) is largely
**not** adoptable without abandoning that. Its *interaction design* (identity, addressing,
delivery, runaway control, feed readability) may be very adoptable. **Sort your recommendations
into those two buckets and be honest about which is which.** I would rather have three things we
can ship next week than a manifesto.

Flag anything that suggests the north star itself is wrong — that's a real possible finding, not
a forbidden one — but label it clearly as a strategy question for the user, not a task.

## Output

Write **`dev/research-buzz.md`**:

- **What Buzz is** — corrected and sourced. Link primary sources. Note anything I got wrong above.
- **Answers to the 8 questions**, each with a source link and a confidence marker
  (verified in repo/docs · reported by press · inferred). Do not blur those.
- **Adoptable now** — concrete, small, mapped to our files where you can. Rank by value/effort.
- **Not adoptable** — and the north-star reason why.
- **Open questions** you could not resolve.

Do not edit any file other than `dev/research-buzz.md`. Do not touch `ProjectChannel.tsx`.
