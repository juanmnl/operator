# Composer controls, and how you choose a model

Answers `dev/briefs/composer-controls-and-model-picker.md`. Design only — no code changed.

Two of the four asks turned out to be **already built**, one turned out to be **built on a
mechanism that does not exist**, and the one the brief most wanted has a real ambiguity that the
shipped design creates rather than solves. That reordering is the result.

---

## 0. What already exists (do not rebuild it)

`ChatComposer.tsx` already ships: attachments (drop/paste/pick, chips, temp-path append), a Model
pill → `PopMenu` → `/model <id>` with a free-typed **Other…** row, an Effort pill → global
`settings.json`, a slash-command menu, auto-grow to a 140px cap, and a send/stop orb wired to
`chatSignal` + `interruptSession`. `PopMenu` + `lib/use-dismiss` are the shared popover with the
full dismissal contract. The brief's items 3 (picker as popover) and most of the Send/Stop control
are **done**.

So the deliverable is the delta, and the delta is four things.

---

## 1. Send → Steer → Stop — the ambiguity is real, and it is ours

### The defect as it stands today

The orb is Send when idle and Stop when busy. But `send()` never checks `busy` — so **while the
agent is running, Enter sends into the turn and the button next to it stops the turn.** The
composer even admits this: it prints `↵ sends into this turn` beside a control whose glyph is a
stop square. The keyboard and the mouse, six pixels apart, do opposite things.

That is worse than the hazard the house rule names. Two verbs sharing a glyph is bad; two verbs
sharing a *position* while a caption advertises the third is the same bug with a footnote.

There is a second reason to move it. The orb's core is `StatusWave` — the same orb the sidebar,
roster and gallery use. Making the thing that *tells you the lane is alive* also the thing that
*stops it* means you cannot glance at the lane's state without a destructive target under the
cursor.

### The principle

> **The orb is the Enter key made visible. Enter never stops, so the orb never stops.**

Everything follows from that one line, and it is the whole answer to "how do you keep it
unmistakable": Send and Steer are one verb (deliver this text) with two consequences; Stop is a
different verb, and it gets a different glyph, a different label, **and a different place on
screen**. It never appears where Send was a moment ago.

### The state table

| lane | draft | control on the right | glyph | ring | caption |
|---|---|---|---|---|---|
| idle / waiting | empty | status light — **not a button** (`cursor: default`, `aria-disabled`) | none | none | — |
| idle / waiting | text | **Send** | arrow ↑ | `accent 55%` | — |
| running / compacting | empty | status light (orb animates — that IS the busy signal) | none | none | — |
| running / compacting | text | **Steer** | arrow ↑ over a 6px baseline bar | `accent 55%` | `Steers into this turn` |
| no live session | any | grey, `opacity .45`, `aria-disabled` | none | none | — |

Send and Steer differ three ways at once and none of them is a new idiom: the glyph gains a
baseline (arrow *into* something), the caption appears in exactly that state and only that state,
and **the orb core is already animating**, because the lane is busy. Motion stays the single busy
language — I am reading it, not adding to it.

`↵ sends into this turn` → `Steers into this turn`. Same fact, but it names the control instead of
describing the key, which is what makes the button and the caption obviously the same thing.

### Where Stop goes

**Back onto the status line, attached to the phrase it stops.**

```
◐ Editing   0:14                                        [ ■ Stop ]
┌──────────────────────────────────────────────────────────────────┐
│ Message the agent…                                               │
│ [📎] [/] [ Opus ▾ ] [ Effort · High ▾ ]     Steers into this turn ( ◉ ) │
└──────────────────────────────────────────────────────────────────┘
```

