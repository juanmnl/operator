# Injected turns still render for existing history — renderer guard was removed

**Measured just now:** `~/.operator/chat.db` holds **188 injected rows across 32 sessions**
(`text LIKE '<local-command-%' OR '<command-name>%' OR '<system-reminder>%'`).

The fix for `dev/briefs/chat-injected-turns.md` landed in `transcript.rs:285` (`let injected =
is_injected_turn(&text)`), which correctly stops **new** junk reaching `chat.db`. But the
renderer-side guard was **removed** — `CanvasConversation` no longer calls `isInjectedTurn` at all.

That brief said explicitly:

> Prefer fixing it in `transcript.rs` so the junk never reaches `chat.db` — note the existing
> entries are already persisted, **so the renderer needs the guard too for history already on disk**.

`chatHistory` loads from `chat.db`, so those 32 sessions still render exactly the screenshot the
user reported. Open any session from before today and the caveat/command turns are still there,
still labelled **YOU**.

## Fix

1. **Restore the renderer guard.** `isInjectedTurn` still exists in `lib/format.ts` and is still
   unit-tested. This is the durable defence, not a workaround: history on disk can always predate a
   parser change, so the reading surface should never trust its input to have been filtered
   upstream. Keep both guards.
2. **Consider a one-time cleanup** of the 188 existing rows. Optional if (1) lands — the guard makes
   them invisible — but it would shrink a DB that is already ~5.8MB with a 4.1MB WAL. If you do it,
   it is a migration with a backup, not an ad-hoc `DELETE`.
3. Add a test that a persisted injected row does not render. The existing tests cover
   `isInjectedTurn` as a *function*; nothing asserts the transcript actually filters.

## Why this slipped

The Rust fix is the more correct one and it verifies cleanly against fresh sessions — the harness and
any new session both look right. The failure only shows on **pre-existing history**, which no test
and no fixture covers. Worth a general note: when a fix moves upstream of a persistence boundary,
the data already past that boundary is a separate case, and usually the one the user is looking at.
