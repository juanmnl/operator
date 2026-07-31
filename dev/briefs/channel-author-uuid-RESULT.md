# Lane replies show a raw session UUID as the author — RESULT

**Status: fixed. `tsc` clean · `npm run build` clean · 537 tests (531 → 537).**

## Root cause — hypothesis 3, plus a structural one underneath it

**Hypotheses 1 and 2 are both dead.** I read the durable state first, as the brief said:

```
chat.db  reply.session_id = 6c78d88f-a4bf-4f32-b5af-c6af497fcd2a   project_id = operator-3cfdffb0
                            90756a9b-c401-4a90-84ce-a531b9a2010b   project_id = operator-3cfdffb0

sessions.json
  claudeSessionId 6c78d88f-…  roleId "code"    projectId operator-3cfdffb0  cwd …/worktrees/operator-c48bd8
  claudeSessionId 90756a9b-…  roleId "design"  projectId operator-3cfdffb0  cwd …/worktrees/operator-1cf818
```

The worktree lanes carry the **correct `projectId`** (1 ✗) and they **do have a `roleId`** (2 ✗).
The mapping the UI needed was sitting in `sessions.json` the whole time.

**The actual cause is (3), the id confusion — and it is worse than a mismatch.** The caller passed:

```ts
sessions={allSidebarSessions.map((x) => ({ id: x.id, roleId: x.roleId }))}
```

`allSidebarSessions` is derived from `terminals` — **the live ptys of the current Operator run**.
So two things were wrong at once:

1. **Wrong key.** A tracked session's `id` is the Claude session uuid, but an *untracked* one is
   `local-<terminalId>`. A reply speaks the Claude id, so those never match.
2. **Wrong list, and this is the real bug.** The channel renders **history**. A reply from a lane
   that has since ended — which is most of the feed — could never be found in a list of what
   happens to be running now. The lookup was structurally incapable of succeeding for exactly the
   rows the user was looking at.

The comment above the fallback was honest about being a last resort. It had quietly become the
only resort.

## The fix

**Search a durable list, keyed by the id a reply actually carries.**

```ts
const channelSessions = useMemo(() => [
  ...allSidebarSessions.map((x) => ({ id: x.id, roleId: x.roleId })),   // live: freshest roleId
  ...savedSessions.filter((s) => s.claudeSessionId)
    .map((s) => ({ id: s.claudeSessionId as string, roleId: s.roleId })), // durable: survives the run
], [allSidebarSessions, savedSessions])
```

Live first so a running lane's current `roleId` wins; the saved store behind it so history
resolves. Both the feed and the unread badge read the same list — they were already two call
sites of the same expression, and now they cannot drift.

`ChannelSession`'s doc now states the contract that was implicit and therefore breakable: **keyed
by the Claude session id, and durable, not live** — naming all three identifiers (Claude uuid,
saved-session `key`, per-run terminal id) because that confusion is what caused this.

## What the fallback says now

`'unknown lane'` — the dispatch branch's existing precedent, never an id.

A uuid is *worse* than a blank: it looks like data, so it reads as the answer rather than as the
lookup having failed. Shortening it to `90756a9b` would have been the same lie in fewer
characters, which is why the test asserts by **shape** (`not.toMatch(/[0-9a-f]{8}/i)`) rather than
against one string — a future "prettified" hash fails it too.

The `roleId` fallback is kept in between: a lane deleted from the roster still shows `deleted-lane`,
which is a name.

## The grouping consequence

`isContinuation` compares `prev.authorLabel !== entry.authorLabel`. With uuid labels **every reply
was its own author**, so consecutive replies from one lane could never group — the feature was
silently dead for replies while working fine for dispatches.

It now works. That is a **visible behaviour change**: consecutive replies from the same lane will
collapse into one attributed block instead of repeating the avatar and name. Called out here rather
than discovered, per the brief; there is a test pinning that two consecutive replies from one
session both resolve to `Code`.

## Verify

- `npm test` — **537 passed** (+6 in `project-channel.test.ts`): resolves name *and accent*;
  resolves from the durable store when the lane is absent from the live run; never returns an
  id-shaped string; falls back to `roleId` before giving up; **does not** match on the saved `key`
  or the terminal id; and consecutive replies group.
- **One pre-existing test was rewritten, not deleted** — `prints the raw id when a reply session no
  longer resolves` asserted exactly the behaviour this brief removes. It now asserts `'unknown
  lane'`, with a comment saying what changed and that "never blank" still holds.
- `npm run build` clean.
- **Acceptance, in the running app** (`node dev/drive-channel-author.mjs`, new `?author=1` fixture
  seeding the two Claude session ids **verbatim from chat.db**, from lanes deliberately absent from
  the live run so only the durable store can name them):

```
   DE   Design           color(srgb 1 0.478431 0.776471)      ← Design's pink
   CO   Code             color(srgb 0.494118 0.905882 0.52…)  ← Code's green

no author is a uuid           : true
no author is an id fragment   : true
the two ENDED lanes are named : true
…in their own lane colours    : true
initials are the lane's       : true   (DE / CO, not 9C / 6A)
```

Screenshot: `/tmp/operator-shots/channel-author.png`. All three broken axes — name, initials,
accent — resolve together, because all three key off `authorRole`.

## Worth knowing

`savedSessions` is **pruned** over time (`lib/session-prune`). A reply old enough for its saved
session to have been dropped will still fall through — but now to `unknown lane` rather than to a
uuid, which is the honest answer. If attribution needs to survive that too, the durable fix is to
stamp `roleId` onto the reply row in `chat.db` at write time, so the reply carries its own author
instead of joining against another table. That is a schema change and a bigger call than this
brief; flagging it rather than doing it.