This **overturns the note at `CanvasConversation.tsx:1108-1110`** ("its STOP moved into the
composer's orb, because two stop controls on screen at once is one too many"). That decision was
correct *given* an orb that was Stop; there would have been two. Once the orb is send-family only
there is still exactly one Stop — it has just moved next to the running phrase and the elapsed
clock, which is the thing it acts on. The status line sits directly above the composer on the same
measure and centre line, so nothing moved far.

Stop is **labelled, not icon-only** (the brief's requirement, and the reason the square alone was
never enough): a small pill, `■` + the word `Stop`, mono 10px, border
`color-mix(in srgb, var(--color-error) 45%, var(--border))`, text `var(--fg)`, transparent
background. **Never red ink** — `--color-error` measures 2.81:1 on 1984-light; it carries the
border and nothing else. Rendered only when `signal.interruptible && live`, which is a strict
subset of when the status line renders at all, so it never appears alone.

### Stop has to admit when it fails

`dev/qa-chat-stop.md` is unambiguous: a single `\x1b` interrupts Claude Code reliably under our
exact pty recipe, mid-reasoning *and* mid-tool-call — so `INTERRUPT_SEQ` is right and the bug lives
between the click and the byte leaving our process. Until that is instrumented, Stop is a control
we know sometimes does nothing, and the design has to be honest about it:

- **on click** → label becomes `Stopping…`, control disabled. **No spinner** — motion is the busy
  signal and a second one here is exactly the competing language the brief forbids.
- **resolves** when `signal` leaves running/compacting (the status line changes on its own).
- **after 2500ms with no phase change** → label becomes `Stop again` (re-enabled) and a mono line
  appears under it: `No response yet — Esc in the terminal also interrupts.`
- **never auto-fires a second ESC.** The submit queue's own doctrine — "each extra keystroke is
  another chance to split something" — applies to interrupts too.

**A finding to hand on, not to design around:** `lib/interrupt.ts` records that Claude Code
restores the interrupted draft *into its own composer*. Our next chat send is a bracketed paste
into that same composer, so it concatenates onto the restored text — the v0.9.0 bracketed-paste
merge gotcha, reached by a new route. I am not designing a fix (Operator cannot read the TUI's
composer, so any fix is a guess); the design contribution is a one-line advisory in the caption
slot for ~6s after a confirmed stop: `Stopped — your last message is back in the agent's input.`
QA should confirm the concatenation before anyone builds a clearing keystroke.

---

## 2. The pills — and the one that has to be cut

### Verbosity has no carrier. Cut it.

I went looking for what a Verbosity pill would actually write, and there are only three candidates:

1. **A `verbosity` setting** — does not exist. Nothing in `ClaudeSettings`, nothing in the CLI.
2. **`--verbose` / `verbose`** — real, but it is the *TUI's tool-output display* flag. Operator's
   chat panel renders the transcript, not the TUI, so this pill would change nothing the user can
   see in the surface the pill lives in.
3. **`outputStyle` / `/output-style`** — the nearest response-shaping control, and it is
   **deprecated**. The official plugin's own README says so verbatim: *"This plugin recreates the
   deprecated Explanatory output style as a SessionStart hook"*, and gives the `outputStyle` JSON as
   the thing you migrate *away* from. Separately, Claude Code's settings docs list `outputStyle` as
   one of only two keys that do **not** auto-reload — it needs a restart — so even undeprecated it
   would silently not apply to the running lane.

Shipping it anyway is `feedback_fixtures_must_match_reality` with the mock replaced by a hopeful
label: a dial that promises response length and moves nothing. **Two pills, not three.**

### What belongs in the freed slot

**Permission mode.** It is real (`--permission-mode`, already resolved per-lane by
`resolveAgentConfig`), it is the single most consequential per-lane setting, and it is currently
invisible in chat — you cannot tell a `bypassPermissions` lane from a `default` one while typing
into it. Reserve the slot; **do not build it until someone confirms the live-change carrier** (the
launch flag is certain, a mid-session change is not — `/permissions` and the TUI's shift-tab cycle
are the candidates). Same discipline that cut Verbosity.

### Layout, and the collapse ladder

Order, left to right: `📎` `/` · `Model` `Effort` · spacer · caption · orb. Attachments and
commands are *acts*, model and effort are *config*, and the config sits nearer the send end because
it is what you check before pressing Enter.

The composer is capped at `MEASURE_FORM` (720). It gets narrower than that in a split pane, so:

| row width | Model | Effort |
|---|---|---|
| ≥ 520px | `Opus ▾` | `Effort · High ▾` |
| 400–520px | `Opus ▾` | `High ▾` |
| < 400px | `Opus ▾` | folded into the Model pill: `Opus · High ▾`, one popover, two sections |

**Model never collapses away.** It is the lane's identity; Effort is the adjustable. The popover
titles (`Model`, `Reasoning effort`) already carry the meaning the dropped labels were carrying, so
the ladder loses nothing.

### The popover

`PopMenu` as-is — it has the dismissal contract, the opaque `--bg-surface` and the upward anchor.
Three additions, all inside its existing `hint` / `footer` slots:

- **Model — show the resolved id as the active row's hint.** `Opus` on the left, `claude-opus-5` in
  muted mono on the right, read from `session.model` once the transcript backfills it. This is the
  model-tier-freshness note made *visible*: the alias auto-updates and the user gets to see which
  point release they landed on, rather than trusting a four-item list.
- **Effort — a footer that states the scope.** `pickEffort` writes the **global** settings file, so
  changing effort from one lane's composer changes the default for every future lane in every
  project. Nothing on screen says so. Footer: `Global — applies to new turns in every lane.`
  (Honesty fix for a shipped control; cheapest possible.)
- **Keep `Other…` exactly as built.** It is the degradation path the brief demands, and it already
  works: a hand-typed id goes out as `/model <id>` and Claude Code validates it. No release needed
  the week a new tier ships.

### The catalog stays un-baked

comet bakes model and reasoning catalogs into app state; that is the part not to copy, and we
already don't. The rule I would write down:

> **A list Operator hardcodes must be a list of *aliases*, never of *versions*, and must always
> have a free-typed escape.** `opus`/`sonnet`/`haiku`/`fable` resolve themselves; a `claude-opus-5`
> in our source goes stale on release day.

The four-item list plus `Other…` satisfies this. A future provider axis fits without redesign: it
becomes a **section header inside the same popover**, not a new pill and not a new control — the
pill still reads `Opus`, because the model is what you chose and the provider is where it came
from. Designing for that costs nothing today; **building it is still deferred and I have not.**

---

## 3. Drafts

We lose composer text on every lane switch today (`useEffect` on `session?.id` clears it), and the
loss is silent.

- **Scope:** per session id.
- **Survives:** lane switch, Console⇄Chat toggle (⌘J), panel remount, **and app restart**.
- **Storage:** one key, `operator.chatDrafts`, holding `Record<sessionId, string>` — matching the
  `operator.*` convention, and one key rather than N so eviction is a single write.
- **Attachments: in-memory only**, a module-level `Map<sessionId, Attachment[]>`. They survive a
  lane switch; they do **not** survive a restart, and that is deliberate — the object URLs die with
  the page, so a persisted chip is a chip with a broken preview. Restoring nothing beats restoring
  a ghost.
- **Restore:** caret to end. **Do not auto-focus** — focus follows the user's action, and stealing
  it on every switch would break ⌘1-9 stepping through lanes.
- **Cleared on:** a successful send. **Not** on interrupt, not on session switch, not on blur.
- **Evicted on:** hydrate — drop every key whose session id is not in the live session list. Without
  this, localStorage accrues one entry per lane the user ever opened.
- **Untouched by dispatch:** a dispatch landing on this lane writes to the pty via `submitQueue`,
  never through composer state, so it cannot eat a draft. (Verified by reading the path, not
  assumed.)

Model/effort pill state is already re-seeded per session on switch — leave it exactly as it is.

---

## 4. Deliberately left blocked: the QuestionPanel

**Not designed. Blocked on `dev/briefs/stream-json-alongside-pty-RESULT.md`, which does not exist
yet** (Research has the brief; no result file on disk as of this writing).

The dependency is not cosmetic. A panel that *displaces* the composer is only safe if we know,
reliably, that the agent is asking something — displacing the composer on a false positive takes
away the user's ability to type at the exact moment they want to. Over stream-json that is a typed
`requestInput` event. Over our pty it would be **scraping a TUI**, and `dev/qa-chat-stop.md`
records precisely why that is a trap: Claude Code draws words via cursor-column jumps, so
`esc to interrupt` arrives in the byte stream as `esctointerrupt` and `⏺ Bash(` has its glyph and
its word non-adjacent. Any detection string built from what you would expect to *read* is silently
wrong — QA got wrong results twice before catching it.

So I have not sketched it, and I would not accept a sketch as a reason to start. The gate is
Research's answer to the one question that decides it (can one `claude` process be both a pty TUI
and a stream-json pipe). If the answer is (a) — per-session choice — the QuestionPanel is a
feature of *structured lanes only*, and that is a different design brief than this one.

