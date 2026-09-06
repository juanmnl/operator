# Result — the Tuning page and the capture it needs (Code lane), 2026-09-06

Brief: `dev/briefs/tuning-page.md`. Design: `dev/results/usage-view-design.md`. Branch
`operator/e78fc0`, across two commits — the build, then the Review-2 corrections in
`dev/results/pass-3-and-close-features.md`. This describes the state after both.

## Gates

| Gate | Result |
|---|---|
| `npm test` (renderer) | **1072 pass / 0 fail** — 29 in `tuning.test.ts` |
| `cd electron && npm test` | **498 pass / 0 fail** — 21 in `tuning.test.ts`, 6 in `chat-store.test.ts` |
| `cargo test` | **188 pass / 0 fail** |
| root `tsc` + `npm run build` | clean |
| electron `typecheck` + `build` | clean |

---

## Part A — capture

### Effort per record, verified before anything was built on it

The design listed per-turn effort as optional and last (S3), on the reading that it "only becomes
necessary when someone actually uses `/effort` mid-session". Before implementing I measured what
the transcripts actually carry: across 300 real files, **68,972 of 69,022 assistant records
(100%) carry a top-level `effort`**, values `high` / `medium` / `low`. It is a sibling of
`timestamp`, not a field inside `message`, which is where a reader looks first and finds nothing.

So it is not an optional extra — it is the only source for what a lane is **actually running**,
and the roster's launch pin cannot see a mid-session change. Both tailers read it, sidechain-
guarded for the same reason the model is: a subagent's effort is not the lane's. The usage engine
carries it per record and groups tokens by `(session, model, effort)`, so a lane that ran half a
window at High and half at Medium is two rows rather than one averaged row describing neither.

### Compaction, folded into the same pass

Boundaries carry no `usage`, so the existing guard dropped them. They are now collected on the
**same walk** as the usage records — a second walk over every transcript would double the cost of
the most expensive thing that module does. `postTokens` is summed as what the model must re-read;
`preTokens − postTokens` is reported separately as what was discarded, rather than one being
called "tokens" and the distinction lost.

A session whose only record in the window is a boundary still gets a row. It compacted, which is
what this page exists to show, and dropping it would make the column lie by omission.

### Per-session context, no longer discarded

Median per-turn context and the count of turns over 150k, per session — previously folded into one
global `high_context_pct` and thrown away. **Median, not mean**: one 900k turn should not describe
a lane, and a mean of `1000 / 2000 / 900000` is 301k, which describes no turn in the set.

### Tool output, from the store rather than the transcript

p50 and p90 of `ToolBlock.outputChars` per session, plus the tool responsible for the most
characters. Read from `chat.db` because **`outputChars` is the original length**, kept when the
output itself was capped at 2000 chars on the way in — measuring the stored string would floor
every large result and erase the p90 the section exists to report. p50 **and** p90, never a mean:
the distribution is the finding.

### `getTuning(days)` — one call

Four round trips over a 30-day window would let the lane table, the project split and the tool
stats each paint a different window as transcripts landed between them. Both halves share one
`sinceMs`, computed once in the handler (Review-2 residual D — they each derived their own from
`Date.now()`, seconds apart on a full scan).

---

## Part B — the page

