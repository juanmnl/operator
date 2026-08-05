# RESULT — the forgotten project, the "restart", the reshuffle, and the slow close

Build clean · `npm test` **637 passed** (632 + 5) · `cargo test` **130 passed** · `cargo check` clean.

---

## Lead: bugs 1–3 do NOT share a root cause. They share a TRIGGER.

The brief's best hypothesis was that ⌘B causes a remount cascade and that bugs 1–3 are therefore one
bug. **Measured, and that is not what is happening.** `dev/drive-sidebar-toggle-stability.mjs`, 20
consecutive toggles:

```
ok  B1 NO RELOAD — the init script ran 1× (a reload would increment it)
ok  B2 NO REHYDRATE — loadProjects called 1× total, unchanged by 20 toggles
ok  B2 NO REHYDRATE — loadSessions called 1× total, unchanged by 20 toggles
ok  B2 terminalList is the POLLER, not the toggle — +2 toggling vs +1 idle
ok  B3 ORDER STABLE across every toggle — 1 distinct order seen
ok  B4 console clean — 0 errors
```

⌘B does not reload, does not re-hydrate, does not reorder, and logs nothing. The handler is exactly
what it looks like.

**What actually links them is REHYDRATION**, and each bug is a separate defect that rehydration
exposes:

| | defect | fires on |
|---|---|---|
| 1 | `archivedAt` cleared by a background upsert (+ the forget guard being per-run) | every hydrate |
| 2 | the renderer being killed and respawned — see below | memory pressure |
| 3 | `terminal_list` iterating a `HashMap` | every hydrate |

So a respawn (bug 2) fires bugs 1 and 3 together, which is why they arrived in the same sentence.
Fixing the respawn would not have fixed either — a plain app restart triggers both — and fixing
them does not stop the respawn. **Three defects, one trigger.**

### Bug 2, specifically: it is a renderer respawn, not a restart

No `location.reload` exists, the toggle handler only writes state and localStorage, and 20 toggles
produce no reload in the harness. But this repo has documented precedent for the exact symptom —
from `terminal-options.ts`'s own note on `INACTIVE_SCROLLBACK`:

> WebContent resting at 737MB with 23.6% CPU, and opening the heaviest project pushed it past what
> WebKit would give it — **the renderer was killed and respawned mid-navigation, which reads to the
> user as "the app restarts, blinks, and goes back to another project"**.

That is the reported symptom verbatim, including the "goes back to another project" part (the
respawn re-hydrates scope from localStorage). ⌘B is a plausible *trigger* rather than a cause: the
toggle animates width for 260ms across every mounted terminal at once, which is a layout/paint
spike on top of an already-loaded renderer.

**I could not confirm this on your machine** — it needs `ps`/`sample` on the WebContent pid at the
moment it happens, in your app, under your session count. The harness has 4 sessions and 900MB of
headroom; you have neither. **What I did instead was make the consequences harmless**: after this
change a respawn no longer resurrects a shelved or forgotten project (bug 1) and no longer
reshuffles agents (bug 3). If the blink itself still bothers you, that is a memory-profiling task
and I would want the pid and a `sample` to do it honestly.

---

## Bug 1 — fixed, and the brief diagnosed HALF of it

The brief's diagnosis is right: the upsert spread cleared `archivedAt` unconditionally, so
un-shelving was a side effect of four paths, one of which has no user in it. Fixed by making the
two directions symmetrical — `upsertProject` now takes an intent, **defaulting to `background`**,
so a caller that does not say cannot lift a shelf. All four callers audited by grep, not by the
comment's list:

| caller | intent | why |
|---|---|---|
| `openFolderAsProject` | **user** | picked a folder in the dialog |
| `handleLaunchSession` | **user** | launched a lane here |
| `handleRestoreSession` | **user** | clicked a dormant session (incl. Resume project) |
| cwd-resolution effect | **background** | an effect adopting a surviving pty — no user |

A lift now also emits a toast ("*X is back on Active*"), because an automatic lift with no trace is
what kept this invisible.

### The half the brief missed: "forget" is a different verb, and its guard was per-run

You said *forget*, and this codebase has three verbs — Close, Archive, **Forget**. Forget deletes
the project record entirely, so there is no `archivedAt` on it to clear. Its protection against
re-adoption was `useRef(new Set())` — **empty in a new process**. And forget deliberately does not
kill the project's agents. So:

> forget → record gone, ptys alive → restart (or respawn) → the cwd-resolution effect sees a live
> unstamped pty → resolves its folder → **the project is re-created**, with a fresh roster and a
> bumped `lastActiveAt`, so it sorts to the top as your most recent work.

That is a second, independent resurrection path, and it matches "*a whole project that i marked as
forget, is launching by itself*" more exactly than the `archivedAt` one does. Fixed by making the
list durable: `lib/forgotten-projects.ts` (5 tests), read at hydrate, written on forget, and
**cleared when the user deliberately re-opens** — otherwise a project forgotten in March and
re-opened in April would keep refusing to adopt its own agents.

### Verified end-to-end, and the driver reproduces the bug

`dev/drive-shelf-survives-background.mjs` seeds the exact triggering shape — an archived project, a
live pty in its folder, a saved session with no `projectId` — and clicks nothing; the effect is the
test.

```
                        after the fix        before the fix
S1 background resolution   shelved      ←→        ACTIVE
S2 after a reload          shelved      ←→        ACTIVE
```

