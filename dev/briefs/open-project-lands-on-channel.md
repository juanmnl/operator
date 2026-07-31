# Brief — opening a project lands on the channel, or on the agent when there's only one

User: **"selecting an active project should land me on the channel, unless there's only one agent,
then on the agent."**

## Today

`handleOpenProject` (`DashboardView.tsx:581`) does the opposite:

```ts
setChannelActive(false)              // "entering a project lands on its home, not on whatever was open"
setActiveProjectId(...)              // and, on a project CHANGE:
if (prev !== projectId) setProjectTab('roster')
setActiveSessionId(null); setActiveTerminalId(null)
```

Every project opens on the roster board. **The comment on line 582 documents the behaviour being
replaced — update it, don't leave it contradicting the code.**

## The rule

| roster | lands on |
|---|---|
| **2 or more lanes** | the **channel** |
| **exactly 1 lane** | **that agent** |
| **0 lanes** | the roster board — it's the only place to add one |

"One agent" means **one lane on the roster**, not one *live* session. After the prune most projects
have exactly one (Operator), which is precisely the case the user is hitting: landing them on a
channel that is empty or nearly so, when there is exactly one thing they could be doing.

## The part that needs a decision — make it and say so

**What "lands on the agent" means when that lane isn't running.** A live lane has a session to
focus; an idle one does not.

My lean, argue if you disagree: land wherever makes **launching it the obvious next action** —
its card, focused, with the Launch affordance in view — rather than opening an empty terminal
surface or bouncing to a generic home. For a live lane, focus its session directly.

Do **not** auto-launch. Landing somewhere is navigation; starting an agent is a decision, and it
costs a process, a worktree and a dev port.

## Edge cases to get right

- **Re-selecting the project you're already in** must not yank you off whatever you're looking at.
  The current code only resets `projectTab` when `prev !== projectId` — preserve that instinct:
  this rule is for *entering* a project, not for every call.
- **Returning to a project you've been in before**: does it restore where you were, or re-apply
  the rule? Pick one and say which. My lean is re-apply — it's predictable, and "where you were"
  is already a whole other feature.
- A single lane that is **live** vs **idle** — both count as one agent; only the landing target
  differs.
- The gallery, the rail tile, and `⌘⇧O` → project all funnel through here. Check every caller of
  `handleOpenProject` gets the new behaviour, and that none of them relied on landing on `roster`.

## Constraints

- Don't break the scope rules: `activeProjectId` is the durable scope, "focus implies scope" is
  enforced in handlers *and* by a backstop effect. Landing on a session must not desync scope.
- Don't auto-launch anything.
- The channel marks itself read when viewed (`onMarkRead`). Landing there by default now means
  entering a project silently clears its unread count — **check that's acceptable**, and say so.
  If a project's unread badge is how the user notices activity, defaulting into the channel makes
  that badge unreachable, which would be a real regression introduced by this change.

## Verify

- `npm test` — cover the three roster sizes, plus re-selecting the current project.
- Drive it: gallery → project with several lanes lands on the channel; a one-lane project lands on
  that lane; a zero-lane project lands on the roster.
- `npm run build` clean.

## Where to work

`main` is at `65175d1`. Commit in your own worktree; I'll merge forward. Do not touch
`/tmp/claude-501/merge-main`.

## Output

`dev/briefs/open-project-lands-on-channel-RESULT.md`: the rule as implemented, what "lands on the
agent" resolves to in both live and idle cases, the re-entry decision, every caller you checked,
and your answer on the unread-badge question. Then one OPERATOR-REPLY line.
