# Review — everything landed since the pinned snapshot

**Date:** 2026-07-28 · **Reviewer:** Review lane
**Baseline:** `/tmp/operator-shots/tree-snapshot-5caba7c.diff` (sha1 `3c6e327ae852`) on HEAD `5caba7c`.
**Method:** reconstructed the snapshot tree (`git archive HEAD | tar -x` + `git apply` the snapshot),
then diffed it against the live working tree. Delta reviewed: **2133 lines across 36 tracked files**,
plus **11 new untracked files** (chat-signal, chat-turns, tool-blocks, interrupt, the muted-opacity
guard, and their tests). Nothing is committed — HEAD is unchanged, so "landed" means "added to the
working tree".

**Health at review time — all green:**
`tsc --noEmit` exit 0 · `vitest run` **33 files / 237 tests** (was 29/215) · `cargo check` clean.

---

## Summary

The follow-up work is markedly stronger than the tree it landed on. Two of my three blocking findings
are fixed properly — fixing the *cause*, not the symptom — and the muted-opacity rule moved from
"swept by hand for the fifth time" to "enforced in `npm test`", which is the right answer.

The new chat/transcript work is well-designed and well-tested on the paths it tests. Its problem is
that the **tool-result pipeline is validated only on shapes that don't match production**: results are
captured, capped, given a DB column and a Rust roundtrip test — and then, in the real parse path,
**never persisted at all**, while a third of real results are stored as raw JSON instead of text.
This is the `feedback_fixtures_must_match_reality` failure mode repeating on a new feature. It isn't
user-visible *yet*, only because nothing renders tool output. It becomes visible the moment someone
builds that UI.

**Two findings from the previous review are still open** (§3 switcher toggle, §4 gallery tab).

---

## Part 1 — Verification of the previous review's findings

| Prev. | Finding | Status |
|---|---|---|
| §1 | P0 infinite render loop | ✅ **Fixed, thoroughly** |
| §2 | `AgentLibraryView` split pane collapsed in `PageShell` | ✅ **Fixed** |
| §3 | Switcher can't be closed from its own header | ❌ **Not fixed** |
| §4 | `galleryTab` never resets | ❌ **Not fixed** |
| §5 | Muted-opacity rule | ✅ **Fixed + now enforced by a test** |
| §6 | `completeTerminalTasks` roleId fallback mis-attribution | ❌ Untouched (was P2) |
| §7 | `SidebarRail` hover card unhardened | ❌ Untouched (was "confirm only") |
| §8 | Small items (stale comment, `tildePath`, dead `paddingTop`, …) | ❌ Untouched (was P3) |

### ✅ §1 — fixed at the cause, not the symptom

`DashboardView.tsx:864-871` anchors the backstop to the same source of truth as the validation effect
(`if (!projects.some(p => p.id === tab.projectId)) return`), which breaks the cycle. Critically, the
fix **also** closes the dangling data that armed it — `forgetProject` (`:469-486`) now strips the id
from `terminals` *and* `savedSessions`, so the pointer never reaches `sessions.json`, and
`forgottenProjectsRef` (`:884-887`) stops the cwd-backfill effect from silently re-adopting a project
the user just forgot. That is the complete fix, including the part I flagged as "root cause, stated
separately from the symptom". The comment records a measured reproduction (5084 scope writes before
the ceiling), which is the right kind of evidence to leave behind.

**One loose end** (P3): `forgottenProjectsRef` is never cleared. Re-open the same folder as a project
and it is registered normally — but a *legacy unscoped session* in that folder can never be
backfilled into it again for the rest of the run. Cheap fix: delete the id in `upsertProject`.

### ✅ §2 — fixed with a real seam

`PageShell` grew a `scroll?: 'page' | 'child'` prop (`PageShell.tsx:58,76,86,126`), and
`AgentsHubView.tsx:72` sets `scroll={tab === 'library' ? 'child' : 'page'}`. In `child` mode the
measure box is dropped and the body gets the remaining height and owns its own scrolling — which is
exactly what the library's two independently-scrolling columns need. The fleet tab keeps the page
scroller. Good: this is a named seam rather than a special case.

### ✅ §5 — the right fix: a guard, not another sweep

