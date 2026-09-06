# Result — Review fixes on `operator/e78fc0` (Code lane), 2026-09-06

Brief: `dev/briefs/fix-review-simplify-batch.md`. Review: `dev/results/review-simplify-batch.md`.
Branch: `operator/e78fc0`, rebased onto `6d5cd76`.

## Gates

| Gate | Result |
|---|---|
| `npm test` (renderer) | **1052 pass / 0 fail** |
| `cd electron && npm test` | **498 pass / 0 fail** |
| `cargo test` | **190 pass / 0 fail**, 3 ignored |
| root `tsc` + `npm run build` | clean |
| electron `typecheck` + `build` | clean |
| `cargo build` | clean, zero warnings |

Cargo ran, which the Review could not.

---

## Finding → change → test

### 1 (HIGH) — `sharedHolderIsOurs` proved the wrong thing

The review is exactly right: `claimantsByPort` indexes every process carrying
`OPERATOR_DEV_PORT`, that variable is set on the pty so the whole subtree inherits it, and
`ownDeepPids` removes only the shell and its direct children. The predicate reduced to *"does the
sibling have any grandchild"* and never inspected the port.

**Change.** `provesOwnServer` in `port-alloc.ts` — pure, and it fails closed. A bound port is
shared only on two facts a grandchild cannot fake: a process in the sibling's subtree at depth ≥ 2
whose command is not the mcp helper, not `claude` and not a bare shell; **and** a lease naming that
lane and that port. Neither alone is enough — (1) without (2) is the old bug with extra steps,
(2) without (1) is a reservation with nothing behind it. `reservationHolders > 1` returns false,
matching how `attributePort` treats a shared reservation as ambiguous. The call site now reuses
`evidenceSnapshot`'s 3s cache instead of a fresh `ps -E` pair per launch (finding 10).

**The hint no longer over-claims.** A fresh port says "verified free at launch", which is a fact.
A shared one says "another session in this same directory shares this reservation and may already
be serving the same code on it" — because "provably serving a moment ago" is not "free at this
instant", and the old wording asserted a verification the shared path had not done.

**Tests** (9, fixture `ps` tables, not stubs): false for a lane whose only deep processes are the
mcp helper and `claude`; **false for the review's exact scenario** — a lane mid-build with
grandchildren; true for a real dev server with a lease; false without the lease; false with two
holders; false with no pty; ignores a server at depth 1 (that position is `claude`); finds one
nested deeper; terminates on a cyclic table.

### 2 (HIGH) — the restore path never resolved `remoteControl`

**Change.** The cause was two callers with a copy each, so the fix is one function:
`remoteControlLaunch(project, roleId)` in `model-config.ts`, called by both the launch path and
`handleRestoreSession`. A restore is the ordinary way a coordinator comes back, so the bug hit
precisely the case the feature exists for.

**Tests** (5): on for the coordinator with the project-qualified name; off for every other role;
an explicit off-pin on the coordinator is honoured; an explicit on-pin elsewhere is honoured; off
for a missing role or project — never a guess. `buildArgs` already covers the name reaching argv.

### 3 (HIGH) — `compacting` could wedge forever

**Change.** Both tailers now clear on any **real** main-thread record after the boundary — a user
prompt as well as an assistant record — with the re-prime excluded, since
`type:"user", isCompactSummary:true` is part of the compaction rather than the end of it (verified
in a real transcript, followed by `attachment` records). Plus a **5-minute ceiling**: the longest
`durationMs` measured in a real transcript is 134s, so a lane still claiming to compact past five
minutes is one whose closing record never arrived. The ceiling drops the *claim*, not the flag.

**Tests** (Rust 2 + Electron 2): a real user prompt ends it; the claim expires past the ceiling;
the re-prime does **not** end it (the existing test was updated to the real record shape, which is
what surfaced the distinction); `/compact` at turn end — boundary then nothing — no longer wedges.

### 4 (HIGH) — the 10-minute sweep was far too broad