Everything in §1–§3 is buildable on the pty today with no new plumbing.

---

## 5. Verification the implementer owes

Not optional, and two of these are where this composer already has debts:

- **Six palettes**, via `dev/drive-theme-pass.mjs` (all 6 + contrast table). Specifically: the Stop
  pill's border on the three light palettes, and the `accent 55%` ring on Mission Control (green on
  near-black) vs 1984-light.
- **The caption's ink is a bug today.** It renders at **9.5px `var(--fg-muted)`** — and the status
  line six pixels above it deliberately uses `--fg` *because* muted at 11px measured 4.16:1 on Mr
  Pink light and 4.30:1 on 1984 light, under the body floor. Muted at 9.5px is strictly worse than
  the thing already rejected. Take the caption to **10.5px** and
  `color-mix(in srgb, var(--fg) 74%, transparent)` — the established `.op-lbl` recede, and *not*
  opacity stacked on `--fg-muted`, which is forbidden outright.
- **Six control states**, each in light and dark: empty · text · busy+empty · busy+text ·
  stopping · no live session.
- **Overflow:** a draft past the 140px grow cap (scrollbar appears, controls do not move); 6+
  attachment chips wrapping; a free-typed model id long enough to overflow the pill (ellipsis, pill
  does not grow past 1/3 of the row).
- **Narrow:** the collapse ladder at 520 / 400 / 340px, no horizontal overflow, Stop still hittable.
- **The reversal itself:** confirm no state exists in which Stop occupies a pixel that was Send or
  Steer within the last frame. That is the house rule, checked directly.

---

## Summary of the calls

1. **The orb is the Enter key made visible; it is never Stop.** Send / Steer / status-light.
2. **Stop moves to the status line**, labelled, next to the phrase and clock it acts on —
   overturning the `CanvasConversation:1108` note, which was right about its own premise.
3. **Stop admits failure**: `Stopping…` → `Stop again` + the terminal escape hatch at 2.5s, no
   auto-retry, no second motion idiom.
4. **Verbosity is cut** — no carrier exists; `outputStyle` is deprecated *and* restart-only. The
   slot is reserved for **Permission mode**, unbuilt until its live carrier is confirmed.
5. **Two pills, one collapse ladder**, `PopMenu` unchanged plus three honesty additions (resolved
   model id, "Effort is global", `Other…` kept).
6. **Drafts persist per session across restart**; attachments deliberately do not.
7. **QuestionPanel not designed** — blocked on Research, and the TUI-scraping trap is documented
   above so nobody starts it on a hunch.