`src/renderer/lib/muted-opacity.guard.test.ts` turns the rule into a unit test. The header comment is
honest about why (swept by hand four times, count kept climbing to 63 across 23 files — *"a rule
enforced only by review is not enforced"*). The design decisions are sound: comments stripped so the
prose explaining the rule doesn't self-trip; `0` and `1` excluded so hover-reveals stay legal;
ternaries handled; and a `toBeGreaterThan(30)` assertion on the glob so the guard can't pass
vacuously — the failure mode most guards die of.

**Two coverage gaps worth naming** (P3, not defects):

- It only inspects inline `style={{ … }}` literals. A shared `CSSProperties` constant is invisible to
  it — e.g. `ProjectGallery.tsx:584 backBtn`, or `PageShell`'s own exported tokens. The rule can still
  be broken there.
- `styleObjects` counts braces without tracking string literals, so an unbalanced `{`/`}` inside a
  string would desynchronise the scan. Nothing in the tree does this today.

### ❌ §3 — still reproduces

`ProjectSwitcher.tsx:33-35` still closes on any outside `mousedown`; `Sidebar.tsx:238` is still a
`!switcherOpen` toggle. React flushes discrete events synchronously, so `mousedown` closes it and the
following `click` reads the already-updated prop and reopens it. The popover cannot be dismissed from
the control that opened it.

### ❌ §4 — still reproduces

`setGalleryTab` has exactly two references (`DashboardView.tsx:141` declaration, `:2364`
`onSelectTab`). `handleShowGallery` (`:400-409`) does not reset it. "All projects" / ⌘⇧O can still
land on the activity view with no project grid.

---

## Part 2 — Findings in the newly landed work

### 🔴 P1 — Tool output is captured, capped, given a DB column… and never persisted

`transcript.rs:143-153` (`push_narration`), `transcript.rs:242-266` (result attach),
`transcript.rs:777-780` (flush), `chatstore.rs:68-88` (`INSERT OR IGNORE`).

Two independent mechanisms each guarantee the output is lost:

```rust
// push_narration — the row that gets persisted is a CLONE, taken at tool_use time,
// when `output` is still empty:
self.pending.push((seq, entry.clone()));
self.narration.push(entry);
```

```rust
// the result handler mutates ONLY the live narration; `pending` is never touched:
if let Some(entry) = self.narration.iter_mut().rev().find(|e| …id == Some(id)) { … }
```

```rust
// …and pending is flushed and dropped:
app.state::<Arc<ChatStore>>().append(&t.session_id, &t.pending);
t.pending.clear();
```

So every `messages.tool` row lands with `output: ""`, `outputChars: 0`, `truncated: false`, and
stays that way. Even if `pending` *were* updated in place, `chatstore.rs`'s `INSERT OR IGNORE` on
`(session_id, seq)` would discard the update for an already-flushed row — the idempotency contract in
that file's header comment assumes narration entries are **immutable once pushed**, and tool blocks
are the first entries that are not.

**Failure scenario:** run a session with tool calls, quit and relaunch (or let the session reload from
`chat.db`). Every tool block's stored result is empty — permanently, since the JSONL re-parse
reproduces the same `(session_id, seq)` pairs and `INSERT OR IGNORE` refuses to correct them.

**Why the tests miss it:** `chatstore.rs`'s `tool_blocks_roundtrip` constructs a `ToolBlock` with
`output: "ok"` already set and appends it directly. It never exercises the append-then-mutate ordering
the real parser uses. `transcript.rs`'s `tool_calls_become_blocks_with_a_capped_result` asserts
against `t.narration` — the in-memory copy that *does* get mutated — and never looks at `t.pending`.
Both tests pass on a pipeline that cannot persist.

Adding `assert_eq!(t.pending.last().unwrap().1.tool.as_ref().unwrap().output, …)` after the result
arrives would have caught it, and is the assertion worth adding regardless of how it's fixed.

---

### 🔴 P1 — A third of real tool results are stored as raw JSON, not text

`transcript.rs:243-248`.

```rust
let raw = match b.get("content") {
    Some(Value::String(s)) => s.clone(),
    Some(v) => v.to_string(),     // ← JSON serialization, not flattening
    None => String::new(),
};
```

The comment above it says both shapes *"flatten to text here rather than being dropped as they were
before"*, but `v.to_string()` on a `serde_json::Value` emits **JSON**, envelope and all.

**Measured against real transcripts** (`~/.claude/projects`, files since 2026-07-01, 6909
`tool_result` blocks):

| Shape | Count | Share |
|---|---|---|
| `content` is a string | 4640 | 67% |
| `content` is an array | **2269** | **33%** |

Inner blocks inside those arrays: **3677 `text`**, **685 `image`** (base64 payloads),
186 `tool_reference`.

So for a third of all tool calls the stored output is `[{"type":"text","text":"…"}]` rather than the
text, and for the image ones it is a truncated base64 blob — noise, at 2KB a piece.

It also corrupts the cap's own accounting. Over 1396 sampled array-content results:

- median JSON-serialized length **579** vs median real text length **339**
- **608 of 1396 (44%)** exceed the 2000-char cap *only* because of JSON envelope and base64 that the
  real text would not — they get marked `truncated` and clipped when they would have fit whole.
- `outputChars` counts JSON syntax, so the UI's planned *"showing the first 2,000 of 71,194"* would
  quote a number that is not the length of anything the user can see.

The `TOOL_RESULT_CAP` rationale comment is otherwise excellent — the distribution is measured, the
alternatives (500/1000/4000) are priced, and the reasoning is recorded. That care makes the
unflattened `content` the more conspicuous gap: the cap is tuned on real text lengths and then applied
to JSON. Concatenating the `text` fields of array blocks (and dropping `image` blocks) would make the
measured knee actually apply.

---

### 🟠 P1 — `NARRATION_CAP` is 80, and tool calls now share it with prose

`transcript.rs:28` (`const NARRATION_CAP: usize = 80`), `:143-153`.

Tool calls became `NarrationEntry`s, so they now consume the same 80-slot in-memory tail as the
conversation. The cap itself is unchanged — its *meaning* changed underneath it. Two consequences:

1. **Prose is evicted much sooner.** A single agent turn routinely emits 5–15 tool calls, so the live
   tail that previously held ~40 turns of conversation can now hold a handful. Anything the UI reads
   from the live `narration` (rather than from `chat.db`) loses history at a rate that scales with how
   tool-heavy the agent is.
2. **A tool_use can be evicted before its result arrives**, and then
   `self.narration.iter_mut().rev().find(…)` silently finds nothing and the output is dropped with no
   diagnostic. Parallel tool batches plus their results can cross 80 entries inside one turn.

Either raise the cap now that entries are cheaper and more numerous, or keep tool entries out of the
capped buffer — but 80 was sized for prose and is no longer the right number.

---

### 🟠 P1 — `last_tool_name` is never cleared, so the chat signal reports a stale verb

`transcript.rs:463` (the only write), `chat-signal.ts:63-73`.

`self.last_tool_name = Some(name)` is set on every `tool_use` and cleared nowhere — not on
`tool_result`, not on turn end. `chatSignal` reads it as the running label:

```ts
const verb = toolVerb(session.lastToolName)
const base = verb ?? 'Thinking'
```

**Failure scenario:** the agent runs `Bash`, the command finishes, and the agent spends the next 40
seconds reasoning about the output. The status line says **"Running a command"** for all 40 seconds,
with a live elapsed clock next to it. The `'Thinking'` fallback is reachable only before the very
first tool call of a session — after that it is dead code.

This directly undercuts the feature's stated purpose ("chat finally says what the agent is doing").
The fix is on the Rust side: clear `last_tool_name` when `open_tools` empties — the tracker already
maintains exactly that set, one line away at `transcript.rs:267`.

---

### 🟡 P2 — The tool-output path has no consumer at all

`tool-blocks.ts:49` exports `runHasOutput`; nothing imports it. `CanvasConversation.tsx` renders tool
runs as one-line punctuation and never reads `.output`, `.outputChars` or `.truncated` — I grepped the
whole renderer, and `runHasOutput` is the only reference to any of them outside tests.

So the entire backend investment (the cap study, the DB column and its migration, the roundtrip test)
currently feeds nothing. That's a defensible sequencing choice — but it is *why* the two P1s above are
invisible today, and it means the first person to build the expand-output UI will find an always-empty
body and a JSON envelope. Worth fixing the pipeline before, not after, that UI is written.

---

### 🟡 P2 — `signal.interruptible` is declared and never read

`chat-signal.ts:19`, `interrupt.ts:5-6`, `CanvasConversation.tsx:916-935`.

`interrupt.ts`'s doc comment says the interrupt is *"Shared by the composer's stop action and the
transcript's status line so the two can never diverge into different key sequences."* Only the first
half is true: `interruptSession` has exactly one call site, `ChatComposer.tsx:307`. The transcript's
status line renders the orb, the label and the elapsed clock, but offers no stop — and
`ChatSignal.interruptible` is computed and then read by nobody.

Not a bug, but the comment asserts a shared contract that doesn't exist yet, which is the kind of
thing that reads as done in six weeks. Either wire the status line or soften the comment.

---

### 🟢 P3 — Smaller items

- **`cancelNudge` doesn't cancel queued submissions.** `submit-queue.ts:130-132` bumps a generation
  counter that only disarms the watchdog CR. A submission still waiting in the per-terminal chain when
  the user hits stop will write its payload afterwards. This matches the documented scope ("Disarm any
  watchdog CR still pending"), so it's a boundary worth knowing rather than a defect — but "stop" not
  stopping a queued dispatch is a reasonable user expectation to violate knowingly.
- **Mechanical-edit residue** from the opacity sweep: `Sidebar.tsx:267` now reads
  `color: 'var(--fg-muted)', }` (dangling comma before the brace) and `:317`
  `color: 'var(--fg-muted)', ` with trailing whitespace.
- **`forgottenProjectsRef` is never cleared** (see §1 above).
- All eight P2/P3 items from the previous review remain open, including the `RosterPanel.tsx:547`
  comment that still refers to the deleted Usage view.

---

## What I checked and found clean

- **The submit-queue cancel design.** A generation counter rather than a timer handle is the right
  call — it needs no cleanup path and cannot leak. The capture point (`const gen = …` immediately
  before the write, `submit-queue.ts:110`) leaves no window, the early return still updates `lastAt`
  so the inter-submit gap stays honest, and the per-terminal keying means stopping lane A cannot
  disarm lane B. `interrupt.ts` correctly cancels *before* writing the ESC.
- **The injected-turns filter.** `transcript.rs:285-303` moves the existing `is_injected_turn` guard
  from the session-title path to the narration path, which is the actual fix. The note explaining why
  `last_was_user_prompt` is deliberately *not* skipped (it drives phase detection, not display) is
  exactly the reasoning that would otherwise be lost. Both directions are tested —
  `injected_turns_produce_no_narration` covers all six prefixes, and `real_prompts_still_reach_chat`
  covers the `<Modal> crashes` case that a naive `<`-prefix check would have eaten.
- **The `tool_result`-is-not-a-user-turn test** (`transcript.rs:940`) closes a real hole.
- **Schema migration.** `chatstore.rs:45,52` adds the `tool` column additively, and
  `rows_written_before_the_tool_column_still_load` genuinely simulates the pre-migration schema rather
  than trusting the `ALTER TABLE`. `ToolBlock`'s serde attributes (`skip_serializing_if` on every
  optional field) keep `session:update` from bloating. This part is right.
- **`chat-turns.ts` / the empty-`thinking` decision.** Grounded in a real measurement (17,682 blocks,
  17,682 empty) and resolved the honest way: keep the parse path, render nothing, let the disclosure
  light up if Claude Code ever emits text. `CanvasConversation.tsx:516` applies `isRenderableTurn`
  *before* `coalesceTools` (`:531`), so the "Thought ▸" branch is unreachable-but-correct rather than
  a dead control on screen. `NarrationEntry.kind` is exactly the four kinds the filter handles, so
  nothing falls through silently.
- **`coalesceTools`** folds on both tool name *and* `caller`, so a subagent's reads can't merge into
  the lead's — the one thing that would have made the coalescing lie.
- **The chat measure cap.** 720 reuses `MEASURE_FORM` rather than inventing a chat-specific number,
  and the separate `MEASURE_WIDE = 960` for code and tables is the right distinction (scanned, not
  read). `resolveColor` (`CanvasConversation.tsx`) is a legitimate solution to a real constraint —
  canvas `fillStyle` parses neither `color-mix()` nor `var()` — and it cleans up its probe.
- **The muted-opacity guard's anti-vacuity assertion** — genuinely the thing most guards get wrong.
- No new `--fg-muted` + opacity violations anywhere (the guard proves it on every run now).

---

## Recommendation

The P0 that blocked committing is properly fixed, so **the five-commit split proposed in
`dev/review-working-tree.md` is now viable** — with these additions:

1. **Before the chat/transcript commit lands:** fix the two P1s in the tool pipeline (persistence,
   array flattening). They are cheap now and expensive after a UI depends on them. Add the
   `t.pending` assertion so the persistence path is actually covered.
2. **With it:** clear `last_tool_name`, and decide on `NARRATION_CAP`.
3. **Still open from the last review:** §3 and §4 are small and belong in the project-first-navigation
   commit.
4. Everything else is a follow-up and blocks nothing.