**Change.** It now reaps only the intersection of the boot sweep's three gates: a **lease** naming
that terminal id *and* port; the port **still bound**; and the command **matching
`DEV_SERVER_RE`**. Anything Operator- or Electron-shaped is refused outright regardless of tags.
Everything else that is tagged-but-abandoned is left alone and surfaces in the Dev servers list as
`abandoned-lane` for a person to confirm, with a log line saying how many were left.

**The doc comment's force-quit claim is gone**, because it was false: a force-quit kills the timer
with the process. The case it actually covers is a close that raced or threw while this app kept
running; a previous run's leftovers are the boot sweep's job.

**Tests** (4): Operator/Helper/Electron binaries are refused; a real dev server is not; the
dev-server shapes this app's projects run are recognised; a build or stray script is not.

---

### 5 (MEDIUM-HIGH) — chip writes bypassed `submitQueue`

**Change.** New `submitQueue.submitTyped(id, text)` — a typed line in the **same per-terminal
chain** as a paste, with no nudge and no rescue (those exist for long pastes, and a rescue CR
fired after a slash command would be a bare Return into whatever the lane shows next). Both chips
route through it. They are **enabled only at `phase === 'idle'`** and otherwise disabled with the
title *"Wait for the lane to finish its turn"* — mid-turn the line becomes a queued message, or
the bare CR answers a permission prompt the user has not read. The value persists **after** the
write is issued, not before.

**Tests** (3): writes a typed line and never the bracketed sequence; serializes behind a paste on
the same terminal, with the paste written whole; does not serialize across different terminals.

### 6 (MEDIUM) — the custom-model field committed on blur

**Change.** Enter commits, blur discards, Escape closes. `/model son` is a command the lane acts
on, and blur fired on every way of leaving the field.

### 7 (MEDIUM) — chips could not close their own menus

**Change.** `data-popmenu-trigger` and `aria-expanded` on both, plus `aria-haspopup`. Verified
these are the exact hooks `use-dismiss` reads — it treats a pointer-down on `[data-popmenu-trigger]`
as not-outside and restores focus to `[data-popmenu-trigger][aria-expanded="true"]`.

### 8 (MEDIUM) — "Dev servers" listed everything a lane started

**Change.** A `live-lane` row must match `DEV_SERVER_RE`; `abandoned-lane` and `dead-app` keep the
relaxed match. The asymmetry is about consequence: for an open lane the relaxed match put a kill
button beside every `tsc --watch` and test runner under a heading saying "dev servers", while for a
row whose lane is gone the relaxed match is the point — t14's measured leak was `node server.mjs`,
which matches no pattern.

**Tests** (3): a live lane's `tsc --watch` is hidden and its `vite` is not; an abandoned
`server.mjs` is still listed; a dead app's is too.

### 9 (MEDIUM) — a persisted `mainView` of `'chat'`/`'files'` blanked the pane

**Change.** `loadLayouts` coerces unknown `mainView`/`panelTab`/`panelOpen` to the defaults. The
blank was unrecoverable in the UI, because the toolbar segment that would reset it is only
reachable when a view is showing.

### 11 (LOW-MEDIUM) — a failed `::1` bind silently cost every lane its port

**Change.** `isPortFree` still requires both loopbacks — that is the orphan case it exists for —
but now counts consecutive v6 failures. When a **whole scan** comes back empty, `retryScanWithoutV6`
distinguishes "one orphan holds `[::1]`" from "this host has no IPv6 at all", logs the reason once
under `[ports]`, and re-probes on v4 alone. A single port cannot tell those apart; a hundred
consecutive refusals can.

### 16 (NIT) — the `launch-args` comment contradicted the code

**Change.** Rewritten to say what is actually true: the flag *is* last before the positional
prompt, and that is safe because a name is always supplied — the `rcName` guard is what protects
it, not the position.

---

## Deferred, as the brief directs

- **12** — `devServerKill` cross-check.
- **13** — the `\b<port>\b` command match in `reportStillBound`.
- **14** — `chat.db` write-only; a purge policy is its own brief.
- **15** — cosmetics.

## Not done

- Nothing merged. The Tuning page resumes next.
- No GUI verification. Every fix here is covered by tests, but the disabled-chip state and the
  menu-dismissal hooks are visual behaviours nothing rendered.
