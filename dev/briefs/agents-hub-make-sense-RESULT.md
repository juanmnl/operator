# Agents view — a team roster of character cards

Answers `dev/briefs/agents-hub-make-sense.md` (the rewritten 2026-07-30 framing).

---

## Card anatomy

```
┌──────────────────────────────────────┐
│  ◐  Research               2 queued  │  identity  — orb (CIRCLE, lane accent) + name
│     Sonnet · High                    │  loadout   — class and stats, always present
│     COMPACTING  Profile the settings │  in play   — EARNED by being live
└──────────────────────────────────────┘
```

- **Identity** — the orb carries the lane accent and the name is `laneTextColor`, never a raw
  accent. Shape vocabulary intact: an agent is a circle, a project is a rounded square, and
  nothing here turns an agent into a square avatar.
- **Loadout** — `model · effort · worktree`, the "class and stats". Always drawn, which is what
  makes a bench card worth reading.
- **In play** — phase word (in the lane's ink) plus the current task. Present only when live.
- **Queued** — a transparent badge, drawn only when work is actually waiting.

`worktree` appears only when ON. "No worktree" is the absence of a property, not a stat worth a
slot — and once the default flips on for most lanes, printing both states would put a word on
every card that distinguishes nothing.

## One card in two states, not two cards

The brief asks me to argue this. **One card.**

`ActiveCard` and `PassiveCard` were separate layouts that happened to look alike, and that is
*why* "97% of the pixels go to things that aren't happening" was possible — two components drift
into equal weight because nothing forces them to relate. A character sheet doesn't change shape
when the character stops acting: you should recognise the same agent whether it is in play or on
the bench, and the difference should be **what is filled in**, not where things are.

So live vs idle differ only by: a live orb (which animates; an idle one is static), a surface fill
versus transparent-until-hover, and the presence of the in-play line. Idle recedes **by token** — a
muted name, a static orb — never by a group `opacity`, per the rule that exists because of a
previous idle-card fade.

**Motion:** the orb is the only animated element and `StatusWave` already animates only
`running`/`compacting`, so a roster of idle agents is completely still.

### Rejected

- **Two card sizes** (big for live, compact for idle). It re-creates the original problem from the
  other direction: it makes "idle" a lesser class of thing, when an idle agent holding three
  queued tasks is the most actionable row on the page.
- **Any trading-card furniture** — no rarity borders, no XP bars, no frames. The brief warned and
  it was the right warning; the temptation with "character card" is a bold accent header block,
  which is exactly the solid-accent-fill the house rules forbid.
- **A charter/description line on the card.** It is the most "character" field available, but it
  is prose of unbounded length in a 232px grid cell, and it would have needed its own clamp. The
  loadout carries "what it's built for" more compactly.

## Grouping: still per-project, one heading level

Per-project stays — a team is per-project, and this is the one cross-project surface in the app.
But **three heading levels became one**. Project header only; `ACTIVE` and `IDLE LANES` subheads
are gone, and live cards simply sort before idle ones in a single grid.

That fixes the broken rhythm directly: projects with nothing live used to skip `ACTIVE` entirely,
so the heading pattern changed every few sections. The cards say which state they are in — a
subhead repeating it is chrome that only appears sometimes.

The project header's own count changed from `3 live · 5 idle` to `3 in play · 8 agents`: a team
size and how many of them are working, rather than two competing inventories.

## What replaced the rollup chips

```
before   2 LIVE AGENTS · 76 IDLE LANES · 13 PROJECTS
after    4 IN PLAY · 3 TASKS WAITING (across 2 agents) · 3 TEAMS
```

`76 idle lanes` was `13 projects × ~6 seeded roles` — an artifact of seeding, not a fact about
anyone's work, and it dwarfed the number that mattered. "Idle lanes" is not a quantity worth a
headline at all: a team having members who aren't currently talking is the normal state. What *is*
worth counting is **work nobody has picked up**, which was absent from this view entirely.

## The `_`

Dead. It was `modelFamilyLabel(role.model)` returning an em dash for every lane that **inherits**
its model — which is most of them, so the "missing data" reading was on nearly every idle card.
Cards now show `resolveAgentConfig(role, globals, projectDefaults)`, the value the lane will
actually launch with. More truthful and the dash cannot occur: a lane always resolves to a model.

## Queued work

It surfaces, and it was the most valuable thing added here. `queuedCountsByRole` already existed
(the roster board uses it) and nothing in this view read it. An **idle** card with `2 queued` is
now the loudest thing on the page — which is right, because it is the only thing asking for a
decision.

## Verified

- `npm run build` clean. `npm test` 429/429.
- `node dev/drive-theme-pass.mjs`, all 6 palettes: **`BELOW FLOOR: 0`**. I added four permanent
  probes for the new card, and **the first run with them caught a defect I had just introduced**:

  ```
  agentCard · queued badge   before  7.60  2.45  6.89  2.43  9.75  1.55   ← BELOW FLOOR: 3
                             after   9.62  5.65  8.04  5.36 10.06  4.76
  ```

  The badge used raw `var(--status-compacting)` as 9px text. That token is tuned for a status
  **orb** — a filled dot, where hue is the whole message — and as text it collapsed to 1.55:1 on
  1984 light. The most actionable element on the card was the least legible on three of six
  palettes. Mixed 45% toward `--fg`, the same correction the channel's `ACCENT_INK`/`WARN_INK`
  make. Other card inks: live name 5.43–7.16, idle name 6.65–8.20, loadout 3.73–5.89 (meta).
- **Realistic fixture**, per the brief's warning about the 20-char-body precedent: mixed live and
  idle, a project whose team is **Operator and nobody else** (the post-prune floor — renders as
  "1 in play · 1 agent", one card, no empty scaffolding), lanes holding queued tasks, an ad-hoc
  session with no lane at all, and a 37-character lane name that truncates rather than wrapping.
  `/tmp/operator-shots/agents-hub2.png`.

**Port note:** 1433 is a Python `http.server` directory listing of an empty folder, not the app.
Used 1436, this session's assigned port; did not bind 1433.

## Left alone

- **The Defaults and Subagent-library tabs.** Untouched except that Defaults now uses the shared
  `Segmented` (from the roster-chips brief in the same batch).
- **Cross-project grouping stays project-first.** The brief asked me not to lose the cross-project
  read; sorting by busiest project keeps it, and I did not add a flat "all agents everywhere" mode
  — that would lose which team each agent belongs to, which is the thing "roster" means.
- **The Fleet tab name.** "Fleet" is inventory language next to a team framing, but it is the tab
  a user has learned and renaming tabs was not asked for. Worth a look next time this view moves.
- **`sessionLabel` for live cards** still wins over the lane name, so a renamed session shows its
  custom name rather than its lane's. Correct — but it means a live card and its idle counterpart
  can read as different characters. Left as-is; changing it would override a name the user chose.
