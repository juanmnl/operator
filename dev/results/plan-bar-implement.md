# Result — the session bottom-bar reading (Code lane), 2026-09-06

Brief: `dev/briefs/plan-bar-implement.md`. Design: `dev/results/plan-meter-bottom-bar.md`, mock
`dev/plan-bar-preview.html`. Branch `operator/plan-bar` from `main` at `df7bc46`.

## Gates

| Gate | Result |
|---|---|
| `npm test` (renderer) | **1095 pass / 0 fail** |
| `cd electron && npm test` | **501 pass / 0 fail** |
| `cargo test` | **192 pass / 0 fail**, 3 ignored |
| root `tsc` + `npm run build` | clean |
| electron `typecheck` + `build` | clean |
| `cargo build` | clean, zero warnings |

## One correction to the brief, from the design

The brief says the cells go in `SessionInfoBar.tsx`. **That file is dead code** — I checked before
touching it, and the only matches in `src/` were its own definition plus two comments. The real
bottom bar is `.actions-footer` in `DashboardView.tsx`, as the design says. The cells went there,
and `SessionInfoBar.tsx` is deleted, because leaving it means the next person reads it as the
bottom bar too.

---

## The three cells

**Context — `ctx 84k / 200k ▬▬ ↺2`.** The value is the latest main-thread assistant record's
`input + cache_read + cache_creation`, captured as an **assignment** beside the three `+=` that
already read those numbers. It could not be derived after the fact: `usage` is cumulative, and it
folds `cache_creation` into `input` on the way in, so the parts are not separable later. Window
from `contextWindowOf(model)` — 200k, or 1M for a `[1m]` id. Bar on the same `toneFor`/`TONE_FILL`
thresholds as the plan bars, which is what lets the eye read the strip without a legend.

`↺` shows only above zero, so its presence is the signal. `compacting…` is a **text swap, not an
animation** — motion in this app means busy, and a moving bar reads as loading.

**Model · effort.** The transcript's own effort first, the launch pin as fallback — and a value
known only from the pin takes a **1px dotted underline** and says so in its title, because there
is no room for two readings side by side in 34px. The ink does not change: this is a control's
label. Clicking opens the lane's roster entry, where both values are actually set.

**Plan — every limit named, the binding one marked three ways.** Its name goes to `--fg` while the
others stay `--fg-muted`, its bar takes `TONE_FILL[tone]` while the others take `--fg-muted`, and
a 1px straight rule sits under it. **Only the binding row is coloured** — three amber bars would
say three alarms are ringing when only one can stop you. The per-model row takes the CLI's own
label, never a hardcoded model name, and the reset clause is passed through verbatim. Clicking
opens Tuning.

---

## What happened to the rail meter, and why it is not what I first did

The design's main path removes the plan cell from the rail; its §7 q1 offers a fallback — keep the
ring — for the case where the gallery-header form (S3) is out of scope. It is, so I kept the ring
first. **That broke an invariant, and the invariant was right.**

`lib/rail-foot` asserts the resting tier is two rows of two, and that the fold's cut falls between
rows so no hairline-fenced pair is split. Tuning already occupies the slot the design expected to
free, so keeping the ring made the resting tier **five** — odd, and the pairing invariant fails.
The two decisions are coupled, and the design's own plan is the consistent one: *"the freed slot
next to Agents takes Tuning"*. So the plan cell is removed, statically, and the tier is four again.

Consequences, all deliberate:

- `PlanMeter.tsx` is **deleted**. Nothing rendered it any more, and a component kept for a future
  caller is the same dead code I had just removed `SessionInfoBar` for. `usePlanLimits` moved to
  `lib/plan-limits.ts`, which is where a data hook belongs — it was only ever exported from a
  component because that component happened to be its first caller.
- `ringDash` and `glanceLine` fall out of use with the ring. **Kept**, because `plan-limits.test.ts`
  covers them and S3 may want a ring in the header; flagged here rather than deleted silently.
- The **explicit Refresh** button goes with the popover. `usePlanLimits` already revalidates on
  focus and on visibility change, and both new entry points call `onRevalidate` on click — but it
  is a real affordance removed, not an oversight.
- `RESTING_FOOT_ITEMS` gains `tuning` and loses `usage`, and the three drivers that assert it
  (`drive-rail-invariant`, `drive-rail-foot-fold`, `drive-corner-balance`) are updated.

**A gap I introduced earlier and found here:** Tuning was rendering in the rail foot without being
in `RESTING_FOOT_ITEMS` at all, so the invariant did not know about it. Fixed in the same change.

**`dev/drive-plan-freshness.mjs` is retired**, with a header saying why: it drove the popover's
three freshness states, and the popover is gone. Those states are now `planReading`'s own return
values and unit-tested; what is genuinely lost is their rendering in a real window, because the
footer only exists inside a session and that driver boots the gallery.

---

## Tests — 23 new

The brief's three, plus the capture in both shells.

- **Context from a synthetic jsonl (4)**: the three parts of one prompt sum to 84k; the **latest**
  record wins rather than a running total; a message re-emitted as its turn streams does not move
  it; nothing before the first assistant record, which the cell reads as absent.
- **Absent is not zero (5)**: no value before the first turn and none at `0`; the 1M window so a
  long-context lane is not called 84% full at 840k; the compacting phase; the compaction count.
- **Binding-limit marking (5)**: the furthest-along row is marked and only it; the mark **moves**
  when another limit overtakes (the failure that caused the design — the arc happened to draw the
  per-model row and read as "it's only showing Fable"); every limit named; the per-model label
  comes from the reading; the reset clause is verbatim.
- **No-reading states (5)**: `no-reading` with no rows; `loading`; `window-closed` with no rows;
  window-closed **outranks** loading, because provably-false beats busy; `aging` keeps its numbers.
- **Rust tailer (4)** and **Electron tailer (3)**, in lockstep: the latest prompt not a running
  total, re-emission ignored, zero until a turn lands, and the per-session compaction count.

**One bug the tests caught, in my own change.** A search-and-replace matched two sites, so
`endCompaction` was zeroing `contextTokens` and `compactions` every time a compaction *ended* —
wiping the count the `↺` exists to show. The reset belongs only in `resetForReread`.

---

## Not done

- Nothing merged.
- **No plan reading outside a session** until the same component renders in the gallery/project
  header — the design's S3, explicitly out of this brief's sequence. This is the cost of removing
  the rail cell, and it is the design's own open question #1.
- **No GUI verification.** The cells are covered by unit tests through `lib/footer-reading`, but
  nothing rendered them: the narrowing behaviour, the dotted underline, and the three-way binding
  mark are all visual. The mock (`dev/plan-bar-preview.html`) remains the only picture.
