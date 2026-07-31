# Opening a project lands on the channel, or on the agent — RESULT

**Status: done. `tsc` clean · `npm run build` clean · 546 tests (537 → 546).**

## The rule as implemented

`landingFor(project, lanes)` — new pure module `lib/project-landing.ts`:

| roster | lands on |
|---|---|
| **2+ lanes** | the **channel** |
| **1 lane, live** | **that session** |
| **1 lane, idle** | the **roster board** |
| **0 lanes** | the **roster board** |

It keys off **roster size**, never on how many lanes happen to be running: "one agent" is a
property of the project. Two lanes with nothing running is still a channel; one lane with two
stray ptys is still one agent. The stale comment on the old line 582 is gone — it described the
behaviour being replaced.

## "Lands on the agent", in both cases

- **Live** → focus its pty directly (`activeTerminalId` + the matching session id).
- **Idle** → the **roster board**, which is your lean and I agree with it. With one lane the board
  *is* its card with the Launch button on it, so no new selection state was needed — landing there
  makes launching the obvious next action without inventing an affordance. The alternative, an
  empty terminal surface, shows you a thing that isn't running and offers nothing to do about it.

**Nothing is auto-launched.** Landing is navigation; starting an agent costs a process, a worktree
and a dev port.

That 0-lane and 1-idle-lane share a destination is a coincidence of it being the right screen for
both — two reasons, one answer — not one rule doing double duty. Said so in the code.

## Re-entry: re-applied, not restored

Your lean, and I took it. Returning to a project puts you where the rule says, not where you last
were. Predictable beats clever, and "restore where I was" is a separate feature with its own
persistence.

The existing instinct is preserved exactly: **opening the project you are already in changes
nothing.** The old code guarded `projectTab` behind `prev !== projectId`; the whole landing
decision now sits behind that same check.

## The thing that would have broken quietly

Two callers were using `handleOpenProject(activeProjectId)` as **"go to project home"** — the
sidebar's project header and the toolbar's `‹ name` chevron. Those are requests to *be* moved, and
once re-selecting the current project became a deliberate no-op they would have become dead
buttons: two intents sharing one function, cancelling each other out.

Split into a separate `handleOpenProjectHome()` that always goes to the board. Both affordances
behave exactly as they do today — verified by `drive-navigation.mjs`, which asserts *"lands on
Project Home"* and *"scope undisturbed"* and still passes.

## Every caller checked

| caller | path | new behaviour |
|---|---|---|
| Gallery card (active + previous shelves) | `onOpenProject` | rule ✅ |
| Rail tile (`data-rail-tile`) | `onOpenProject` | rule ✅ |
| Agents hub project header | `onOpenProject` | rule ✅ |
| ⌘K palette "open project" | `handleOpenProject` | rule ✅ |
| `openFolderAsProject` (New Session / pick folder) | `handleOpenProject` | rule ✅ |
| `handleResumeProject` (`:1443`) | `handleOpenProject` | rule ✅ |
| Sidebar project header | **`handleOpenProjectHome`** | board, unchanged |
| SessionToolbar `‹ name` | **`handleOpenProjectHome`** | board, unchanged |

None relied on landing on `roster` except the last two, which is exactly why they were split out.

## Scope is not desynced

The session branch sets `activeTerminalId` and `activeSessionId` *inside* the `setActiveProjectId`
updater, so the scope is written in the same transition as the focus — it can never land on a
session belonging to a project it isn't scoped to. The focus-implies-scope backstop has nothing to
correct. `drive-navigation.mjs`'s "scope undisturbed" assertion still passes.

## The unread badge — checked, and it's fine

**Where it lives:** the sidebar channel row only (`data-channel-unread`), for the **active
project**. It is not on gallery cards, so it was never a cross-project "something happened here"
signal — you can only see it once you are already inside the project.

**So defaulting into the channel does not make it unreachable.** It changes what you get on entry
from *a count of things you haven't read* to *the things themselves*, which is strictly more
information. Marking read is honest: you are looking at the feed.

The badge keeps its remaining job — telling you something arrived while you were on a session or
the board inside that project — and for 1-lane and 0-lane projects, which do not land on the
channel, it behaves exactly as before.

**Not a regression.** The one thing genuinely lost is the "N unread" number on entry for
multi-lane projects; you now see the messages instead. If you'd rather keep the count visible on
entry, the fix is to make the channel mark-read on scroll or on dwell rather than on mount — say
the word and I'll do that separately, since it changes `onMarkRead`'s contract.

## Verify

- `npm test` — **546 passed** (+9 in `project-landing.test.ts`): all three roster sizes; live vs
  idle single lane; keyed off the roster not on liveness; an **ended** session doesn't count as
  live; **another project's** session doesn't count (which would also desync scope); matched by
  **role**, not by position; absent project / absent roster.
- `npm run build` clean.
- **Driven** (`node dev/drive-project-landing.mjs`), reading the surface from the DOM:

```
operator    4 lane(s) → channel   OK
uwazi_app   2 lane(s) → channel   OK
el-encanto  1 lane(s) → roster    OK
solo-demo   1 lane(s) → session   OK   (?solo=live)
solo-demo   1 lane(s) → roster    OK   (?solo=1, idle)
(0 lanes)   0 lane(s) → roster    OK

re-entering: entered → channel · moved to a session → session ·
             re-selected the SAME → session (unchanged — correct)
back-chevron → roster
```

Two fixture notes worth recording, because both would have made a green run meaningless:

- **`el-encanto` looks like a 1-lane project but its fixture session deliberately carries no
  `roleId`** ("no lane, so the label ladder falls through to the summary"). Nothing is live *as*
  that lane, so `roster` is the correct answer — my first expectation of `session` was wrong, not
  the code. I added `?solo=live` to get a genuine single-live-lane project rather than bending
  that fixture and breaking what it exists for.
- **Re-select must use the rail tile, not a round trip through the gallery.** Leaving via the
  gallery clears `activeProjectId`, so coming back is a genuine *entry* and the "don't yank me"
  assertion silently tests nothing. My first run reported YANKED for exactly this reason.
- `node dev/drive-navigation.mjs` — no regression.
