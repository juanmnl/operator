# RESULT — Close ends the agents. Nothing gets renamed to "Forget".

**Lane: Design.** Two decisions up front, then the shape, the copy, and what falls out.

---

## Decision 1 — Close ENDS the agents. It does not hide a running project.

Agreed with the brief, and there is a fourth reason stronger than the three it gives, sitting in
this repo already: **`lib/forgotten-projects.ts` is the written record of what happens when Operator
drops a project from its UI while the project's ptys keep running.**

> forget → the record is gone, the ptys are not → restart (or a WebKit renderer respawn)
> → the cwd-resolution effect sees a live pty with no project → resolves its folder → upserts →
> **THE PROJECT IS BACK**, with a fresh roster and a bumped `lastActiveAt`

That is *exactly* hide-while-running, and it is the bug the user reported as *"a whole project that
i marked as forget is launching by itself."* It cost a durable localStorage list to fix. Building
"hidden but alive" deliberately re-creates the same hazard with a new flag.

The app also already holds the opposite rule as a load-bearing invariant, in two places:

- `isActiveProject()` — *"a project with a live session is active whatever the record says, because
  a running agent must never hide inside a collapsed section."*
- `shelvingMoves()` — exists solely so the Shelve toast stops promising a move that liveness
  overrides.

**Live means visible.** Hide-while-running contradicts a rule this codebase paid a shipped bug to
learn. So: Close ends the lanes, the rail clears itself because membership is derived, and no new
stored state is introduced anywhere.

**What changes:** `closeProject` (`DashboardView.tsx:1009`) stops writing `archivedAt`. That is the
whole functional change. Everything else below is the consequence of removing that one write.

---

## Decision 2 — Naming: the brief's question is already answered, and the answer is *no*.

The brief asks whether the UI should say "Forget" or "Shelve" for the `archivedAt` write. Neither —
because **"Forget" is taken, by a destructive verb, in this app, today**:

`ProjectGallery.tsx:672` — `{ label: 'Forget project', danger: true, confirm: true }` →
`forgetProject()` (`DashboardView.tsx:912`) deletes the project row, roster, backlog, dispatch log,
description and notes, unstamps its sessions, and writes a durable tombstone.

Giving the reversible shelf-write the same word as the irreversible delete is
`feedback_two_verbs_one_glyph` in vocabulary instead of pixels — the precedent the brief exists to
avoid, one layer up from the glyph. **"Forget" stays where it is and keeps meaning "destroy."**

And the user's actual request is already satisfied on this axis: Forget *is* gallery-only.
`DashboardView.tsx:3569` documents it as a deliberate omission from the rail. So *"forget should be
an all projects view option"* is a description of correct current behaviour; the real ask underneath
it is the first half of the sentence — **"close a project just to remove it from the sidenav/rail,
not forget."** Their word "forget" means *"filed away where I have to go dig it out"*, which is what
Close does today by writing the shelf. Unfusing that is the fix. No rename delivers it.

### The one rename that IS needed: `Archive project` → `Shelve project`

One concept currently answers to three words:

| surface | word |
|---|---|
| card ⋯ menu (`ProjectGallery.tsx:668`) | **Archive** project |
| toast (`DashboardView.tsx:984`) | **Shelved** {name} |
| tidy sheet (`:800`, `:881`) | **Shelve** the quiet ones / **Shelve** N |
| module + section (`lib/project-shelf`, header) | **shelf** / Previous |

Pick **Shelve**: it is what three of the four already say, it is the module's own name, and the pair
*Shelve / Forget* tells you which one destroys — where *Archive / Forget* reads as two flavours of
the same filing and gives no clue. One menu label changes. `Restore to active` stays: it names its
destination, which is the clearest thing a reversal can do.

---

## The settled vocabulary

| verb | does | touches `archivedAt` | reversible | lives |
|---|---|---|---|---|
| **Close** | ends this project's live agents | **never** | reopening is just opening | rail tile ⋯ · gallery card ⋯ |
| **Shelve** | files it to Previous, leaves agents alone | writes | Undo toast · Restore to active | gallery only |
| **Forget** | destroys record, roster, tasks, notes | n/a (row is gone) | Undo toast only | gallery only |

Three altitudes, three words, no overlap, and each verb has exactly one write path.
`archivedAt` ends up written from **one** place — `archiveProjects()` — which is the discipline
v0.14.0 established for *clearing* it, now applied to writing it. Today `closeProject` is a second
writer; removing it is what makes the rule true.

---

## What falls out of removing the write

### 1. The gallery's Close loses its only guard — it must become confirm-gated

`ProjectGallery.tsx:659` deliberately ships Close *without* `confirm`, reasoning that the Undo toast
is the guard. But the Undo restores the shelf, not the ptys (`DashboardView.tsx:1058` says so in as
many words). With no shelf write there is **nothing left to undo**, so that guard evaporates.

