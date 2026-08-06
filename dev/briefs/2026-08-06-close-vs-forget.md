# Two verbs, two altitudes: Close clears the rail, Forget files the project

**Lane: Design.** The decision here is about verbs and where they live, not wiring.

User, 2026-08-06: *"it will be good if you add the possibility to close a project just to remove it
from the sidenav/rail, not forget. forget should be an all projects view option."*

## What is true today

- **Rail membership is derived, never stored** — `ProjectRail.tsx:265`:
  `projects.filter(p => (activities[p.id]?.live ?? 0) > 0 || p.id === activeProjectId)`.
  It does **not** consult `archivedAt`. The rail already means *"what is running, plus where I am."*
  A project leaves it the moment its agents end.
- **`archivedAt` is the shelf** — Active vs Previous in the gallery. `lib/project-shelf` is explicit
  that it is *"the user's decision, never derived"*, and v0.14.0 fixed a bug where a background
  upsert cleared it as a side effect and resurrected forgotten projects.
- **One control does both.** `ProjectGallery.tsx:661` — `Close project · end N agents` ends every
  lane **and** writes `archivedAt`.

So the two verbs the user is separating are already separate concepts with separate state. They are
fused only in that one action, and only in one direction: you cannot clear your workspace without
also filing the project away.

## The shape to design

- **Close** — "I'm done working on this for now." Ends the project's agents; the rail clears itself,
  because membership is derived. **Must not touch `archivedAt`.** The project stays exactly where it
  was in the gallery, and reopening it is unremarkable.
- **Forget / Shelve** — "file this away." Writes `archivedAt`, moves it to Previous. **Gallery only**,
  as the user asks. It is the all-projects view precisely because that is where you can see what
  you're comparing it against.

The rule to hold: **`archivedAt` is written from exactly one surface.** Tonight's bug was it being
*cleared* from anywhere; the same discipline should apply to writing it.

## The one real decision — my recommendation, argue if you disagree

**Does Close end the agents, or hide a project that keeps running?**

I'd say **it ends them**, for three reasons: rail membership is already live-derived, so ending
agents clears the rail with no new state at all; "close" everywhere else in this app means the work
stops; and a project running invisibly is how you end up with agents burning tokens that nobody is
watching.

The alternative — hide-while-running — needs a stored per-project override, a way to see what's
hidden, and an answer for what happens when a hidden project's agent needs your input. If the user's
actual need is *"stop showing me this while it works"*, say so and design that instead, but it is a
bigger thing than it looks and it reintroduces derived-vs-stored ambiguity in the rail.

## Also settle

- **Naming.** "Forget" is the user's word and is stronger than "Shelve" — decide which the UI says,
  and say the same thing everywhere (menu, toast, undo). Note nothing is deleted by either verb:
  roster, tasks, notes and branches all survive, and the existing Shelve copy promises exactly that.
- **Undo.** Shelving already supports batch-undo under one timestamp. Close should be equally
  unremarkable to reverse — reopening is just opening.
- **Where Close lives.** The user asked for it on the rail/sidenav. It should also stay reachable
  from the gallery, but the gallery's current combined control has to split.
- **The empty case.** A project whose agents you just closed vanishes from the rail. Make sure that
  reads as "done", not "lost" — the user should know where it went.

## Constraints

- House rules: no browser focus rings, colours via CSS vars, no colour-changing border on a radiused
  element, never recede a card with group `opacity`.
- **Two verbs never share a glyph.** A `✕` on a live card has meant "delete the lane" in this app and
  cost real data — that is the precedent this brief exists to avoid repeating.
- Don't touch the shelf-write path's new discipline from v0.14.0.

## Verify

- Close on a project with live agents: agents end, project leaves the rail, **`archivedAt` unchanged**,
  project still Active in the gallery.
- Forget from the gallery: project moves to Previous; agents (if any) handled per the existing
  close-then-shelf sequence.
- A closed project reopens with roster, tasks and notes intact.
- Neither verb is reachable by a control that could be mistaken for the other.
- `npm test` green (650 on `main` = `cbdd4ef`), build clean.

## Output

Write `/Users/juanmnl/Developer/operator/dev/briefs/2026-08-06-close-vs-forget-RESULT.md`
(absolute path, main repo). Lead with the Close-ends-agents-vs-hides decision and the naming call.
