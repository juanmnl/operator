# Close a project — RESULT

**Status: done. `tsc` clean · `npm run build` clean · 517 tests pass (508 → 517).**

## The sequence

`closeProject(id)` in `DashboardView`:

1. **`closePlan(id, sessions)`** — pure, in `lib/project-shelf`: which live sessions belong to
   this project, and how many are mid-task.
2. **End them, awaited, one by one**, through `handleCloseSession` — the *same* path the per-lane
   ■ takes. It kills the pty, finishes that lane's running tasks (diff capture + verification
   gate), removes the worktree directory while keeping the branch, and drops the saved session.
   No second teardown route.
3. **Only then** write `archivedAt`, and drop the scope if you were inside it.
4. Toast with the real count.

Step 3 after step 2 is the whole point. Writing the flag first re-creates the exact lie this
brief is about: `isActiveProject` lifts a project with a live lane straight back onto Active, so
the flag would land and nothing would move.

**Nothing is pattern-killed.** Every pty is closed by id, and `closePlan` filters on
`projectId === id` — a session belonging to another project, or to none, is never in the list.
Verified in the driver: `ptys killed by id: ["t0","t1","t2"]`, and `el-encanto`'s sessions survive.

## What Undo does and does not restore

**Undo restores the shelf. It cannot restore the agents** — the ptys are gone. The toast says
exactly that and nothing more:

> **Closed operator — 3 agents ended**
> *Undo restores the shelf, not the agents.*

I trimmed that detail deliberately: `Toast.tsx` clamps it to one ellipsised line and the action
button eats into it (~40 chars land). The first draft read *"Its roster, tasks and notes are kept.
Undo restores the shelf, not the agents."* and truncated at *"…are kep…"* — losing precisely the
clause that stops Undo being over-promised. The roster/tasks/notes reassurance is already carried
by the plain Shelve toast; the misleading half is the one that had to survive.

## The Shelve toast fix

`shelvingMoves(activity)` — new, pure, and the same rule as `isActiveProject` stated from the
caller's side. `archiveProjects` asks it before writing the copy:

| | before | after |
|---|---|---|
| quiet project | *"It moves to Previous…"* | unchanged |
| **live lanes** | *"It moves to Previous…"* ← **false** | *"Still running, so it stays on Active."* |
| batch, some live | *"They keep their rosters…"* | *"N still running, so they stay on Active."* |

The flag is **still written** — it is the user's decision and it takes effect the moment the lanes
end. What changed is that the toast stopped claiming a move it can't make. Plain Shelve is
untouched otherwise: I did not remove it to force Close.

## Keeping Close and Forget apart

Both live in the gallery card's `⋯` menu, where Shelve and Forget already were — no new
affordance invented.

```
Close project · end 3 agents      ← own separated group, appears only when lanes are live
────────
Archive project                    (or "Restore to active")
────────
Forget project                     ← danger-toned, confirm-gated, always LAST
```

- **Different in kind, different in weight.** Close is plain-toned with no confirm (reversible
  housekeeping). Forget keeps `danger: true, confirm: true` and its own separator above it, so the
  two are never adjacent and never look alike. No shared glyph — both are text labels; nothing in
  this change introduces an icon.
- **The label names its own damage** — *"end 3 agents"* — so the count is read before the click,
  not discovered in the toast after.
- **Close is omitted when nothing is live**, because it would then do exactly what Archive does,
  and two verbs that look different while acting the same is its own kind of lie.

**A hole the driver caught:** I first gated Close on `!archivedAt`, which hid it on a
shelved-but-still-live project — the very state the new Shelve toast describes. Close now appears
whenever `liveCount > 0`, shelved or not, so the honest toast never points at a control that isn't
there.

## Mid-task lanes

**Counted, never blocking** — your instinct, and I agree. `closePlan.running` counts lanes in
`running`/`compacting`. There is no modal: closing is reversible and a confirm on a reversible
action teaches people to click through the confirms that matter. The menu label already names how
many agents end, which is the number that decides whether you click.

*Where I stopped short:* the mid-task count is computed and tested but **not yet surfaced** — the
label says "end 3 agents", not "end 3 agents · 2 mid-task". Adding a second clause to that label
is a wording/level-of-alarm decision in a menu Design owns, so `closePlan.running` is wired and
ready rather than spent. Flagging it rather than deciding it.

## Verify

- `npm test` — **517 passed** (+9 in `project-shelf.test.ts`): close with 0 live lanes is a pure
  shelve; N live lanes are all collected; another project's and an unattributable session are
  never included; a session with no terminal is skipped; mid-task lanes counted; and
  `shelvingMoves` proven to agree with `isActiveProject` across live counts, so a live project can
  never be silently "shelved" into Previous.
- `npm run build` clean.
- **Durable state** (`node dev/drive-close-project.mjs`):
  ```
  before — saved sessions: ["uwazi_app","el-encanto","operator","operator","operator","el-encanto"]
  after  — saved sessions: ["uwazi_app","el-encanto","el-encanto"]
  ptys killed by id      : ["t0","t1","t2"]
  toast                  : "Closed operator — 3 agents ended"
  archivedAt IS written           : true
  this project's sessions gone    : true
  OTHER projects untouched        : true
  gallery mentions a Previous shelf: true
  …containing the closed project   : true
  and it is NOT on the Active grid : true
  ```
  It actually appears under **PREVIOUS · 1**, rather than claiming to
  (`/tmp/operator-shots/close-project-previous.png`).
- Plain Shelve on a busy project: toast reads *"Still running, so it stays on Active."*, the card
  stays on Active, and **no session is touched**.
- `node dev/drive-gallery-shelf.mjs` — no regression.

## Left for Design

- **Where the control lives and what it's called.** I put it in the card's `⋯` menu because that
  is where Shelve and Forget already are; the label wording, and whether Close also belongs in the
  project header or the rail, is Design's.
- **Surfacing the mid-task count** (above).
- **A project-scoped Close from inside the project**, rather than only from the gallery card —
  closing the project you are currently looking at means going out to the gallery first. That is
  an affordance question, so I stopped rather than inventing one.
