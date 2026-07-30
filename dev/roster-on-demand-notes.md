# Rosters start empty — decisions

**2026-07-28.** Implements `dev/briefs/roster-on-demand.md`. This reverses the 2026-07-27 "don't fix the seed" call, deliberately: cheap-to-render was the wrong test. The objection was never pixel cost, it was that a brand-new project arrived pre-populated with six agents nobody asked for, sitting in the sidebar looking like they were waiting for something.

## What changed

- **`upsertProject` creates `roster: []`.** New projects start empty.
- **`RosterPanel` no longer back-fills a roster.** A rosterless (legacy) project stays empty rather than being seeded on first open. The *prompt* back-fill for existing rosters is untouched.
- **The six definitions live on as templates** — `rolePresets()` in `lib/roster`, with `defaultRoster()` kept as an alias because the lane-accent palette and the roster tests both want the canonical six in order. Nothing calls them for seeding any more.
- **Existing projects are untouched.** This is a change to seeding, not a migration; no project's board is retroactively emptied.

## The empty state

Now the first screen every new project shows, so it teaches rather than shrugs. It says what a lane *is* — "a named seat on this project with its own model, reasoning effort and standing brief" — and then makes the six templates the primary content, as one-click cards showing what you'd be adding: the model and effort it pins, and the first sentence of its charter. "Code" alone doesn't say why you'd pick it.

A blank lane is available underneath, deliberately secondary: it opens as an expanded card because an unconfigured lane needs configuring before launch, whereas **a preset arrives configured and so opens as a row**.

Once the board is populated, `+ Add agent` opens the *same* templates as a menu, listing only those not already on the board. One way to add a lane, not two.

## The dispatch decision

**`OPERATOR-DISPATCH [code] …` against a project with no Code lane creates the lane from its template and runs the task on it.**

`routeDispatch` gains a fourth outcome, `create`, between `queue` and `unassigned`:

| Token | Route |
|---|---|
| names a lane on the roster | `send` (live) or `queue` (idle) — unchanged |
| names one of the six **templates**, absent from the roster | **`create`** → add from preset, then launch with the task as its opening brief |
| anything else (`[cod]`, `[frontend]`) | `unassigned` → visible backlog + toast + feedback to the dispatcher |

**Why create rather than reject.** A dispatch *is* the demand. The user's objection is to lanes appearing that nobody asked for; a lane created because work was explicitly addressed to it is the opposite of that, and it arrives already working rather than sitting idle. Rejecting instead would break unattended orchestration runs — the common case now that rosters start empty — for no benefit the user asked for.

**Why not create for unknown tokens.** Dispatch text is LLM-authored, so typos are likely. `[cod]` must not mint a junk lane; it falls through to the unassigned backlog, which is visible and reassignable. A user's own tuning also always wins: if the roster already has a `code` lane on Haiku, a dispatch uses *that*, never the preset's Opus.

**A dispatch never silently vanishes.** That was already true of the dispatch loop (unknown roles reach the unassigned backlog with a toast, plus a note typed back to the dispatcher's pty naming the live lanes so it can reassign). The genuine silent-vanish was elsewhere: **`startProjectTasks` skipped any task whose `roleId` had no matching role** — the "Start all" path. That is now closed the same way: recreate the lane from its template if the id names one, otherwise hand the tasks back to the visible unassigned backlog with a toast. This also addresses `queued-tasks-no-trigger.md` defect 3's stuck tasks.

## What was considered and rejected

- **Auto-creating a lane for any unknown token.** Guarantees pickup, but mints junk lanes from typos and invents a model and charter from nothing.
- **Rejecting known presets too, offering to create.** Honest, but it breaks unattended runs, which is the case that matters most with an empty default roster.

## Verification

`dev/drive-roster.mjs` (updated for the template menu) and a virgin-app run via `dev/mock.html?empty=1`:

- a brand-new project shows **0 lanes, 0 cards, and the empty state** with all six presets;
- one click on `code` adds it with `Opus · High` intact, and the sidebar goes 0 → 1;
- the `+ Add agent` menu then offers only the five remaining presets;
- `Blank lane…` still yields an unconfigured lane opened as a card;
- an existing project's roster is untouched.

Routing is unit-tested in `lib/dispatch.test.ts`: create-from-preset, preset matched by name and case-insensitively, typos falling through to unassigned, and an existing lane's tuning winning over the template.

**Six-palette theme pass: green — 0 below floor** (4.5:1 body / 3:1 meta) across all of Mission Control, Mr Pink and 1984 in light and dark, covering the new empty state alongside every previously-measured surface.

Two harness bugs were found and fixed getting there, both mine:

1. **The sweep had outgrown a single page and a single browser.** It now walks ~10 full app boots per palette; WebKit's renderer hard-crashes part way through with **no JS error**, which reads as a product bug rather than a harness limit. It now takes a fresh page for the virgin-app steps and a fresh browser per palette.
2. **The replacement page inherited no init scripts**, so once step 5 swapped pages the `?empty=1` and `?lost=1` screenshots were silently shot in the DEFAULT palette, six times over. The theme init script now lives inside the page factory.

And one diagnostic trap worth recording: **Node block-buffers stdout when piped, and an uncaught exception exits before flushing it.** Every `✓ <palette>` line was being printed and then lost, so a crash on the *last* palette looked identical to a crash on the *first* — which is what sent the investigation after the wrong thing for several rounds. Redirect this driver to a file (`> tp.log 2>&1`) rather than piping to `tail`.