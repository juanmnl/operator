# RESULT: what retains ~1GB of renderer JS heap

Static audit, five parallel deep-reads (dispose paths, scrollback, chat/transcript, listeners,
lingering session state), cross-checked against the source directly. Ranked by plausible
contribution to the ~1GB figure. All five leads from the brief were checked; two are the story,
one is a dead end, two are real-but-secondary.

## TL;DR

The scrollback fix (`terminal-options.ts`) already shipped and works exactly as designed — but it
was sized for **"8 lanes is a normal working day."** The fleet that produced the 1089–1196MB
readings had **27 lanes**. Re-running the fix's own math at the observed fleet size lands within
spitting distance of the pre-fix incident it was built to solve. That's suspect #1, and it's not a
leak — it's a baseline that was tuned to the wrong N. Layered on top: terminal panes are mounted
**across every project, not just the active one** (confirmed, no filter), and **naturally-exited
ptys never get swept** unless a user dismisses them or a different close path happens to catch
them — both of which quietly inflate N further. Chat/transcript accumulation is real but bounded
and session-scoped, not a multi-lane multiplier. Listener cleanup is clean — full dead end.

## Ranked retainers

### 1. Scrollback across all mounted terminals — baseline, sized for the wrong fleet count

**Plausible size: 400–700MB of the ~1GB.**

- `src/renderer/lib/terminal-options.ts:125` `ACTIVE_SCROLLBACK = 10_000`, `:154`
  `INACTIVE_SCROLLBACK = 2_000`, `:158-160` `scrollbackFor(active)`.
- `terminal-options.ts:127-152` (comment) documents the motivating incident **in this repo's own
  words**: 8 lanes × 10k active-scrollback lines each = 80,000 buffered lines, **WebContent
  resting at 737MB**, renderer killed mid-navigation. `terminal-scrollback.test.ts:20-28` encodes
  the same math as a regression test: `before = lanes * ACTIVE_SCROLLBACK` (80,000 at 8 lanes),
  `after = ACTIVE_SCROLLBACK + (lanes-1) * INACTIVE_SCROLLBACK` (24,000 at 8 lanes, "less than
  before/3").
- The fix is real and applied correctly: `TerminalPane.tsx:633` `term.options.scrollback =
  scrollbackFor(active)` writes directly to xterm's own setter (synchronous, destructive trim —
  documented explicitly at `terminal-options.ts:144-148`), inside an effect keyed on `[active]`.
  `active` is computed at `DashboardView.tsx:4174`/`:4183` as `t.id === activeTerminalId &&
  !t.ended && mainView === 'terminal'` — so even the *focused* lane trims to 2,000 lines the
  moment the user looks at Chat or Preview instead of the terminal surface. This is working
  correctly and is not the problem.
- **The problem is N.** `DashboardView.tsx:4148` `terminals.map((t) => …)` renders every mounted
  terminal with no cap and — confirmed by direct read — **no filter by `activeProjectId`**. Project
  memory records the live fleet at the time of measurement as **27 lanes, 2 working, 4-5 duplicate
  lanes per role** (`dispatch.ts` comments, cross-referenced by the lingering-state agent). Redo
  the test file's own formula at 27 lanes instead of 8: `10,000 + 26 × 2,000 = 62,000` buffered
  lines — **77% of the original 80,000-line, 737MB incident**, despite the fix working exactly as
  designed. The fix cut per-lane cost by ~70%, but fleet size grew ~3.4×, and 3.4 × 0.3 ≈ 1 — net
  roughly a wash. That reconciles cleanly with a ~1GB reading on a fix that provably works.
- **This also explains the 8MB/lane close-delta the brief measured**, which looked like it argued
  *against* scrollback being the story. It doesn't: closing an already-inactive lane frees an
  already-trimmed 2,000-line buffer + xterm/DOM overhead — genuinely small, ~8MB, matches. The
  bulk of the 1GB isn't the marginal cost of one more lane; it's the **fixed cost of the first
  active lane (10k lines) plus the accumulated baseline of every other lane sitting at 2k lines
  each**, most of which were never closed at all.

