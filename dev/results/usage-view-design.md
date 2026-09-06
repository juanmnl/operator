# The usage view, re-aimed at tuning — design

Design only. Nothing was implemented; the mock at `dev/usage-preview.html` is static HTML with
fixture numbers, no React and no bridge. Brief: `dev/briefs/usage-view-design.md`.

Open the mock with `open dev/usage-preview.html` (or serve `dev/` and hit
`/usage-preview.html`). The dashed switcher at the bottom right is dev scaffolding, not part of
the design; it cycles all six palettes.

---

## 1. The rule the whole page obeys

**Every number on this page is next to the change it argues for, or it says there is no change to
make.** That is the difference between this page and the one that was deleted. The old
`UsageView.tsx` (recoverable at `9525a28^:src/renderer/components/usage/UsageView.tsx`) had a
"Cost" tab that was a spend report — five stat tiles, a daily bar chart, a model table, a project
table — and an insights tab whose three percentages were followed by generic advice ("`/compact`
mid-task, `/clear` when switching"). Nothing on it pointed at a control the app owns. You could
read it for a minute and change nothing, which is what happened to it.

The knobs that exist today are exactly two, and they live in one place: `RosterPanel`'s per-role
**model** and **effort** pickers, plus the role's **charter** (`Role.prompt`, `types.ts:162`).
Anything this page reports has to land on one of those, or admit it has no knob.

Second rule, from the landing and from Juan: **tokens, never dollars, as the primary number.**
Cost appears once per row, right-aligned, in `--fg-muted`, at 11px. It is the sanity check, not
the headline.

---

## 2. Where it lives

- **One `PageShell` page**, flat, no tabs, `measure="grid"` (1100px — the lane table needs
  columns more than it needs a comfortable line). Tabs would hide the lower half and rebuild the
  old view's two-tab hunt.
- **Name: "Tuning."** Not "Usage" and not "Usage & cost". The rail foot already has a
  `PlanMeter` labelled "Plan usage" (`ProjectRail.tsx:1173`), and two neighbouring entries called
  "Usage" and "Plan usage" would be a coin flip every time. "Tuning" also matches the landing's
  own section name for cells 06–09.
- **Entry points**, in order of how they will actually be used:
  1. **The plan meter popover.** It ends in a footer row (`PlanMeter.tsx:238`); add one link
     there — *"What's driving this →"*. This is the moment the question gets asked: someone
     opened the meter because a bar went amber. Not in the brief, and it is the single highest
     value entry — recommend building it with the page.
  2. **⌘K palette** — `Tuning`, alongside the existing `view(...)` entries in `DashboardView`.
  3. **Rail foot**, first row, next to Agents and the plan meter (`ProjectRail.tsx:1145-1183`).
     That row is "views ACROSS projects", which this is.
- **Range control**: `Today · 7 days · 30 days`, segmented, in the header. The old view's `90
  days` and `All` are dropped — no tuning decision is made on a 90-day average, and the parse
  cost grows with the window.
- Scope is **all projects**, always. A lane is tuned against the plan window it shares with every
  other lane, so scoping the page to one project would hide the thing it exists to show. The
  project column carries the scoping.

---

## 3. The page, section by section

Order is the brief's order of importance, top to bottom, and it is also the order of confidence:
everything above "Context pressure" is buildable from data that exists today.

### 3.1 Biggest single change (the card at the top)

One card, one sentence, one button. It names the lane with the largest share of the window, its
model and effort, and the one step down that would move it:

> **Review** on Opus at Extra high took 38% of the last 7 days — 12.4M tokens over 41 turns,
> more than the next two lanes together. Dropping it one step to High is the smallest change that
> moves this.
> `[ Open Review in the roster ]`

Rules for what it may say, so it never lies:
- It only fires when the top lane is **above 25%** of the window *and* has a step available
  (effort above `low`, or a model above the cheapest in the ladder). Otherwise the card renders
  the honest version: *"Nothing stands out. The top lane is 19% of the window, already on
  Sonnet."*
- It never claims a saving in tokens or dollars. A step down the effort ladder does not have a
  known multiplier, and inventing one would be the same class of error as showing 0% for absent.
  It ranks, it does not forecast. The `ESTIMATE` chip and the line under the button say so.
- The button navigates to the roster with that role selected. That is the whole point of the card.

### 3.2 Spend by lane — *lane × model × effort*

The primary table. Columns: lane (accent dot + name), project, model · effort, a token bar,
total, share, cost. Under each row, one muted line saying what to change, and a `Roster` button.

Two-line rows rather than a "suggestion" column: the advice is a sentence, and a sentence in a
90px column is a stack of two-word fragments.

- **Effort shown is the launch pin**, resolved through the roster cascade — `Role.effort`, then
  the project default, then the preset (`lib/effort.ts`, `lib/model-config` `resolveAgentConfig`).
  A lane inheriting rather than pinned renders `Opus · inherit` with the resolved value in the
  suggestion line. This is honest and available today; what it cannot see is a mid-session
  `/effort`, because the tailer drops the transcript's own `effort` field (audit §5a). The card
  and the table both carry that caveat in one line, once.
- **"Not attributed"** is a real row, not a silent omission. Transcripts that no saved session
  claims (sessions started outside Operator, lanes since forgotten) are counted in the totals and
  shown as their own row with a `no lane on record` chip. Folding them into the attributed lanes
  would inflate whichever lane is nearest; dropping them would make the shares not sum.

### 3.3 Project share of the week

Answers "which project is eating the window" without pretending to a mapping that does not exist.

- **Top of the card: the plan meter's own reading, quoted verbatim** — `Week · 62% used · resets
  Sunday 4:00 PM`, drawn with the same 4px bar and `TONE_FILL` thresholds as `PlanMeter`. Reuse
  `usePlanLimits` and `lib/plan-limits.ts` rather than restating either.
- **Below it: a stacked bar of local tokens by project**, with a legend carrying tokens and
  percent.
- **Between them, one paragraph that keeps the two apart**: the 62% comes from Anthropic; the
  split below is local transcripts on this machine, a different denominator, and therefore a
  ranking of projects rather than a slice of that 62%.

**Recommendation: do not multiply them.** "Project × week%" looks like a per-project plan
fraction and is not one — local transcripts miss everything billed against the same plan from
another machine, from `claude` runs outside Operator, and from the web. The product would carry
the plan's authority over a number the plan never saw. This is the same failure family as
"absent is not zero", one axis over. If Juan wants it anyway it is one line of arithmetic; it
should then be labelled `≈` and never coloured by the meter's thresholds.

When the plan reading is absent or stale, the top half degrades to the meter's own `no reading`
chip and its existing copy, and the project split still renders — it is read locally and does not
depend on the CLI.

### 3.4 Context pressure

Per lane: compaction count, share of turns above 150k, median context, tokens re-read.

- **The compaction column ships empty**, with a dashed `not captured` chip and a footnote naming
  what closes it. That is deliberate: the column is where the number goes, the chip says why it
  is not there, and nothing has to be re-laid-out when capture lands. The alternative — hiding
  the column until the backend catches up — makes the gap invisible and the layout change twice.
- Everything else in this table comes from data the parser already computes per record
  (`usage.rs:187`, `context = input + cache_read + cache5m + cache1h`), currently folded into one
  global `high_context_pct` and thrown away per session.
- **This section has no knob and says so**: "Operator has no knob for this — the change is a
  smaller task per lane, or a fresh lane per task." Pretending effort fixes context pressure
  would be worse than admitting there is nothing to click.

### 3.5 Tool output

Per lane: p50 and p90 of `ToolBlock.output_chars`, that share of the lane's tokens, and the tool
name responsible for the most of it.

p50 **and** p90, not a mean: the distribution is the finding. A lane at p50 2.1k and p90 96k is
not "a bit chatty", it is one turn in ten swallowing half a context window, and a mean of 12k
would have described neither turn.

The knob here is real: the role's charter (`Role.prompt`), edited in the roster. `[Edit charter]`
opens it. There is no per-role tool allowlist — `Role` has no `tools` field (`types.ts:140-163`);
`AgentDefinition.tools` is for `.claude/agents` subagents, a different object. Do not offer a
control that does not exist.

### 3.6 Cache

Per model: a segmented bar of fresh input / cache write / cache read, the read share, tokens,
cost. `ModelUsage` already carries all four numbers (`types.ts:748-757`) and nothing reads them.

The interpretation carries this section, because the number alone means nothing to act on: cache
reads bill at roughly a tenth of fresh input, so a high read share is a lane being used well, and
a low one usually means sessions are being relaunched instead of continued. The `healthy` / `low`
chips are transparent with coloured text, and the threshold is a judgement (below ~50% read share
on a model with real volume) that should be stated in the code, not tuned invisibly.

---

## 4. Data plan — what exists, what is a join, what is new capture

This is the part Code needs. Three tiers, and only the third is new capture.

### Tier 1 — already computed, no consumer

| Needed by | Exists as | Note |
|---|---|---|
| §3.3 project split | `UsageStats.byProject` (`types.ts:764-769`, `usage.rs:294`) | ready |
| §3.6 cache | `UsageStats.byModel` (`types.ts:748-757`) | ready |
| §3.3 plan reading | `usePlanLimits` + `lib/plan-limits.ts` | ready, reuse as-is |
| §3.2 model/effort pins | `projects.json` roster + `lib/effort.ts`, `lib/model-config` | ready, renderer-side |

`getUsageStats` / `getUsageInsights` are exposed and typed (`operator-bridge.ts:394-395`,
`env.d.ts:173-174`) with **zero renderer call sites**. This page is their first consumer.

### Tier 2 — a join and a grouping, no new capture

**The key finding: lane attribution is already possible.** `usage.rs`'s per-record struct carries
`session` (`usage.rs:53`), set from the transcript filename stem (`usage.rs:149`) — which is the
Claude session UUID, the same value `SavedSession.claudeSessionId` holds (`types.ts:545`). Every
lane Operator launches gets that UUID on the command line (`claude --session-id <uuid>`), so the
join lane→spend is a `HashMap` key change, not a new field.

What Code needs to add:

1. **`UsageStats.bySession: SessionUsage[]`** — the same `Acc` fold `by_model` and `by_project`
   already do (`usage.rs:281-294`), keyed on `r.session`, carrying `{ session, slug, model,
   tokens, cost, messages, highContextTurns, turns, medianContext }`. Both shells, in lockstep:
   `src-tauri/src/usage.rs` and `electron/src/main/usage.ts`.
2. **The renderer joins** `bySession` → `sessions.json` → `roleId` + `projectId`, then groups by
   role. It has to be the renderer: the roster and the saved sessions are its data, and the usage
   module deliberately knows nothing about projects.
   - Fallback for rows whose `claudeSessionId` has rolled (the field is "latest seen", so a
     resumed lane loses its history): match `slug` → `cwd` → `SavedSession`. Weaker, since a
     worktree lane's slug is its worktree path, but it recovers the project even when it cannot
     recover the role.
   - Anything neither join reaches becomes the **Not attributed** row. Never guess.
3. **`getToolOutputStats(days)`** for §3.5 — a query over `chat.db`'s `messages.tool` JSON column
   for `output_chars` and tool `name`, grouped by session, returning p50/p90/top-tool. Persisted
   per turn already (`transcript.rs:378-391`); this is the one signal in the whole inventory that
   is both granular and historical. No new capture, one new command.

### Tier 3 — genuine new capture (one item, and only one)

4. **Compaction events.** `Track::apply` (`transcript.rs:323-328`) matches only
   `user` / `assistant` / `queue-operation`; a raw `type:"system", subtype:"compact_boundary"`
   record — carrying `trigger`, `preTokens`, `postTokens`, `cumulativeDroppedTokens`,
   `durationMs` — falls into `_ => {}`. Counting them per session fills §3.4's empty column.

   Two things ride along and are worth doing in the same change: the synthetic
   `isCompactSummary` text that follows a boundary is currently pushed into narration as an
   ordinary user prompt (it can become a session's title), and the `compacting` `SessionPhase` is
   supported by every UI surface but never emitted, because `derive_phase()` can only return
   `running` / `waiting`. Both are the same missing branch.

5. *(Optional, later.)* Per-turn **effort** from the transcript. Every assistant record carries a
   top-level `"effort"` sibling of `timestamp`/`sessionId`, and `apply_assistant`
   (`transcript.rs:480-497`) never reads it. Until then §3.2 shows the launch pin and says so,
   which is a correct v1 — this only becomes necessary when someone actually uses `/effort`
   mid-session and the table disagrees with reality.

### Suggested sequence

- **S0** — `bySession` in both usage modules + the renderer join. Ships §3.1, §3.2, §3.3, §3.6:
  four of six sections, no new capture.
- **S1** — `getToolOutputStats`. Ships §3.5.
- **S2** — `compact_boundary` capture (+ the `isCompactSummary` and `compacting`-phase fixes it
  unblocks). Fills §3.4's column.
- **S3** — per-turn effort, if it proves necessary.

The page is worth building at S0. Sections 3.4 and 3.5 render with their chips and footnotes
until their tier lands, which is the point of designing the gaps in rather than around.

---

## 5. States

All four are in the mock, bottom of the page.

- **Loading** — "Reading transcripts…", one empty track. The parse walks every project directory,
  so this is a real wait on a 30-day window.
- **Empty window** — "Nothing ran today. Widen the range, or start a lane." Names the fix.
- **Plan reading absent** — the meter's `no reading` chip and its existing copy, with the project
  split still rendering below. Absent is not zero, and one absent half does not blank the other.
- **Overflow** — lane names and project names truncate with an ellipsis; numbers never do. Every
  numeric cell is `font-variant-numeric: tabular-nums` at a fixed width, so a column stays a
  column when a value changes.

Verified in all six palettes (screenshotted in Mission Control dark and light, Mr Pink light,
1984 dark). Nothing in the layout depends on a palette being dark.

---

## 6. Rules honoured

- **Transparent badges** — every chip is `background: transparent` with a bordered outline;
  colour lands on the text and the border, never as a fill.
- **No solid accent fills for state** — the segmented range control's active option is `--fg` text
  on `--btn-bg`, matching the existing `PageShell` tab bar. Accent is used only as a bar fill,
  which is the established `PlanMeter` idiom.
- **No focus rings** — `outline: none`, with `:focus-visible` moving the border colour instead.
- **No opacity on `--fg-muted`.** The deleted view stacked `opacity: 0.6`–`0.7` on muted text in
  fourteen places, nine of them directly on `--fg-muted`; none of that is carried over.
  Hierarchy comes from the token and the size.
  Control labels (the range options, the `model · effort` cell) use
  `color-mix(in srgb, var(--fg) 72%, transparent)` — a control's label is body ink, not meta ink.
- **No coloured left-border stripe** — lane identity is a 7px filled dot.
- **No dynamic border on a radiused element** — bars carry a background and no border at all.
- **Typography** — every sentence that starts mid-line is bound to its next word with `&nbsp;`,
  so no first word is ever orphaned after a full stop, and no text block ends on a lone word.

---

## 7. Open questions for Juan

1. **The plan-fraction multiplication** (§3.3). Recommended against; one line to add if wanted.
2. **The "biggest single change" card's threshold** — 25% of the window is a guess. It decides how
   often the page says "nothing stands out", which is the difference between a page you trust and
   a page that always finds something.
3. **The plan-meter popover link** (§2) is not in the brief. It is the best entry point on offer;
   confirm before Code wires it.