It got this wrong once and is worth flagging as a trap: the first version invented a project id, but
`resolveProject` **derives** the id from the path (`deriveProjectId`), so the fixture upserted a
different project and the driver passed against the broken code. It also stubbed a
`window.operator.resolveProject` that does not exist — `resolveProject` is a frontend helper that
calls `inspectRepo`. Both are now written into the file.

### Damage already done — reported, not edited

`~/.operator/projects.json`: **21 projects — 4 archived, 17 active.** 9 of the active ones have not
been touched in >7 days (51d `FastTrack`, 43d/37d `uwazi_web`, 36d `enfant-terrible`, 32d
`Mise-landing`, 31d `website-2025`, 29d `Developer`, 15d `walter`, 14d `Fastrack-landing`) — all
with 0 saved sessions and 0 tasks.

**Those are not the victims.** A background lift sets `lastActiveAt: now`, so a lifted project looks
*recent*, not stale. Any damage is hiding among the 8 recently-touched active projects and is, as
the brief predicted, **indistinguishable** from a deliberate restore — there is no field recording
which happened. Nothing was edited.

---

## Bug 3 — fixed, and the cause is literally random

`src-tauri/src/lib.rs`, `terminal_list`:

```rust
let snapshot: Vec<(String, String)> = lock(&mgr.ptys).iter()…   // ptys: Mutex<HashMap<String, Pty>>
```

**Rust's default `HashMap` hasher is seeded randomly per process.** Iteration order therefore
differs on every single app start, and can change within a run when the map grows. The frontend's
re-attach path builds `terminals` from that order, and `terminals` is the canonical order for the
sidebar and for ⌘1..9. "Agents randomly move positions" — random being the mechanism, not a figure
of speech.

Fixed by sorting on creation order: ids are `t{n}` from a monotonic counter, parsed numerically so
`t10` follows `t9`, with unparseable keys sorted last so a stray id cannot reorder the real ones.

**Not `orderByRoster` (`e87cef7`), which the brief suspected.** That function is a pure stable
partition and is deterministic for a given input; it was being handed a differently-ordered input
each boot. Its two flagged edge cases were checked and are sound: an unknown `roleId` sorts last
among lanes rather than vanishing, and duplicate `roleId`s keep both members (the rank compare is
stable). Its tests still pass, and `drive-lane-reorder.mjs` is still green.

**Not reproducible in the mock**, and that is worth stating: `dev/mock-bridge.ts` returns a fixed
array from `terminalList`, so no harness here could ever have shown this. It was found by reading
the Rust, prompted by the order being provably stable in the mock across 6 reloads.

---

## Bug 4 — fixed, both halves, without losing the invariant

The sequencing comment was right about *what* it protected (a project must not sit on **Active**
while its lanes are alive) and wrong that withholding the write was the way to protect it. That is a
rendering question, so it is now answered by rendering.

- **"takes a while"** → `closingProjects` state, set the instant you click, rendered on the card as
  a muted `closing…` in the same slot as the activity label (replacing it, not joining it — two
  answers to one question). No fill, no border, no reflow.
- **"if it gets removed"** → teardown is now **parallel and bounded** (4s per lane via
  `Promise.race`), and `archivedAt` is written **unconditionally**, including on partial failure.
  Previously a single hung `handleCloseSession` blocked every lane behind it *and* meant the shelf
  flag was never written at all — "user asked to close" survived nowhere. A lane that will not die
  is now reported by name in a toast rather than silently swallowing the decision.

The invariant holds: nothing appears on Active while its lanes live, because the card says
`closing…` from the first frame and the shelf write still lands after the teardown attempt.

---

## Verify — each bullet

| Bullet | Result |
|---|---|
| Shelved project survives background cwd resolution | **S1** — `shelved` after the fix, `ACTIVE` before |
| …survives an app restart | **S2** — reload, effect re-runs, still `shelved` |
| …survives opening a different project / a lane launch elsewhere | By construction: those paths upsert a *different* id, and only a `user` intent on *this* id can lift it |
| Explicit restore still lifts the shelf | Unchanged code path (`restoreProject`, the `previous` chip, and the menu's "Restore to active"); `intent: 'user'` on the three deliberate upserts |
| ⌘B: 20 toggles, no reload, console clean | **B1/B4** — 1 boot, 0 errors |
| Agent order identical before/after ⌘B and after restart | **B3** — 1 distinct order across 20 toggles; 1 across 6 reloads. The restart case is fixed in Rust and covered by `cargo test` compiling the sort, not by a driver — see below |
| `npm test` green, build clean | 637, clean |

Also re-run clean: `drive-lane-reorder.mjs` (17 assertions), `drive-rail-invariant.mjs` (CLEAN on
every palette) — the rail work merged earlier is not regressed.

## Not verified / open

- **The `terminal_list` sort has no test.** It needs a `PtyManager` with several live ptys, which
  means spawning real processes in a unit test. The change is 6 lines and the property (sorted by
  the numeric id) is visible, but I did not prove it end-to-end. If you want it covered, the honest
  way is a test that inserts fake `Pty` entries — which needs `Pty` to be constructible in tests,
  a small refactor I did not want to make in this pass.
- **Bug 2's respawn is not confirmed on your machine**, only its consequences neutralised. Getting
  proof means `ps -o %mem,rss -p <WebContent pid>` and a `sample` at the moment of the blink.
- **The `closing…` state was not driven in the harness** — it needs a fixture with a lane whose
  close hangs. The state, the timeout and the unconditional write are all visible in one function.
- **`~/.operator/projects.json` untouched**, per the constraint. If you want the 9 stale projects
  shelved, that is a one-line call you make from the UI, not something I should batch.