**Leak or baseline:** baseline, correctly engineered for 8 lanes, not re-validated against actual
fleet sizes that regularly reach 27+.

**Cheapest confirmation without a heap snapshot:** add a dev-only counter — sum
`term.buffer.active.length` (or `.getLength()`) across every registered terminal in
`terminal-registry.ts`'s map, logged on an interval or exposed via a console command — and compare
against `terminals.length`. If total buffered lines tracks `10,000 + (N-1)×2,000` for the live N,
this is confirmed quantitatively, not just plausibly. Cross-reference against a `vmmap`/
`performance.memory` reading at the same instant to get an actual bytes-per-line figure specific
to this app's content (ANSI-heavy TUI output, see below), which the 737MB/80,000-line incident
implies is roughly **9.2KB/line at minimum** (737MB baseline includes non-scrollback WebKit/JS
overhead too, so treat that as an upper bound on true per-line cost, not a clean average).

### 2. Terminals mounted across every project, not just the active one — confirmed amplifier of #1

**Plausible size: folds into #1's estimate above; this is *why* N can reach 27 rather than staying
near the per-project lane count.**

- `DashboardView.tsx:4148-4204`: the render loop iterates the full `terminals` state array
  (`useState<TerminalTab[]>([])`, `DashboardView.tsx:147`) with **no `activeProjectId` filter**.
  Panes for a project you switched away from are set to `visibility: 'hidden'`
  (`DashboardView.tsx:4153`) and `pointerEvents: 'none'` when not the active surface — they stay
  fully mounted, not unmounted, per the codebase's own documented rule that terminal panes "stay
  mounted across mode changes" (comment, `DashboardView.tsx:4133` region) to avoid a resize-hang
  and blanked-output bug on remount.
- This means every lane from every project the user has touched in this renderer's lifetime
  contributes to the scrollback total in finding #1, not just the lanes in the currently viewed
  project. It's the direct mechanism by which fleet size grows past the "8 lanes, normal working
  day" case the fix was tuned for.

**Leak or baseline:** structurally a baseline (the never-unmount rule is deliberate and load-bearing
for other reasons — resize-hang, blanked output), but the **lack of project scoping is not itself
load-bearing** — nothing requires a lane from project A to stay mounted while the user works in
project B. This is the most actionable single fix: scope the render (and ideally the
active/inactive scrollback accounting) to the active project, unmounting — not just hiding — panes
for backgrounded projects. That's disposal, which is safe per finding below (dispose is proven
clean on every path that fires it).

**Cheapest confirmation:** log `new Set(terminals.map(t => t.projectId)).size` alongside the
counter from #1 whenever the reading is taken. If it's >1 and the non-active projects' lanes are
old, that's the smoking gun.

### 3. Ended-but-undismissed terminal panes — a real gap, not covered by dispose or auto-close

**Plausible size: 50–250MB, wide range — depends on how many of the fleet's "27 lanes, 2 working"
were dead ptys nobody dismissed, which this audit can't count statically.**

- `DashboardView.tsx:440-448` `onTerminalExit`: on a pty dying naturally (crash, or Claude/shell
  finishing on its own — **not** a user-initiated close), the handler does `setTerminals(prev =>
  prev.map(t => t.id === id ? {...t, ended: true} : t))`. The entry is **kept**, only flagged. The
  pane stays mounted, per the handler's own comment: "xterm keeps its buffer after the pty dies…
  leave it mounted + active."
- Because `!t.ended` is required for `active` (`DashboardView.tsx:4174`/`:4183`), an ended tab
  immediately drops to `INACTIVE_SCROLLBACK` (2,000 lines) — so each one is bounded, not unbounded.
  But the full live `xterm.js` `Terminal` instance (DOM/canvas nodes, addons, 2,000-line buffer)
  stays resident. `TerminalPane.tsx:189` `registerTerminal(...)` fires on mount;
  `unregisterTerminal`/`term.dispose()` (`TerminalPane.tsx:592-593`) only fires on **unmount**, and
  nothing unmounts an ended tab automatically.