Add `confirm: true` to the gallery item, matching the rail's. Both surfaces then arm-and-relabel to
`Close project · end 3 agents — click again`. Not `danger` on either — red is Forget's mark, and the
rail comment at `:3591` is right that one verb must not read as two weights on two surfaces.

### 2. The close toast: no Undo, and it must say where the project went

Undo is currently offered for an action that cannot be undone. Replace it with navigation — which
is also the brief's *"reads as done, not lost"* answer.

**With agents** — the receipt for something irreversible:

```
Closed {name} — 3 agents ended
It stays in Active. Launching an agent here brings it back to the rail.
```

**With no agents** (§4) — nothing ended, so the toast is a pointer, not a receipt. Closing an idle
project always lands you on the gallery (it was necessarily the project you were in), so the
destination is already on screen and a *Show in gallery* action would point at itself:

```
Closed {name}
It stays in Active — open it again any time.
```

Both drop the Undo. Neither needs an action: the first is unreversible by definition, the second
reverses by clicking the card in front of you. The partial-failure toast keeps its shape, minus the
shelf claim:

```
{name} — 2 agents did not stop
Design lane, QA lane
```

### 3. The `closing…` chip is now the whole progress signal — and was written for this

`DashboardView.tsx:886` already anticipates it: *"it is what lets the shelf write stop being the
thing that communicates progress."* Keep the chip; fix its tooltip, which currently promises the
move that is going away:

`ProjectGallery.tsx:464` — ~~`Ending this project's agents, then moving it to Previous`~~ →
**`Ending this project's agents`**

### 4. The `live > 0` gate is DELETED. Close is gated on **rail membership**.

*(User, 2026-08-06: "i just want the option to close a project when there's no agents running" —
today there is no option in exactly that case.)*

Both menus currently hide Close when nothing is running, justified as *"it would be a second button
doing exactly what Archive does"* (`ProjectGallery.tsx:656`). **That reasoning dies with the
unfuse.** Once Close stops writing `archivedAt`, a 0-agent Close is not Archive-under-another-name —
Archive files the project to Previous, Close leaves it in Active and takes it off the rail. Two
different outcomes. The gate was load-bearing only for a fusion that no longer exists.

And the gated-out case is the one the user actually wants. Rail membership is
`live > 0 || id === activeProjectId`, so **a project with no agents is on the rail whenever it is
the one you're in** — opened, nothing launched yet, sitting there. Removing it was impossible: Close
was hidden, and Shelve filed it to Previous, which is the buried-away feeling the user called
"forget."

**The rule: Close is offered when the project is on the rail, because Close means "take it off the
rail."** That is the same derived predicate the rail filters by, so it needs no new state — but it
is currently inlined at `ProjectRail.tsx:266`. Lift it into `lib/project-shelf` beside
`isActiveProject`:

```ts
/** Is this project ON THE RAIL right now? Live, or the one you're in. Derived, never stored —
 *  the rail's membership rule and Close's gate are the same question. */
export function isOnRail(p: Project, activity: ProjectActivity | undefined, activeProjectId: string | null): boolean {
  return (activity?.live ?? 0) > 0 || p.id === activeProjectId
}
```

Three call sites: the rail's own filter, the gallery card menu's gate, and the rail tile menu —
where it is trivially true for every tile, so **the rail menu's Close is simply always present.**

**Label carries the count, not a second verb:**

| state | label | guard |
|---|---|---|
| `live > 0` | `Close project · end 3 agents` | `confirm` — irreversible pty kill |
| `live === 0` | `Close project` | none |

