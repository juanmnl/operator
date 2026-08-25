# Preview: whose server is that, and how do I reach a subpage

**Branch:** `operator/a30080` · commit `d27261c` · 2026-08-24 · Code lane

**On the design doc:** `dev/results/preview-address-bar-design.md` does not exist yet (checked
`operator/311c00` and every worktree). Per the brief, this is the backend plus a minimal
path-capable address box; the UI polish is a follow-up and nothing here forecloses it.

---

## Bug 1 — the wrong server

`sessionPorts` added the reserved port to its result whenever *anything* was listening on it, and
`preview-port.ts` carried a comment stating the opposite:

> the backend attributes them from the session's own candidate set … so every port here belongs to
> THIS session.

It did not. A lane reserves 1422, its dev server dies, a stale orphan or a sibling lane binds
1422, and the preview shows that server as this lane's app. This is not hypothetical: the worktree
reaper's `ps -E` sweep found **~60 tagged strays live on this machine**, several of them holding
ports in the 1420–1431 range. "Something answers on our port" is evidence of very little.

### What `sessionPorts` returns now

`{ port, attributed: 'sniffed' | 'reserved' | 'foreign' }`, sorted by port.

| | Meaning | Confidence |
|---|---|---|
| `sniffed` | The port came out of **this pty's own bytes**. | **Proof.** Nothing else can write into our pty. |
| `reserved` | Our reservation, **and** a process this lane started claims it, **and** no other lane does. | Strong evidence. |
| `foreign` | Answering, but not attributable to this lane. | Never shown as this lane's app. |

**No `lsof`.** The one call that would answer "which process holds this socket" is the one this
codebase forbids — per-pid `lsof` is a TCC prompt per process and `lsof -i :PORT` is the same thing
in kind. The evidence is the `ps -E` snapshot the reaper already takes, and the module says plainly
that this is inference, not proof.

### Two things the obvious version gets wrong

**1. `OPERATOR_DEV_PORT` is set on the PTY.** The lane's login shell and its `claude` child carry
it *forever* — including long after the dev server died. Matching on the env var alone would
report every reserved port as `reserved` for the life of the lane, which is the original bug with
extra steps. So a claimant has to be **deeper than `claude`**: something the lane actually
started. `ownDeepPids` walks the pty's subtree and drops the shell and its direct children.

**2. A contested port is `foreign`, even when one claimant is ours.** Two processes cannot both
hold a port and the snapshot cannot say which won. "We are not sure" has to lose to nothing —
ordering the contested check *before* the positive one is what enforces it, and it has its own
test.

### The picking rule

`pickPreviewUrl` is rewritten in those terms: **sniffed beats reserved, foreign is never shown**,
lowest port within a tier for stability.

The precise regression, pinned by its own test: when the only listener is foreign, the picker must
**not** fall back to `reservedUrl` — that URL names the exact port the stranger is on, so the
fallback would load the very thing the attribution just rejected. It returns `{url: null, foreign:
true}` and the panel says:

> A server is answering on 1422, but it isn't one this session started — so it isn't being shown.
> If it IS the app you want, pin it.

A pinned port still overrules everything, foreign included — the user may well know that the thing
on 1422 is what they want to look at.

The toolbar's dev-port chip got the same treatment; it was making the same mistake in a smaller
box.

## Bug 2 — no subpages

The target was a bare port, so `/admin` was unreachable, and any path the user had navigated to was
lost the moment the port changed.

The target is now `{port?, path}`. One box, four jobs:

```
5173             → port only
5173/admin       → port + path
/admin           → path only — follows whichever server the lane is on
localhost:5173/x → port + path
https://app.co/x → external, taken whole
```

- **A bare number is a PORT, not a path.** In a browser bar `3000` would be a search; here it is
  unambiguously the thing the box is named for, and reading it as a path breaks the common case.
- **A localhost URL is decomposed** into port + path rather than kept whole, which is what lets a
  later port change carry the path over — the storing-them-apart *is* the feature.
- **Switching servers in the multi-port picker keeps the path.** Pinning a port is not a reason to
  be thrown back to the site root.
- **Storage is unchanged.** The pin is still the string the user typed, under the same
  per-session key; every value ever written there parses correctly under the new parser, so there
  is no migration to get wrong.

## One thing I added that the brief did not ask for

`sessionPorts` is **polled** — the preview panel every 4s, the toolbar chip every 5s, *per
session*. Answering each poll with a fresh `ps -eww -o pid,pgid,command -E` means dumping every
process's entire environment several times a second on a machine with a dozen lanes open. The
evidence pair is cached for 3s, and the **promise** is cached rather than the result so concurrent
pollers share one sweep instead of each starting another. Without this the fix would have been a
performance regression.

## Checks

| | |
|---|---|
| `tsc --noEmit` (root) | **0** |
| `tsc --noEmit -p electron/tsconfig.json` | **0** |
| `vitest run` (electron) | **367 passed, 0 failed** (was 351) |
| `npm test` (root) | **852 passed / 33 failed** — the 33 unchanged |
| `vite build` | green |

40 new or rewritten tests: every attribution branch including the shell-only and contested cases,
`ownDeepPids`' exclusion rule over a `ps` fixture, the cache's TTL, all five address-box forms and
their round-trip, sniffed-over-reserved, foreign-never-picked, the no-fallback-to-reserved
regression, and the path surviving a port change.

## Not verified

Not seen running. The attribution logic is exercised against fabricated `ps` tables, not against a
live collision — reproducing one means starting a server on another lane's reserved port. Worth an
eyeball:

1. A lane whose dev server announces itself: preview should show the **sniffed** port even if
   something else answers on the reserved one.
2. Type `/admin` into the address box with no port pinned; restart the dev server on a different
   port and confirm the path survives.
3. Kill a lane's server, start something else on its reserved port, and confirm the warning
   appears rather than the stranger's app.

## Follow-up

The address bar is deliberately minimal — a wider input, the placeholder `port, /path, or URL`,
and the foreign warning in the empty state. When `preview-address-bar-design.md` lands, the parsing,
the attribution tiers and the path-preserving behaviour are already in `lib/preview-port.ts` for it
to render however it likes.
