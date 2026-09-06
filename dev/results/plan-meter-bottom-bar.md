# The plan meter, moved to the session bottom bar

Design only. Nothing was implemented; `dev/plan-bar-preview.html` is static HTML with fixture
numbers, no React and no bridge. Brief: `dev/briefs/plan-meter-bottom-bar.md` (on `main`, not in
this worktree — read from `git show`).

Open the mock with `open dev/plan-bar-preview.html`. The dashed switcher at the bottom right is
dev scaffolding; it cycles all six palettes.

---

## 1. What is actually wrong

Three separate failures, and only one of them is the idea.

**The ring cannot say what it drew.** `bindingLimit` (`plan-limits.ts:264`) is right: one arc
should say "how close am I to being stopped", which is whichever limit is furthest along. But the
rail draws that as a 12px unlabelled arc — `rail-ring-fable-only-2026-09-06.png` is the whole
control, and it is a coloured curve in a corner. When the binding row happened to be the
per-model one, the popover's third line read `Current week (Fable) 66% used` and the reading
became "it's only showing Fable". The concept survives; the rendering does not. A one-glyph
control cannot carry a three-way distinction, and no amount of tuning R and STROKE fixes that.

**The popover spends its space on the wrong thing.** In
`plan-meter-popover-2026-09-06.png`: two lines of generic copy at the top ("You are currently
using your subscription to power your Claude Code usage"), then three rows of label + bar + a
two-line reset clause each. Roughly nine lines of chrome and prose to deliver three numbers, and
the numbers are the smallest thing in it.

**It is far from the question.** "Am I about to be stopped" gets asked while watching a session
run. The rail foot is the opposite corner of the window from the session, and the answer costs a
click.

None of this is a data problem. Everything the new reading needs on the plan side already exists
and is already tested.

---

## 2. Where it goes

**The bottom bar is `.actions-footer`, in `DashboardView.tsx:4694-4739`** — not
`SessionInfoBar.tsx`. That file is dead code: it has no consumer anywhere in `src/` (the only two
matches are a comment at `DashboardView.tsx:4696` saying the footer "replaces the old
SessionInfoBar strip" and a passing mention in `lib/local-time.ts:24`). It should be deleted in
the same change, or it will keep being read as the bottom bar by the next person who looks.

The footer is 34px, `border-top: 1px solid var(--border)`, buttons at 10.5px
(`styles.css:405-434`). It already ends in a right-aligned working-directory label. The reading
goes after that label, as three cells separated by hairlines:

```
[Terminal] [Review] [Activity]      ~/…/operator-3f9880 │ ctx 84k / 200k ▬▬ ↺2 │ Opus · High │ Session 17%  Week 42%  Fable 66%
```

Right to left, that is: this session's context, what it is running, and the plan. Ambient
telemetry sits in the corner; the session's own numbers sit nearer the session.

**What leaves.** The plan cell comes out of the rail foot, and the popover goes with it. The
number then lives in exactly one place. Two consequences worth stating:

- The rail foot's own header comment defends its position: the rail persists at the gallery and
  on first launch, "exactly when someone deciding what to launch wants to know what's left." That
  argument still holds, and the footer does not render outside a session
  (`contentMode === 'localTerminal' && activeSession`). So the same component renders in **two
  places that are never both on screen**: the session footer, and the gallery/project header
  strip. That is what keeps "the number lives once" literally true.
- Removing the cell takes the rail foot from eight items to seven, **statically**. Do not make it
  conditional on there being a session: `lib/rail-foot` and `dev/drive-rail-invariant.mjs` assert
  which items are present at rest, and the fold work exists precisely because items used to
  appear and disappear. A static removal needs the drivers updated; a conditional one breaks the
  invariant they defend. The freed slot next to Agents takes **Tuning**, which the Tuning design
  already asked for — so the rail keeps a route to the numbers without carrying them.

---

## 3. The three cells

### 3.1 Context — `ctx 84k / 200k` + bar + compaction count

- **Value**: the latest assistant record's `input + cache_read + cache_creation`. This is the
  live prompt size, and it is the number that decides whether the lane is about to compact.
- **Window**: 200,000, or 1,000,000 when the model id carries the `[1m]` variant marker.
- **Bar**: the same `toneFor` / `TONE_FILL` thresholds as the plan bars — accent below 75, amber
  past 75, red past 90. Using one language for both is what lets the eye read the whole strip
  without a legend.
- **Compactions**: `↺2`, and only when the count is above zero, so its presence is itself the
  signal. Title spells it: "compacted twice this session".
- **Absent**: before the first assistant turn there is nothing to measure. `ctx — / 200k` with a
  bare track. Never `0k`, and never a full-looking bar — the same rule the plan meter already
  keeps.
- **Compacting**: when `phase === 'compacting'` the value is replaced by the word `compacting…`
  in `--status-compacting`, and the bar draws empty. This is the one moment the bar changes while
  you watch, and it is a **text swap, not an animation**: motion in this app means busy, and a
  moving bar reads as loading (`PlanMeter.tsx`'s own note on its ring).
- Not a button. It describes this session and there is nothing to open.

### 3.2 Model · effort — `Opus · High`

The observed readings: `runningModel` and, on `operator/e78fc0`, `AgentSession.effort` — the
value the transcript reports, which a mid-session `/effort` changes and the launch pin does not
know about.

`lane-meta.ts`'s rule applies, one altitude down: a value carries its provenance. There is no
room in a 34px strip for two readings side by side, so **a value known only from the launch pin
takes a 1px dotted underline** and says so in its title. The ink does not change — this cell is a
button, and a control's label stays body ink, never `--fg-muted` and never a stacked opacity.

Clicking opens this lane's roster entry, which is where the two values are actually set. Every
number in this design leads to a knob or admits it has none; these two have one.

### 3.3 Plan — every limit named, the binding one marked

```
Session 17%     Week 42%     Fable 66%
▬▬░░░░░░░░      ▬▬▬▬▬░░░░    ▬▬▬▬▬▬▬░░
                             ─────────
```

- **Spell the names.** `S / W / F` is the ambiguity that caused this brief. Three named limits at
  ~200px of 9.5px mono is affordable, and it makes "it only shows Fable" impossible to think.
  The per-model row takes the CLI's own label (`limitRows`, `plan-limits.ts:249`) — never a
  hardcoded model name.
- **The binding one is marked three ways at once**, none of them a fill: its name goes to `--fg`
  while the others stay `--fg-muted`, its bar takes `TONE_FILL[tone]` while the others take
  `--fg-muted`, and a 1px rule in the tone colour sits under it. A straight rule, so it never
  lands on a radiused edge.
- **Only the binding row is coloured.** A non-binding row at 78% still draws muted — three amber
  bars would say three separate alarms are ringing when only one of them can stop you.
- **Reset clause on hover**, verbatim, on the binding row (`resets Sep 8 at 12:59am
  (America/Guayaquil)`). Verbatim because it is already localised and already carries its zone;
  re-deriving it is how you print the wrong hour (`plan-limits.ts`'s own rule).
- **The subscription sentence is cut.** It explained where the number comes from to someone who
  had already opened a popover to read it. That explanation belongs on Tuning, one click away.
- **Clicking opens Tuning.** This answers open question #3 of `dev/results/usage-view-design.md`,
  which proposed a "What's driving this →" link from the popover: there is no popover now, so the
  cell itself is the link.

---

## 4. States

| State | Context cell | Plan cell |
|---|---|---|
| No turn yet | `ctx — / 200k`, bare track | unchanged |
| Compacting | `ctx compacting…`, bare track | unchanged |
| Plan absent | unchanged | `plan [NO READING]` — a transparent chip, no bars, no percentages |
| Plan expired / window closed | unchanged | `plan [WINDOW CLOSED]` in amber ink |
| Plan aging (past the 5-min TTL, inside the hour) | unchanged | numbers stay, one amber dot precedes them; title carries the age |
| Loading | unchanged | `plan …` |

**No data never renders as 0%**, in any cell. That rule is already load-bearing in
`plan-limits.ts` (`readable`, `hasData`, `hasCurrentData`) and this design does not touch it —
it only changes what the three freshness states look like when there is 34px instead of a
popover. An aging reading keeps its numbers because they are still the best thing available and
a dot is the only warning there is room for; an expired one shows no percentage at all, because
by then we genuinely do not know.

### Narrowing

What drops, in order, as the footer narrows: the working directory (it truncates first, then
goes), then the model · effort cell (the lane's hover card and its orb both also carry those
two), then the two non-binding limits shorten to initials. **The binding limit keeps its full
name at every width** — naming it is the entire fix — and the context cell never drops. Numbers
are `tabular-nums` at fixed widths, so a column stays a column when a value changes.

---

## 5. Data plan

Split cleanly: the plan half needs **no new code at all**, the context half needs **three
assignments**.

### Already there — the whole plan cell

| Needed | Exists as |
|---|---|
| The three named rows + their reset clauses | `limitRows` (`plan-limits.ts:238-251`) |
| Which one is binding | `bindingLimit` (`plan-limits.ts:264`) |
| Thresholds and fills | `toneFor` / `TONE_FILL` (`plan-limits.ts:26-40`) |
| Absent / aging / expired | `hasCurrentData`, `freshnessOf`, `windowEnded`, `updatedAgo` |
| Fetch, cache, revalidate on focus | `usePlanLimits` (`PlanMeter.tsx:276+`) |

The plan cell is a re-render of functions that are already written and already tested. Two
helpers fall out of use with the ring: `ringDash` and `glanceLine`. Delete them with it unless
the gallery form keeps a ring.

Dropping the popover also drops its explicit **Refresh** button. That is acceptable because
`usePlanLimits` already revalidates on window focus and on visibility change, and Tuning can
carry an explicit refresh — but it is a deliberate loss, not an oversight.

### Three assignments in `transcript.rs`

1. **Context size — a new field, because the existing one cannot answer.**
   `AgentSession.usage` is **cumulative**: `transcript.rs:562-564` on `operator/e78fc0`
   (`:493-495` on `main`) does `self.usage.input += …` once per API response. A running total can never give the latest prompt size. Worse for
   recovery, `cache_creation_input_tokens` is folded into `usage.input` on the way in, so the
   components are not separable after the fact.
   The fix is one line in the block that already reads all three numbers — an **assignment**
   beside the three `+=`:
   `self.context = g("input_tokens") + g("cache_read_input_tokens") + g("cache_creation_input_tokens");`
   surfaced as `AgentSession.contextTokens?: number`. Both shells in lockstep
   (`src-tauri/src/transcript.rs`, `electron/src/main/transcript.ts`).

2. **Compaction count — one increment.** On `operator/e78fc0`, `apply_system`
   (`transcript.rs:512-518` on that branch) already matches `type:"system", subtype:"compact_boundary"` and sets
   `self.compacting = true`. Adding `self.compactions += 1` in the same branch, surfaced as
   `AgentSession.compactions`, is the whole change. Note that `SessionUsage.compactions`
   (`types.ts:830` on that branch) is a *windowed historical* count from the usage module — a
   different number from "this session, right now", and not a substitute for it.

3. **Effort — already landed.** `AgentSession.effort` (`types.ts:113` on `operator/e78fc0`) is
   read in `apply_assistant` from the record's top-level `effort` field, present on 68,972 of
   69,022 sampled assistant records. Nothing to do.

### One new helper

No context-window constant exists anywhere in the repo — grep for `200_000` / `contextWindow`
returns only unrelated test timings. A small `contextWindowOf(model)` is new: 200,000 by default,
1,000,000 for a `[1m]` id. Keep it beside `lib/model-config`, which already owns model
identity, rather than inlining `200000` at the render site.

### Sequence

- **S0** — the plan cell in the footer, the rail cell and popover removed, `SessionInfoBar.tsx`
  deleted. No backend work; ships the fix that this brief is actually about.
- **S1** — `contextTokens` + `contextWindowOf`, ships the context cell.
- **S2** — `compactions`, ships the `↺` count.
- **S3** — the same reading in the gallery/project header, for the no-session case.

S0 alone answers the screenshots. Everything after it adds the session's own half of the strip.

---

## 6. Rules honoured

- **Transparent badges** — the two plan chips are `background: transparent` with a bordered
  outline; colour lands on the text and the border.
- **No solid accent fills** — the binding limit is marked with ink, a bar fill and a 1px rule,
  never a filled background. Cells are borderless at rest and take `--overlay-subtle` on hover,
  matching the rail cells; a 34px strip already has three bordered buttons in it.
- **No focus rings** — `outline: none`, with `:focus-visible` taking the same hover overlay.
- **No opacity stacked on `--fg-muted`** — the muted limits are the token alone. The
  model · effort label, being a control's label, uses
  `color-mix(in srgb, var(--fg) 72%, transparent)`.
- **No dynamic border on a radiused element** — every bar carries a background and no border, and
  the only colour-changing rule in the design is 1px and straight.
- **No coloured left-border stripe** anywhere.
- **Typography** — sentence starts are bound with `&nbsp;` so no word is orphaned after a full
  stop, and no text block ends on a lone word.

Checked in all six palettes; screenshotted in Mission Control dark and light and 1984 dark. On
1984 the danger tone is that palette's own `--color-error` (a magenta-pink, not a red) — correct
by construction, because the tone comes from the token rather than from a literal.

---

## 7. Open questions

1. **The no-session case** (§2). Recommending the same component in the gallery/project header
   rather than keeping a reduced ring in the rail. If that header change is out of scope, the
   fallback is to leave the ring in the rail foot and accept the number appearing twice inside a
   session — which is the thing this design set out to stop.
2. **`↺` for the compaction count.** It reads at the zoom level in the mock and is unambiguous
   with its title, but it is a glyph carrying a word. The alternative is dropping the count from
   the bar and leaving compaction pressure to Tuning's own section, where it already has a row.
3. **Losing the explicit Refresh** with the popover (§5). Recommended, since the hook already
   revalidates on focus, but it is a real affordance being removed.
