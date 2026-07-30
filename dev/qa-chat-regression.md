# QA: chat view regression — against real data

**Scope:** cap/freeze, orb send/stop states, interrupt-then-no-resubmit, pre-existing
history rendering. **Verdict: 19/19 scripted checks pass + 238/238 unit tests pass.**
No regressions found. One gap flagged (not a bug): the new structured-transcript `tool`
kind has never been exercised against real persisted data, because the code that writes
it is still uncommitted.

## Method — real data, not the mock

`dev/mock-bridge.ts`'s fixtures (`MOCK_CHAT`, `MOCK_SESSIONS`) are hand-authored and,
per `feedback_fixtures_must_match_reality`, have burned this project before (a mock more
generous than reality validated a feature that couldn't work). So this pass used a
**separate, real-data bridge** instead:

- `dev/qa-extract-real.mjs` — pulls the actual live `~/.operator/projects.json` roster
  for this "operator" project (the same 6-lane roster this session runs under) and two
  **real** `~/.operator/chat.db` histories via the `sqlite3` CLI:
  - `e5893b67-e01f-40ee-b2b4-3e7e52bb3757` — 862 real messages, this project, a session
    that predates this QA pass.
  - `a1d8d389-0774-451f-87d1-445a2a2f8863` — 114 real messages, a real Research-lane
    session (roleId, model, effort all genuine), including a real 10,268-character answer
    (the largest single message anywhere in this project's chat.db).
- `dev/qa-real-bridge.ts` — same shape as `mock-bridge.ts` (installs `window.operator`,
  exposes `__mockPhase`/`__calls` the same way) but serves that real data instead of
  authored fixtures.
- `dev/qa-real.html` / `dev/qa-real-main.tsx` — boots the **real, unmodified** `App`
  against it, same pattern as `dev/mock.html`.
- `dev/qa-drive-real-chat.mjs` — Playwright/WebKit driver, run against a throwaway
  `vite --port 1445` instance.

The extracted fixture JSON (437KB of the user's real conversation history) was deleted
after the run; only the extractor/bridge/driver code is left on disk (untracked, not
committed), matching the project's established throwaway-harness convention
(`dev/qa-terminal-regression.md`'s soak rig).

**What's genuinely real vs. driven:** chat content, session metadata (cwd, roleId,
model, effort), and roster are all real, unmodified data. Session `phase` is pushed
through the same `onSessionUpdate` callback mechanism the real Rust backend uses (there's
no way to attach to the live app's actual IPC channel from outside it), so phase
transitions are driven, not literally observed from a live agent — this is the same
technique `dev/drive-chat-signals.mjs` already uses and is the standard way this project
tests chat liveness without full GUI automation access.

## Results

### 1. Orb send/stop/idle states — 9/9 pass

Full real phase matrix from `chat-signal.ts` (`running`/`compacting`/`waiting`/`idle` ×
`status: active|ended`, crossed with empty/non-empty draft):

| state | draft | want | got |
|---|---|---|---|
| running, no tool ("Thinking") | empty | stop | stop |
| running, Bash tool | empty | stop | stop |
| running + 2 subagents | empty | stop | stop |
| compacting | empty | stop | stop |
| waiting | empty | idle | idle |
| waiting | "hello" | send | send |
| idle | empty | idle | idle |
| idle | "hello" | send | send |
| ended | empty | idle | idle |

All 9 real states produced the correct `data-composer-action`. The three-way orb
(status-light / send / stop) added since the last chat pass holds up: `busy` is true
only for `running`/`compacting` (matches `interruptible` in `chat-signal.ts`), and the
idle-vs-send split on empty/non-empty draft is exactly right.

### 2. Interrupt-then-no-resubmit — 3/3 pass, through the REAL production code path

This is the regression the last QA pass (`dev/qa-chat-stop.md`) flagged as the likely
site of the original stop-button bug, and `submit-queue.ts`'s own docstring names
explicitly: `interruptSession` must call `submitQueue.cancelNudge(terminalId)` **before**
writing ESC, or the submit queue's watchdog rescue-CR (`SUBMIT_NUDGE_MS`, up to 6s for
long messages) fires after the interrupt, resubmits Claude Code's restored draft, and the
agent starts the same work again — "indistinguishable from stop did nothing."

Reading the current `lib/interrupt.ts`, that call **is present**:

```ts
export function interruptSession(terminalId) {
  if (!terminalId) return
  submitQueue.cancelNudge(terminalId)      // disarm BEFORE the ESC
  window.operator.terminalWrite(terminalId, INTERRUPT_SEQ)
}
```

This test drives that exact chain end to end — real `<textarea>` fill, real `Enter`
keypress (→ real `send()` → real `submitQueue.submit()`), real orb click (→ real
`interruptSession()`) — and records every `terminalWrite` call with real wall-clock
timing against the real `nudgeDelayFor()` windows:

| case | when interrupted | result |
|---|---|---|
| short message ("short interjection") | 150ms after submit (well inside the 800ms floor nudge window) | `[paste+CR, ESC]` — **no stray `\r`** |
| long message (2000 chars, 3800ms scaled nudge window) | ~1520ms in (mid-window) | `[paste+CR, ESC]` — **no stray `\r`** |
| control: same short message, **no interrupt** | n/a | `[paste+CR, \r]` — the legitimate rescue CR **still fires** |

The control case matters as much as the other two: it proves `cancelNudge` only
suppresses the nudge when an interrupt actually happens — the fix didn't neuter the
watchdog feature it's guarding (`submit-queue.test.ts`'s existing 15 unit tests cover the
same logic in isolation; this exercises it live, through real UI events and real timers,
which is the part those unit tests can't reach).

**Conclusion: the fix holds.** No resubmit in either the tight or the scaled-window case.

### 3. Cap/freeze — 3/3 pass

`project_chat_markdown_freeze.md` documents the original bug (react-markdown re-parsing
an 80KB GFM table every render, ~21s to parse once) and its fix in the OLD DOM
`ConversationPanel` (memo + hard 16KB plain-text cap). The current `CanvasConversation.tsx`
replaced that renderer entirely — its own comment claims the new parse-once +
virtualized-paint design needs **no size cap at all**. This pass checked that claim
against real data plus a synthetic reproduction of the documented failure trigger:

- **Real 10,268-char answer** (the largest real message in this project's chat.db):
  loaded in 2ms, rendered **in full, untruncated** (`longest rendered turn=10268`,
  matching the source exactly — confirms no cap silently truncates it), and a
  `requestAnimationFrame` round-trip immediately after measured 7ms — the main thread
  kept pumping frames, i.e. no freeze.
- **Synthetic 57KB GFM table** (900 rows × 5 columns — a same-order-of-magnitude
  reproduction of the exact table shape that pegged WebContent at 98.8% CPU in the old
  renderer), injected via the same live `onSessionUpdate` path a real streaming answer
  would use: settled in 1.2s, next-frame time **0.0ms** — no measurable main-thread
  impact at all. Note: no real message in this project's chat.db actually reaches this
  size (10.3KB was the real max) — this case is a deliberate stress addendum, not real
  data, included because "measure cap" is explicitly about probing the documented
  failure class, not just replaying what happens to already exist.

The "no size cap" design claim holds under both real content and a synthetic
reproduction of the specific pathological input that broke the old renderer.

### 4. Pre-existing history rendering — 4/4 pass

Cold-loaded the real 862-message session (no live agent behind it — a genuinely
historical, "pre-existing" conversation, which is what most sessions a user reopens
actually are):

- Loaded in **~1.0-1.1s** with **zero console/page errors**.
- 862 raw rows → **846 rendered turns**. The 16-row gap is exact and accounted for: this
  session's real chat.db data contains 16 rows matching `isInjectedTurn`'s full prefix
  set (`<local-command-`, `<command-name>`, `<command-message>`, `<command-args>`,
  `<system-reminder>`, `<task-notification>`, `<synthetic>`) — Claude Code's own injected
  plumbing lines, never typed by the user. `117 user rows − 16 noise = 101`, which is
  exactly what rendered. **No real content was dropped; only the intended noise was
  filtered**, and confirmed none leaked through as a fake user turn.
- Scrolling the resulting canvas (94,157px of laid-out content) works — scrolled to top
  and to bottom without error.

## Gap flagged (not a bug — a coverage limitation worth knowing about)

`NarrationEntry.kind: 'tool'` — the "chat = full structured transcript" feature
(`project_chat_structured_transcript.md`) — **has never been exercised against real
persisted data.** `~/.operator/chat.db` has **10,747 messages across 138 sessions and
zero rows of kind `'tool'`** (confirmed via direct query). This isn't a bug in the running
app: `git diff src-tauri/src/transcript.rs` shows the `kind: "tool".to_string()`
narration push is a `+` addition in the **uncommitted** working tree — the currently
running (older) build never had code to write it. So:

- Every real session in chat.db today, including both fixtures used above, has only
  `text`/`user` rows.
- Once this feature ships and the app restarts, **old** sessions will stay
  text/user-only forever (chat.db only gains `tool` rows going forward from a
  restart) — new tool-call blocks will only appear in conversations that happen after
  the update. That's expected given the append-only/idempotent store design, but worth
  knowing before anyone is surprised that a resumed old session shows no tool blocks
  post-update.
- The `ToolBlock.output` cap (2000 chars at parse time, real p99 172KB / max 3.5MB per
  `shared/types.ts`'s own comment) is consequently **untested against real persisted
  data** by this pass — there's no real `tool` row in chat.db to test it with. Worth a
  follow-up QA pass once this feature is actually shipped and a live session has
  produced real `tool` rows.

## Supporting: unit tests

`npx vitest run` — **238/238 pass**, including all chat-relevant suites:
`submit-queue.test.ts` (15), `chat-signal.test.ts` (8), `chat-turns.test.ts` (5). No
`interrupt.test.ts` exists yet — the interrupt module's only coverage is this pass's live
end-to-end drive plus `submit-queue.test.ts`'s `cancelNudge` unit tests.

## Artifacts

Left on disk, untracked (not committed), reusable for a future pass:
`dev/qa-extract-real.mjs`, `dev/qa-real-bridge.ts`, `dev/qa-real.html`,
`dev/qa-real-main.tsx`, `dev/qa-drive-real-chat.mjs`. The generated fixture
(`dev/qa-real-fixture.json`, real conversation content) was deleted after the run —
re-run the extractor to regenerate it (requires `~/.operator/chat.db` and
`~/.operator/projects.json` to exist, i.e. run on this machine).
