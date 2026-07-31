# Brief — lane replies show a raw session UUID as the author

User screenshot of the running build: replies in the channel are authored by
`90756a9b-c401-4a90-84ce-a531b9a2010b` (Design's session) and
`6c78d88f-a4bf-4f32-b5af-c6af497fcd2a` (Code's session), with generic `9C` / `6A` initials and no
lane accent. Operator's own dispatches resolve correctly — name, purple, `OP`.

**In a channel whose entire job is who-said-what, the author axis is broken for every lane reply.**

## Where it is

`src/renderer/lib/project-channel.ts:208`, in the reply branch of `buildChannelFeed`:

```ts
authorLabel: from?.name ?? session?.roleId ?? r.sessionId,
```

Compare the dispatch branches (`:175`, `:192`), which resolve off `d.fromRoleId` and work:

```ts
authorLabel: d.fromHuman ? 'You' : (from?.name ?? d.fromRoleId ?? 'unknown lane'),
```

So for a reply, **both** `from` (the resolved Role) **and** `session?.roleId` are coming back
empty, and it falls through to the raw id. The comment above it — *"Session gone → its id,
verbatim. A blank author would read as 'nobody said this'"* — is a reasonable last resort that has
become the normal case.

## Find the real cause before changing the fallback

**Do not just prettify the fallback.** A UUID shortened to `90756a9b` is still not an author. Work
out why the lookup misses. Starting hypotheses, in the order I'd test them — confirm or kill each:

1. **The reply's session isn't in the list passed to `buildChannelFeed`.** The lanes that posted
   these replies run in *worktrees* (`~/.operator/worktrees/operator-c48bd8`,
   `…-1cf818`) with their own cwd. If the feed is built from sessions scoped to the project and a
   worktree lane's session carries a different `projectId` (or none), it will never be found.
   Check what `projectId` those sessions actually carry in `~/.operator/sessions.json`.
2. **The session is found but has no `roleId`.** Then the second fallback is empty too, and the
   fix is upstream — whatever writes the reply, or whatever stamps `roleId` on a session.
3. **`r.sessionId` doesn't match the key the session list is indexed by** — e.g. Claude session
   uuid vs Operator's own session id vs terminal id. These are three different identifiers in this
   codebase and they have been confused before.

Read the durable state to decide, not the UI: `~/.operator/sessions.json` and the replies in
`~/.operator/chat.db`. **The UI is what's lying here.**

## Then fix it properly

- A reply must resolve to its lane's **name and accent**, same as a dispatch — the avatar tint,
  the initials and the coloured name all key off `authorRole`, and all three are currently wrong.
- Keep a genuine last-resort fallback for a session that really is gone, but make it read as
  *unknown* rather than as an identifier — the dispatch branch's `'unknown lane'` is the existing
  precedent. A hash is never a name.
- Check `isContinuation` (`:263`) while you're there: it compares `prev.authorLabel !== entry.authorLabel`.
  With UUID labels every reply is its own author, so grouping silently can't work either — and it
  will start working once labels resolve, which is a behaviour change worth seeing on purpose
  rather than by surprise.

## Verify

- `npm test` — add a case where a reply's session is missing from the list, and one where it's
  present with a `roleId`. Assert the label is never an id-shaped string.
- **Acceptance is the running app**: open the `operator` channel and confirm Design's and Code's
  replies show their names in their lane colours. That is the whole bug; a green test that doesn't
  reproduce it proves nothing.
- Say in your result what the actual root cause was — I want it recorded, because the three-way id
  confusion in (3) has cost this project before.

## Where to work

`main` is at `8b40454`. Commit in your own worktree; I'll merge forward. Do not edit
`/tmp/claude-501/merge-main`.

## Output

`dev/briefs/channel-author-uuid-RESULT.md`: the root cause, the fix, what the fallback now says,
and the grouping consequence. Then one OPERATOR-REPLY line.