Six sections in the design's order, one `PageShell`, `measure="grid"`, range `Today · 7 days ·
30 days`, all projects.

**The join is a lookup, not new capture.** `SessionUsage.session` is the transcript filename stem,
which is the Claude session uuid — exactly `SavedSession.claudeSessionId`, because every lane is
launched with `claude --session-id <uuid>`. A resumed lane whose uuid has rolled falls back to a
cwd match, which claims the project *and* the role from whichever saved session matched
(Review-2 C: reading the role from the uuid match alone discarded the roleId the cwd match had
already found, so a resumed lane fell to "Not attributed" while its own session sat there naming
it). Anything neither pass reaches becomes a real **Not attributed** row, which never wears a
project name — a real name there reads as "this project's lane", the one thing the row exists not
to say.

**The card ranks and never forecasts.** It fires only above 25% with a step down available, and
otherwise says so, naming the same lane and its share. A step down the effort ladder has no known
token multiplier, and inventing one would be the same class of error as showing 0% for a number
that is absent. A test asserts the copy contains none of *save / saving / cheaper / reduce / would
cost / $*.

**Context pressure states it has no knob** rather than pretending effort fixes it. **The project
split is not multiplied by the plan percentage** — different denominators, and the product would
carry the plan's authority over a number the plan never saw; the paragraph between them says so.

**Three entry points**: the plan-meter popover footer (*"What's driving this →"*), which the design
calls the highest-value one because it is the moment the question gets asked; the ⌘K palette; and
the rail foot, on the row that is already "views across projects".

---

## Verification: measured, not eyeballed

`tsc` proves it compiles. Two further checks, because neither of those proves it draws:

**`scripts/visual/capture.mjs --page tuning`** renders the real `TuningView` against the mock
fixture in headless WebKit. It timed out at first for a reason worth recording: the harness never
set `window.__visualReady`, which is what the capturer waits on — nothing was wrong with the page.
It now flags only once the lane table has painted, so the screenshot is the loaded state and not
"Reading transcripts…".

**`dev/measure-tuning.mjs`** reads the DOM, because an element screenshot frames the PageShell
scroller's viewport and therefore shows the top half and says nothing about the rest. Measured:

```
Biggest single change    height=  17px   (the h3 sits in the card's header row)
Spend by lane            height= 227px   divs=16
Project share of window  height= 169px   divs=8
Context pressure         height= 198px   divs=5
Tool output              height= 159px   divs=4
Cache                    height= 147px   divs=4

project bar: 1020px parent -> operator 859px (84%), elsewhere 161px (16%)
```

All six sections render with real boxes — the failure `chrome.test.ts` guards is a surface whose
box collapses inside its slot, which a screenshot cannot show. The stacked bar's segments are
proportionally exact against their parent.

**Two things fooled me first, and the driver now guards both.** I read the project bar as broken
from the screenshot; it measures exactly right. And my first section check used a case-sensitive
`innerText.includes`, which in WebKit tests the `text-transform: uppercase` rather than the
content, and reported four of six sections missing when all six were there.

---

## Tests — 56

- **Electron capture (21)**: effort read from the record's top level, split per `(model, effort)`,
  latest wins, absent effort omitted from the split but its tokens still counted; boundaries
  counted with re-read and dropped summed, a boundary-only session still gets a row, no negative
  dropped tokens, windowing respected, another `system` subtype is not a compaction; median and
  >150k per session, kept apart across sessions; dedup, windowing, ordering, empty window;
  percentile/median including the spiky-vs-flat distinction a mean would lose.
- **Tool output (6)**: p50/p90 rather than a mean, `outputChars` over the capped string, top tool
  by characters, sessions kept apart and ordered, non-tool turns ignored, ISO window filtering.
- **Renderer join and card (29)**: the uuid join, several sessions summing into one lane, the
  unattributed row counted and sorted last with the shares still summing to 1, the cwd fallback
  recovering project *and* role, the pin carried beside the running effort, tool percentiles
  attached, compaction and context summed; the card's firing rules including **never claims a
  saving**, the honest version at and below the threshold, at the bottom of the ladder, the
  "more than the next two" clause only when true, never naming the unattributed row; latest-by-
  time and its order-independence.

---

## Not done

- Nothing merged.
- **`byEffort` is computed, exposed and not yet rendered.** The design's lane table shows one row
  per lane with its current model and effort; the per-`(model, effort)` split is what makes a lane
  that changed mid-window visible as two rows, and that is a table shape the design does not
  specify. It is in the payload and tested, waiting on a design call rather than on code.
- **Tauri returns an empty window.** The capture is Electron-only, which is the shipping shell;
  the bridge stub answers `[]` rather than throwing, so the page renders its own empty state.
- **No verification in the packaged app.** The measurements above are against the mock fixture in
  headless WebKit. Nothing has read a real 30-day window through the real IPC, so the parse cost
  on a real transcript corpus — the reason the design specifies a loading state — is unmeasured.