No confirm at zero: nothing is destroyed, and confirming a reversible act is how you teach people to
click through the confirms that matter (`DashboardView.tsx:953`, the app's own reasoning). One verb
whose work is proportional to what's there — do not "fix" this later by re-adding the gate.

**`closeProject` needs no special case.** `closePlan` already returns `{ sessions: [], running: 0 }`
for an idle project, `Promise.all([])` resolves immediately, and `setActiveProjectId(null)` is the
whole effect. One nit: skip the `closingProjects` add when `plan.sessions.length === 0`, or the
`closing…` chip flashes for a frame on a teardown that has nothing to tear down.

**Known convergence, deliberately kept.** With zero agents, Close ≡ "All projects" / the logo / ⌘⇧O
(`handleShowGallery`, `:685`) — both just clear scope. That is not two verbs doing one thing: with
agents running they differ sharply (*"it stops nothing, the agents keep running"* vs. ends them),
and with nothing running "leave this project" and "close this project" genuinely are the same act.
The convergence is the absence of work, not a duplicated control.

### 5. Shelve stays available on a live project

`shelvingMoves()` and its honest toast already handle *"filed away, effective when the lanes stop."*
Keep it. One copy nudge so the honest toast points at the verb that resolves it:

`DashboardView.tsx:978` — ~~`Still running, so it stays on Active.`~~ →
**`Still running, so it stays on Active — Close ends its agents.`**

### 6. The empty rail

Closing the project you are *in* nulls `activeProjectId` (`:1023`), and null scope renders the
gallery — so the common path answers "where did it go" by landing you on the all-projects view with
the project sitting in Active. That is already correct; keep the null.

Closing a *background* project from the rail leaves you where you are and the tile simply vanishes —
that path is carried by the toast in §2, which is why the toast gets a destination and an action.

`ProjectRail.tsx:348` renders `shown.map(...)` with **no empty state**: close your only live project
from a non-project screen and the rail is a bare strip under the traffic lights. Give it one line in
the scroller when `shown.length === 0`, mono/uppercase/`--fg-muted`, matching the gallery's section
labels — **`nothing running`** at expanded width, omitted at 44px (nowhere to put it, and a blank
strip beside a visible gallery is not ambiguous). Not an error state, not an illustration: the rail
being empty is a correct and frequent condition.

---

## Placement, final

| menu | items |
|---|---|
| **rail tile ⋯** | Reveal in Finder · Project Claude files · ── · **Close project**`[· end N agents]` — **always present**, every tile is on the rail |
| **gallery card ⋯** | Edit description · Rename · Reveal in Finder · Project Claude files · ── · **Close project**`[· end N agents]` *(when `isOnRail`)* · **Shelve project** / Restore to active · ── · Forget project *(danger, confirm)* |
| **Previous row ⋯** | Open · Restore to active · Reveal · ── · Forget project *(danger, confirm)* — unchanged; a Previous row is never live, so Close cannot apply |

No verb gets a glyph. Close is a named menu item on both surfaces and never a `✕` on a tile or a
card — the rail tile is the thing you navigate by, and a click target that ends four ptys does not
belong on it un-armed.

---

## Verify

1. **Close with live agents** — agents end, tile leaves the rail, **`archivedAt` unchanged**, project
   still under **Active** in the gallery with roster/tasks/notes intact. Toast names the destination,
   no Undo.
2. **Close a project with NO agents running** — the case the user asked for. Item is present and
   reads `Close project` with no count and **no confirm**; tile leaves the rail, gallery renders,
   project sits in Active, `archivedAt` untouched, no `closing…` flash.
3. **Close from the rail while inside that project** — scope clears, gallery renders, project is in
   Active. Never in Previous.
4. **Close a background project** — you stay put, its tile vanishes, toast is the only receipt.
5. **A project that is neither live nor open** — its gallery card offers **no** Close (`isOnRail`
   false); Shelve and Forget only. There is no rail entry to take it off.
6. **Shelve a live project** — `archivedAt` written, stays on Active (liveness lifts it), toast says
   so and names Close.
7. **Shelve an idle project** — moves to Previous. Undo returns it. Batch undo still shares one
   timestamp.
8. **Forget** — unchanged: danger, confirm, destroys, durable tombstone holds across restart.
9. **Reopen a closed project** — roster, tasks, notes, branches all present; nothing to un-shelve.
10. **Rail with nothing live** — reads `nothing running`, not a blank strip.
11. **Word audit** — grep the renderer: zero occurrences of "Archive" as a user-facing project verb;
    "Forget" appears only on the destructive item; "Close" never adjacent to "Forget" without a
    separator.
12. `npm test` green (650 on `main` = `cbdd4ef`), `npm run build` clean. `project-shelf.test.ts` is
    the only suite touching this area — it covers `closePlan` (unchanged) but **not** the shelf
    write. Add: close leaves `archivedAt` undefined; and unit-test the new `isOnRail` across the
    three cases (live / open-and-idle / neither).

Both themes × light/dark are unaffected: no new colour, no new surface, one new muted text line.

---

## Not done, and why

- **No hide-while-running mode.** Decision 1. If the user's need turns out to be *"stop showing me
  this while it works"*, that is a different feature needing stored per-project state, a way to see
  what's hidden, and an answer for a hidden lane that needs input — and it walks straight back into
  the resurrection bug. Worth designing on request; not smuggled in under "Close".
- **No change to the shelf-write path's v0.14.0 discipline.** This change *removes* a second writer;
  it adds none.
- **No rename of Forget, and no new confirm on it.** It is correctly placed, worded and gated.

## Recommendation to the coordinator

Small and well-bounded for the Code lane:

1. `closeProject` — delete the `archivedAt` write; skip `closingProjects` when there is nothing to
   close; two toast variants, no Undo.
2. New `isOnRail()` in `lib/project-shelf`; `ProjectRail.tsx:266` uses it instead of its inline copy.
3. Both menus — **delete the `live > 0` gate**; rail's Close always present, gallery's gated on
   `isOnRail`; label carries the count; `confirm` only when `live > 0` (this *adds* one to the
   gallery, which loses its Undo-toast guard).
4. Copy — `Archive project` → `Shelve project`; closing-chip tooltip; the Shelve-while-live detail.
5. Rail empty state; two tests.

The risky part is not the diff — it is the copy staying consistent across menu, toast and undo, so
the word audit in step 11 is the check that matters.
