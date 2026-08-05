# v0.12.0 — release notes (DRAFT, not published)

Draft for review. Nothing is bumped or tagged. 31 files, +3711 / −546 against v0.11.2.

---

## Your team, not a wall of lanes

A new project now starts with **one Operator lane** instead of six nobody asked for. Everything
else you add when you want it.

Existing projects get a one-time tidy: lanes that were never launched, never held a task, never
sent or received a dispatch — **and** are still exactly what the seeder wrote — are removed. A lane
you actually used, or edited, stays. **Operator is always kept**, so a project can never end up
with nothing to talk to. There's an Undo on the toast.

Six of the projects on this machine went from six lanes to one; two went to four and five, keeping
only the lanes with history; the five busiest were untouched.

## The Agents view is a roster of character cards

Identity, loadout and state on one card: who the agent is, the model and effort it's set to, and —
only when it's live — what it's doing right now. One card in two states rather than two components
that drift apart. Idle lanes no longer look like missing data.

## Opening a project puts you where the work is

A project with several agents opens on its **channel**. A project with a single agent opens on
**that agent** — its session if it's running, otherwise its card with Launch in reach. Nothing
starts on its own; landing somewhere is navigation, not a decision to spend a process.

Projects used to always open on the roster board, which after the tidy is frequently a board with
one card on it.

## The channel reads like a conversation

- Long messages **fold** with a Show more, so a one-line status report and an eight-line brief no
  longer occupy the same space.
- A run from one author **collapses its repeated name and avatar** — but keeps the target, time and
  outcome on every row, because those are what change inside a run.
- **Inline code renders** instead of showing raw backticks.
- **Timestamps are local.** They were rendering UTC — five hours off here — and the day separator
  bucketed on the UTC date, which filed everything after 7pm under tomorrow.
- **The feed uses the window.** Messages ran in a fixed 720px column parked in the middle of the
  pane; rows now span it edge to edge, with the header, every message and the composer sharing one
  left edge. Text grows with the window up to a comfortable ceiling — on a wide screen a typical
  message now reads in full without unfolding, where before it was cut at just over half.
- **The composer is one surface.** The message box and its actions sat in two separate bordered
  boxes, above a permanent row of one button per lane. There's now a single box you write in, with
  one control for who you're writing to — the same size whether the project has one agent or six.
  It starts one line tall and grows as you type, and the feed passes under it instead of stopping
  against it.
- A message held for your approval, or stopped by a brake, **no longer looks identical to one that
  was delivered**. It was drawn in the same ink; a message that reached nobody was fainter than one
  that landed.

## Dispatches that don't silently truncate

A dispatch used to be committed on a timer's guess about how long the terminal needed. Under load
that guess was wrong in the direction that splits a message — a 203-character dispatch arrived as a
truncated turn with its tail stranded. Delivery is now **confirmed from the transcript itself**, and
a message that never became a turn is reported as *sent · never started* rather than vanishing.

## Usage that isn't quietly stale

The plan meter read once at startup and never again, so it could show a session percentage from a
window that had already reset — a number provable wrong from data already on screen. It now
refreshes on a schedule, on focus and when you open it, and an **elapsed window is treated as
expired rather than merely old**.

## Closing a project

**Close** ends a project's live agents and shelves it, in that order. Shelve alone used to claim
success while a running lane pinned the project to Active — a success toast, an Undo button, and no
change. Your roster, tasks and notes are kept; Undo restores the shelf, not the agents, and says so.

## Agents can talk to each other by default

Agent↔agent delivery used to ship switched off, so a lane's reply was posted to the channel but
never reached the lane it was addressed to. It now ships **on**. If you had explicitly turned it
off, it stays off.

Testing that change found a real leak: **the chain limit didn't actually stop a chain.** A blocked
message never advanced the recipient's hop count, so the two lanes alternated blocked and delivered
at half rate, indefinitely — the per-pair rate brake was what had been ending runaway chains all
along. A spent chain now stops both ends dead, and a human message or a fresh chain releases it.

The kill switch stays where it was, for when you want it.

## Whose message is whose

Lane replies in the channel were authored by a raw session id — a 36-character uuid with no name
and no colour. The channel looked up authors among the *currently running* agents while rendering
history, so a reply from a lane that had since finished could never be attributed. It now resolves
against the durable store, which is where the answer was all along.

## The Agents view is the fleet that's working

It listed every lane across every project, running or not — so two working agents sat under
seventy-odd that weren't. It now shows what's actually in play. Idle lanes live on the project's
roster board and in its sidebar, which is where you launch them.

## Smaller

- Worktrees now default on for **Operator** and **Research** as well as Code and Design. Review and
  QA stay off deliberately — they need to see the working lane's uncommitted diff.
- Project tiles in the rail **drag to reorder**, and the order persists. The rail no longer
  re-sorts itself as agents start and stop.
- The bottom-left corner reads as one corner: the usage ring no longer outweighs the navigation
  buttons beside it, and the divider gets more air than the things it separates.
- Footer icons were stacking opacity on an already-muted token, leaving them close to invisible on
  the light themes.

---

## Notes for the announcement

- **The lane tidy is the headline risk.** It deletes user-visible things on first launch. Undo is
  there, and Operator is always kept, but it should be mentioned plainly rather than buried under
  "smaller".
- **Agent↔agent on by default changes what the app does unattended.** It has its own section above
  and should stay there. The hop-limit leak is worth naming rather than hiding: it was found by
  driving the brakes in the app, and the honest version of that story ("the guard we relied on
  didn't hold, here's what did, here's the fix") reads better than silence.
- **Hold the tag until the channel settles.** It has been through six passes and is mid-redesign:
  the narrow column and digest rows have landed, but the app shell and the channel's right panel
  have not. Tagging now ships a channel that changes shape again within a day. The rest of the
  release — the lane tidy, dispatch delivery, usage freshness, closing a project, agent↔agent —
  is done and stable.
- **The channel section above will need rewriting** once the redesign lands. What it describes
  (folding, grouping, inline code) is true but is no longer the headline; the headline will be
  that the channel became a readable digest with the project's context beside it.