- The only paths that remove an ended tab are: (a) the user explicitly dismissing it via
  `EndedOverlay.onClose` (`DashboardView.tsx:4193-4204`), or (b) it happening to also match a
  session that a different close path (`handleCloseSession`, `closeProject`, or the new
  `lane-lifecycle.ts` auto-close) independently targets. **It is genuinely unclear from static
  reading alone whether `lane-lifecycle.ts`'s auto-close policy (10-minute grace after
  task-done, 2-hour went-quiet backstop, `lane-lifecycle.ts:167,173`) is keyed off the same
  `ended` flag or off separate session-activity state** — the dispose-path audit and the
  lingering-state audit disagreed on this point (one read auto-close as sweeping broadly, the
  other flagged naturally-dead ptys as specifically excluded from it). This is the one place in
  this report where the two independent reads didn't converge — see "what a heap snapshot would
  buy" below.
- One structural note in favor of this being real: the brief's own board-close entry point isn't
  what it appears — the kanban Board tab (`TaskBoard.tsx`) has **no lane-close affordance at all**;
  the actual close UI lives in the Team tab's `RosterPanel.tsx:482`. If a user's mental model is
  "I closed it from the board," they may not have touched a close path at all, which would explain
  ended-but-undismissed tabs accumulating silently during normal use.

**Leak or baseline:** **leak** — `dispose()` exists, is correctly implemented, and is *proven* to
run cleanly on every path that calls it (see finding #5 below). The gap is that a whole category of
"this pty is done" (crash/natural-exit) doesn't automatically route into that path the way a
user-initiated close does.

**Cheapest confirmation:** instrument `terminals.filter(t => t.ended).length` and how long each has
been in that state (needs an `endedAt` timestamp, not currently tracked — cheap to add) at the
moment of a near-1GB reading. If nonzero and old, this is confirmed as a live contributor, and the
fix is either (a) auto-close should also sweep `ended` tabs after a short grace period, independent
of the went-quiet/task-done triggers it currently keys on, or (b) `EndedOverlay` should have a
default auto-dismiss timer.

### 4. Global, session-unscoped markdown block cache — real bug, bounded impact

**Plausible size: 5–40MB.** Small relative to #1–#3, but a genuine correctness gap worth fixing
regardless of whether it's load-bearing for the 1GB figure.

- `src/renderer/components/session/CanvasConversation.tsx:212-217`:
  ```
  const blockCache = new Map<string, Block[]>()
  function cachedBlocks(text: string) {
    let b = blockCache.get(text)
    if (!b) { b = parseBlocks(text); if (blockCache.size > 400) blockCache.clear(); blockCache.set(text, b) }
    return b
  }
  ```
  Module-scope `Map`, keyed by raw message text, called from `layout()` (`:438`) on every relayout
  for every visible turn. Eviction is "clear the whole map at 400 entries" — not per-session, not
  LRU, and not bounded by *content* size (a single cached entry could be the parsed AST of a huge
  table or code block, with no per-entry size guard, unlike the assistant-text cap discussed below).
- Because it's keyed by raw text and cleared wholesale rather than per-session, a closed lane's
  parsed blocks sit in the cache — competing for the same 400 slots — until the global cap trips,
  at which point *everything* is evicted including the active session's own recently-parsed
  content, which then gets re-parsed. This is a correctness/perf smell (thrash near the 400-entry
  boundary) more than a major memory contributor, since the cap does bound total size.

**Leak or baseline:** baseline, but poorly scoped — capped, so not unbounded growth, but the cap
policy is global-not-per-session, so it holds dead sessions' data preferentially over nothing in
particular.

**Cheapest confirmation:** log `blockCache.size` and an approximate byte size (e.g.
`JSON.stringify` length as a rough proxy) at intervals; watch whether it saturates at 400 and
whether entries from closed sessions are still present just before a clear.

### 5. Chat history load for the currently-open session — real gap, but session-scoped (not a multiplier)

**Plausible size: single digits to tens of MB for one very long-running session; zero for closed
sessions (freed on switch).** Not a contributor to the ~1GB baseline across a large fleet, because
only one `CanvasConversation` is mounted at a time and `history` resets on session switch
(`CanvasConversation.tsx:499` `setHistory([])`).

- `src-tauri/src/chatstore.rs:198-225`: `SELECT kind, text, ts, images, tool FROM messages WHERE
  session_id = ?1 ORDER BY seq ASC` — **no `LIMIT`, no pagination.** Returns the full lifetime
  history of whichever session is open, re-fetched wholesale every 15s
  (`CanvasConversation.tsx:506`, `setInterval(load, 15000)`).
- Assistant prose (`kind: "text"`) is stored **uncapped in length**
  (`src-tauri/src/transcript.rs:450-457`), unlike tool-result blobs, which are capped at
  `TOOL_RESULT_CAP = 2000` chars (`transcript.rs:898`, `:286-302`). So a single very long assistant
  turn (long plans, long code dumps in prose) is held verbatim, once per copy in `history`, with no
  size guard analogous to the tool-result cap.
- `layout()` (`CanvasConversation.tsx:349-444`) computes layout over the **entire** `visible` array
  on every relayout — not windowed/virtualized. Only *painting* skips off-screen ops
  (`:629-630`); the layout pass itself walks every loaded turn regardless of scroll position.
- The dead end this ruled out: the historical fix this lead was modeled on (react-markdown re-parse
  × `session:update`, memo + 16KB cap) lived in `ConversationPanel.tsx`, which **no longer exists**
  — it was deleted when `CanvasConversation` became the default chat renderer. The 16KB-cap comment
  survives only as history in `canvas-md.ts:1-11`. Not a live issue; the "same shape elsewhere"
  search correctly redirected to `blockCache` (#4) and the unbounded SQL load (this finding)
  instead.

**Leak or baseline:** baseline cost of the open session, uncapped in a way nothing else in the
codebase is (contrast the 2,000-char tool-result cap). Grows with how long a single session has
been running, not with fleet size — so it explains variance between measurements more than it
explains the steady ~1GB floor.

**Cheapest confirmation:** log `history.length` and `history.reduce((n,m) => n + m.text.length, 0)`
for the open session next to a `SELECT COUNT(*), SUM(LENGTH(text)) FROM messages WHERE
session_id=?` against `chat.db` for the same session — if renderer and DB numbers match and the sum
is large, this is confirmed and a `LIMIT`/pagination fix is warranted independent of its size here.

### 6. Listeners and subscriptions — dead end, ruled out

All 9 `window.operator.on*` subscription types defined in `src/operator-bridge.ts` (terminal data,
terminal exit, grid update, session update, orchestrator dispatch/reply, window resize, file drop,
preview pick) were traced to their single call site each. Every one unsubscribes correctly on
unmount via a cleanup function that closes over its own call's `unlisten`. `onPreviewPick`
(`AppPreviewPanel.tsx:243`) churns — its effect deps include two inline arrow functions that are
fresh every parent render, so it tears down and resubscribes on every `DashboardView` render while
mounted — but the cleanup is correct each time, so this is wasted IPC round-trips, not a leak. No
raw `listen()` calls exist outside the bridge file. **This lead does not contribute to the ~1GB and
needs no fix for memory** (the `onPreviewPick` churn is worth a cheap fix for IPC overhead, but
that's a CPU/perf note, not a heap one).

### 7. Terminal disposal itself — proven clean on every path that fires it

Every *intentional* close path — sidebar rail (`ProjectRail.tsx:512`), Team tab's
`RosterPanel.tsx:482` (not the Board tab, which has no lane-close UI at all — see finding #3),
`closeProject` (`DashboardView.tsx:1010-1049`), and the new `lane-lifecycle.ts` auto-close
(wired at `DashboardView.tsx:2760-2769`) — converges on `handleCloseSession`
(`DashboardView.tsx:2651-2715`), which unconditionally does `setTerminals(prev => prev.filter(t =>
t.id !== terminalId))` (`:2705`). That filter is what unmounts `TerminalPane`/`GridTerminalPane`,
running the cleanup that calls `unregisterTerminal` then `term.dispose()`
(`TerminalPane.tsx:592-593`, `GridTerminalPane.tsx:422`), with `termRef.current = null` and
`fitRef.current = null` immediately after (`TerminalPane.tsx:594-595`). The `TerminalTab` state
shape itself (`DashboardView.tsx:63-91`) is pure metadata — id/key/cwd/flags — never holds a live
`Terminal` object, so the state array can't pin an instance alive past unmount. `terminal-registry.ts`
is a plain `Map` with `register`/`unregister` as its only writes — no stale entries. **This is not
where the ~1GB comes from; the gap is upstream of dispose (findings #2 and #3: panes that never
reach a close path in the first place), not in dispose itself.**

## Not renderer JS heap — flagged but out of scope for the ~1GB figure

The backend Rust process (`src-tauri`) has its own, separate leak-shaped issue that does **not**
count toward WKWebView's renderer heap: `Sessions: HashMap<String, AgentSession>`
(`src-tauri/src/core.rs:264-266`) has an `upsert` but no `.remove()` anywhere in the codebase — it
grows for the life of the Rust process. It doesn't inflate the renderer because `get_active()`
(`core.rs:320-324`) filters to `status == "active"` before every push over the Tauri event bridge.
Worth its own ticket, but it's a different process and a different memory budget than the one this
brief asked about.

## What this audit could NOT determine without a heap snapshot

- **Real bytes-per-buffered-line for this app's content.** The 737MB/80,000-line incident implies
  an upper bound (~9.2KB/line, but that includes fixed WebKit/JS baseline overhead, not just
  scrollback). A snapshot's retainer view would give an exact xterm `BufferLine` byte cost for
  this app's actual content — TUI output with box-drawing, 256-color SGR, cursor-positioning
  sequences (confirmed ANSI-heavy, not pre-stripped plain text: `TerminalPane.tsx:462` writes
  `stripOrnaments(data)`, which strips only emoji dividers, not color/SGR codes).
- **Whether `xterm.dispose()` truly drops every `BufferLine` reference synchronously in the
  installed `@xterm/xterm ^6.0.0`**, versus relying on a later GC pass. Couldn't inspect —
  `node_modules` isn't present in this checkout. Static reading shows nothing in this codebase
  retains a reference post-dispose, but that only rules out *this app's* leaks, not a library-level
  one.
- **The actual count of ended-but-undismissed tabs at the moment of a ~1GB reading**, and whether
  `lane-lifecycle.ts`'s auto-close sweeps them — the two research passes disagreed on this (finding
  #3). A snapshot's retainer path for a live `Terminal` instance would immediately show whether
  ended-ghost panes are present and how many, settling it in one read.
- **Actual per-entry size in `blockCache`** — bounded by count (400), not by content size, so a
  snapshot would show whether a handful of huge parsed tables dominate or whether it's uniformly
  small (changes whether finding #4 is worth prioritizing).
- **Whether cross-project mounting (finding #2) is actually contributing at the specific moment the
  1089–1196MB readings were taken** — i.e., how many distinct projects had lanes open. This audit
  confirmed the *mechanism* (no filter) but not the *magnitude* in the specific incident, since that
  requires knowing the user's project-switching history for that session, which isn't in the code.

## Recommended fix order (memory impact, not effort)

1. Scope terminal mounting to the active project (finding #2) — unmount, don't just hide, panes for
   backgrounded projects. Directly cuts the effective N in finding #1's formula. Safe: dispose is
   proven clean (finding #7).
2. Give ended-but-undismissed tabs a sweep path independent of the went-quiet/task-done triggers
   (finding #3) — e.g., auto-close after a short grace period once `ended` is true, regardless of
   session-activity state.
3. Scope `blockCache` per-session and evict on lane close instead of a global 400-entry clear-all
   (finding #4) — cheap, fixes a real correctness smell, minor memory win.
4. Add `LIMIT`/pagination to `chat_history`'s SQL load and a length cap on stored assistant text to
   match the existing 2,000-char tool-result cap (finding #5) — bounds the worst case for
   long-running sessions.

None of this is "close more lanes" — per the brief's constraint, and consistent with what the
8MB/lane measurement actually shows: the fix belongs to *how* mounted lanes are scoped and swept,
not to fleet size itself.
