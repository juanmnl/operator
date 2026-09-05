# Simplify audit — Research findings

Note on process: `dev/briefs/simplify-audit.md` does not exist in this worktree (the known
cross-worktree brief-invisibility issue — briefs written in the coordinator's checkout don't
appear in a freshly created lane worktree unless copied over explicitly). The four audits below
were run directly from the task description in the dispatch, not from a brief file. Report only —
no code was changed.

Repo note that affects every audit below: this checkout currently holds **two parallel
implementations** of large chunks of the backend — the original Tauri/Rust app (`src-tauri/`)
and a newer Electron port (`electron/`) that is mid-migration to feature parity. Several "keep
vs. remove" calls differ by which shell is the target; called out inline where it matters.

---

## 1. Chat + Files removal map

### Chat — full-delete candidates
- `src/renderer/components/session/CanvasConversation.tsx` (1125 lines) — the transcript surface.
- `src/renderer/components/session/ChatComposer.tsx` (448 lines) — used only by CanvasConversation.
- `src/renderer/lib/chat-turns.ts` (+ `.test.ts`) — `isRenderableTurn`, Chat-only.
- `src/renderer/lib/canvas-md.ts` (+ `.test.ts`) — markdown block parser, Chat-only.
- `src/renderer/lib/tool-blocks.ts` (+ `.test.ts`) — tool-run coalescing, Chat-only.
- `src/renderer/lib/tool-file-link.ts` (+ `.test.ts`) — transcript→file-link helper; **already dead
  code** (only its own test imports it). Full delete regardless of the Chat/Files decision.

**Not Chat, don't touch:** `CommsLog.tsx` (project-level replies/reports timeline in
`ProjectView.tsx`) renders `ProjectReply` rows, a different data shape from Chat's
`NarrationEntry` turns.

### Files — full-delete candidates
- `src/renderer/components/files/FilesView.tsx` — main-view tree+viewer split.
- `src/renderer/components/files/FilesPanel.tsx` — right-panel tab wrapper.
- `src/renderer/components/files/FileTree.tsx` — calls `window.operator.fileTree`.
- `src/renderer/components/files/FileViewer.tsx` — CodeMirror viewer, calls `window.operator.fileRead`.
- `src/renderer/components/files/cm-theme.ts` — used only by FileViewer.
- `src/renderer/lib/code-nav.ts` (+ `.test.ts`) — `FilesNav`, href parsing, used only by Files (+ the already-dead `tool-file-link.ts`).

**Important:** Files is not implemented on the Tauri backend today — `src/operator-bridge.ts:280-281`
stubs `fileTree`/`fileRead` to throw `'The Tauri build has no file browser.'` It's dead UI in the
current Tauri app. The real implementation lives in `electron/src/main/files.ts` (wired via
`electron/src/main/ipc.ts`) — out of the Tauri scope but the same feature, so removing Files means
removing it from both shells.

### Shared files needing surgical (partial) edits, not full deletion

| File | Chat/Files-specific part | Other consumers — must survive |
|---|---|---|
| `src/renderer/views/DashboardView.tsx` (~4800 lines) | `MainView`/`PanelTab` union members `'chat'`/`'files'`; imports of `FilesView`/`FilesPanel`/`CanvasConversation`/`code-nav`; `panelTabs` branching (~L266-270); ⌘J `toggleChat()` (L318-321, L3593-3595); `filesNav`/`filesNavs` state (L283-287); palette entries (~L3980-3990, L4061); render blocks at L4610, L4625, L4774-4781 | Everything else. `chatSignal` import (L54) also feeds `identifyQuitLane` (L3200) for quit-dialog lane text — keep `chatSignal`, drop only the Chat-view usages. |
| `src/renderer/components/session/CanvasPanel.tsx` | `PanelTab` union incl. `'chat'`/`'files'`; `LABELS.chat`/`.files`; the two render branches | Shared right-panel shell for `plan`/`diff` tabs too — do not delete the file. |
| `src/renderer/components/session/SessionToolbar.tsx` | `mainView` prop union incl. `'chat'`/`'files'`; Console·Chat·Preview·Files segmented array (~L216) | Toolbar itself is used by every session. |
| `src/renderer/lib/pane-visibility.ts` (+ `.test.ts`) | `MainView` type includes `'chat'`/`'files'`; matching test cases | `paneVisibility()` logic for `'terminal'`/`'preview'` stays. |
| `src/renderer/lib/chat-signal.ts` | `chatSignal()` — Chat-view-authored | `toolVerb()` export is used by `TaskBoard.tsx` — **do not delete the file**; `chatSignal()` itself is also read by the quit-guard (DashboardView L3200) — verify quit-dialog wording before removing. |
| `src/renderer/lib/chrome.test.ts` | `BLOCK_SLOT_SURFACES` rows for `CanvasConversation.tsx`/`FilesView.tsx`/`FilesPanel.tsx`, `FileViewer`/`cm-theme.ts` assertions (~L150, L154) | Same array also covers `AppPreviewPanel.tsx` (Preview) — remove only the chat/files rows. |
| `src/shared/types.ts` | `TreeEntry` (L301-308), `FileContent` (L311-321) — Files-only, delete | `NarrationEntry`/`ToolBlock`/`AgentSession.messages`/`.queued` are **not** Chat-only — they feed `delivery-confirm.ts`'s submit-queue watchdog and are populated for every session; keep. `ProjectReply` feeds CommsLog — keep. |
| `src/renderer/env.d.ts` | `fileTree`, `fileRead`, `chatHistory`, `imageDataUrl` bridge signatures + `TreeEntry`/`FileContent` imports | Rest of `window.operator` surface untouched. |
| `src/operator-bridge.ts` | `fileTree`/`fileRead` stubs (already throwing), `chatHistory`, `imageDataUrl` | Hundreds of unrelated bridge methods live in this file — edit surgically. |
| `src/renderer/lib/drop-guard.ts` (+ `.test.ts`) | Comment references `ChatComposer` as one of several drop targets | No functional chat branch — comment-only edit. |

### Rust/src-tauri backend
- **Files:** no backend commands exist at all (`TreeEntry`/`FileContent` declared in
  `shared/types.ts` but never implemented in Rust). Nothing to remove server-side; only the
  frontend stub needs cleanup.
- **Chat:**
  - `src-tauri/src/chatstore.rs`: `ChatStore::load()` (L198, "for the reading panel") is
    Chat-only — delete. **Keep** `open`/`append`/`replies()`, the `messages` table, and
    `ProjectReply` — durable write path used by every session's transcript and by CommsLog.
  - `src-tauri/src/lib.rs`: `fn chat_history` (L1756-1762 + registration L2274) — delete.
    `fn image_data_url` (L1729-1746 + registration L2276) — delete; already unused by the
    frontend (no `<img>`/`imageDataUrl` call exists in CanvasConversation), dead regardless.
    `fn chat_db_file` (L1722-1725) — **keep** if `ChatStore` stays for replies/CommsLog (which it
    must), since chat.db remains the store's file.
  - **Keep untouched:** `src-tauri/src/transcript.rs` — core session-tracking infra (phases,
    dispatches, replies) feeding TaskBoard, sidebar, quit-guard, delivery-confirm; it only
    happens to also produce what Chat displays.

### Navigation / routing / keybindings
- Console·Chat·Preview·Files segmented toggle in `SessionToolbar.tsx` (render at ~L216).
- ⌘J = `toggleChat()` in `DashboardView.tsx` (bound L3593-3595) — flips Console⇄Chat. Files has
  no dedicated keybinding, only the toggle/palette.
- Command palette entries: `view('chat', 'Show Chat', '⌘J')` (~L3981) and a Files equivalent
  nearby.
- `CanvasPanel.tsx`'s right-panel tab strip also offers Chat/Files as contextual tabs.
- No sidebar (`ProjectRail.tsx`) references — its "files" mentions are about `.claude`
  preference files, unrelated; false positive, leave alone.

### Tests
Full-delete (co-located with full-delete source): `chat-turns.test.ts`, `canvas-md.test.ts`,
`tool-blocks.test.ts`, `tool-file-link.test.ts`, `code-nav.test.ts`.

Partial-edit: `chat-signal.test.ts` (verify it doesn't also cover `toolVerb`, which must
survive), `pane-visibility.test.ts` (drop `'chat'`/`'files'` cases), `chrome.test.ts` (drop the
3 chat/files `BLOCK_SLOT_SURFACES` rows + 2 assertions), `drop-guard.test.ts` (comment only),
`task-board.test.ts` (uses `chat-signal`'s `toolVerb` — unaffected if that file is kept, which
it must be).

### Must NOT be deleted despite "chat" in the name
`chat-signal.ts` (both exports have non-Chat-view consumers), `chatstore.rs`'s write path +
`ProjectReply`/`replies()`, `NarrationEntry`/`ToolBlock`/`AgentSession.messages`/`.queued` in
`shared/types.ts`, `transcript.rs` in its entirety, `drop-guard.ts`.

---

## 2. Settings keep/remove table

Two distinct settings surfaces exist: app-level `PrefsView.tsx` (Operator preferences) and
per-project `FolderPreferencesView.tsx` (gear menu on a project, tabs: Instructions, Permissions,
General, Hooks, Plugins, Environment, Skills, Worktrees).

### App-level (`PrefsView.tsx`) — every entry is real and wired, keep all
Check for updates, Theme (light/dark + identity grid — shares one handler with the command
palette's "Theme:" commands, not a real duplicate), Dock icon, Resume agents on launch, Ask
before quitting with agents running (mirrors into Rust's quit guard, load-bearing per its own
comment), Close finished lanes keep-warm window, Your-turn chime, Use ⌥ Option as Meta,
Fullscreen TUI renderer. No model/effort/verbosity setting exists on this page.

### Per-project (`FolderPreferencesView.tsx`)

| Setting | Effect | Judgment |
|---|---|---|
| CLAUDE.md instructions (per scope) | Real, writes file on blur | Keep |
| Permissions (Allow/Deny/Ask) | Real, patches `settings.permissions.*` | Keep |
| **Effort Level** (low/med/high/xhigh), General tab | Writes `settings.effortLevel`. Per its own code comment, this now only matters for Claude Code sessions started **outside** Operator, since a lane's live effort rides the `--effort` launch flag | **Investigate further** — this is the third of three effort surfaces (this + roster/creation-dialog `defaults.effortLevel` + ChatComposer's live `/effort` picker), each writing a different destination. Not a no-op, but user-facing intent has drifted from what actually governs in-app lanes. Worth relabeling ("Effort for CLI sessions outside Operator") or removing. |
| Sandbox enabled | Writes `settings.sandbox.enabled`, consumed by CLI | Keep (verify against current CLI schema) |
| Denied MCP Servers | Writes `settings.deniedMcpServers` | Keep |
| Hooks | Explicitly read-only by design, no write path | Keep as-is |
| Plugins enable/disable | Writes `settings.enabledPlugins[name]` | Keep |
| Environment variables (per-project) | Writes `project.env` into `~/.operator/projects.json` — deliberately NOT the repo's `.claude/settings.json`, to keep one writer per file | Keep |
| Skills | Explicitly read-only by design | Keep as-is |
| Worktrees ("Remove N safe worktrees") | Only `dryRun:false` caller in the app | Keep |

### Confirmed absent (already removed, matches expectations)
- No `verbosity` setting anywhere in `src/renderer` or `src-tauri/src`.
- No global "Defaults" tab — `AgentsHubView.tsx:32` comment confirms it was removed along with
  the global tier it edited.

### Adjacent, not a settings-page item but relevant to the simplify pass
Chat/Files/Preview are `SessionToolbar.tsx` main-view segment buttons inside a session, not
settings toggles — flagged since they're reachable from a still-live toolbar control and are
exactly what audit #1 above maps for removal.

**Bottom line:** only one real "investigate" item — the per-project Effort Level field, which is
legacy-scoped and likely to confuse users given two other effort controls now dominate. Nothing
else in Settings is a no-op or true duplicate.

---

## 3. Port allocation trace

Two parallel implementations exist here too: `src-tauri/src/lib.rs` (Rust/Tauri) and
`electron/src/main/terminals.ts` + `leases.ts` + `port-attribution.ts` + `reap.ts` (Electron,
mid-migration per `electron/PORT-LEDGER.md`).

**Allocation**
- Rust: `PtyManager.ports: Mutex<HashMap<String,(String,u16)>>` (`lib.rs:308`). `alloc_port`
  (`lib.rs:438-456`) reuses a port for the same cwd, otherwise scans `1420..1520` with a live OS
  bind test via `port_free` (`lib.rs:333-336`, binds both `127.0.0.1` and `::1`).
- Electron: `portsByCwd: Map<string,number>` (`terminals.ts:100`). `allocPort` (`terminals.ts:113-124`)
  applies the same same-cwd-reuse rule, same `1420..1520` range, **but has no OS-level bind
  check** — it only avoids ports already tracked in its own in-process map. This is a real gap
  vs. the Rust version: it can hand out a port that's actually busy from an untracked process, or
  held by a not-yet-tagged orphan.

**Env wiring into the pty:** both set `OPERATOR_DEV_PORT`/`PORT` on the spawned process env, plus
a system-prompt note telling the agent its port. Electron additionally stamps
`OPERATOR_TERMINAL_ID`, `OPERATOR_APP_PID`, `OPERATOR_PROJECT_ID`/`OPERATOR_ROLE_ID` for reap
purposes (`terminals.ts:181-194`); Rust has no equivalent tagging.

**`port-attribution.ts`** — defined AND wired, not dead code. Invoked from
`TerminalManager.sessionPorts()` (`terminals.ts:466`), a read-time classifier
(sniffed/reserved/shared/claimed/orphan) polled by the renderer's preview panel (4s) and toolbar
chip (5s). It only classifies for display — it does not release or reclaim ports, and has no
lane/session/app-close hook of its own. Rust has no equivalent; this module was built specifically
to fix a misattribution bug the Rust `session_ports` still has.

**Persisted registry — Electron only:** `electron/src/main/leases.ts` writes `dev-leases.json`
under the operator dir, keyed by Claude session UUID (durable across app restarts, unlike the
in-memory maps on both sides). Claimed at spawn (`terminals.ts:233-238`), released on clean kill
(`terminals.ts:388`), bulk-released on quit (`index.ts:153`) and swept for staleness at boot
(`reap.ts:555`). Rust's registry is purely in-memory — a crash loses all bookkeeping, which is
apparently why the Electron side added this file (`PORT-LEDGER.md:37` explicitly flags the Rust
dev-port registry as one of the pieces not yet reconciled between shells).

**Known, already-documented bugs (from code comments, not from me):**
- `reap.ts:319-341` — the process-tree reaper walks down from the pty shell's pid, so a dev
  server that reparents to `launchd` (e.g. via `nohup &`) before lane close is invisible to it.
  Measured on the dev machine: 24 real orphans, oldest 11 days, one squatting port 1420 since
  Aug 20 and blocking a new lane from claiming its own reservation. Matches this project's
  memory note on the dev-server leak.
- `terminals.ts:508-511` — quit used to leak identically to single-lane close (`killAll()` was
  just a loop over `kill()`) until routed through the same `reapAndForget` path.
- `reap.ts:291-294,467-469` — orphans that predate the `OPERATOR_APP_PID` tagging scheme are
  permanently unreapable by design (refuses to guess rather than risk killing the wrong thing).
- **Gap I found, not comment-flagged:** Electron's `allocPort()` has no bind-check, unlike Rust's
  `alloc_port`/`port_free` — see above.

---

## 4. Tuning gap vs. the landing (`~/Developer/Operator-landing`)

The landing's README describes the "Tuning (06–09)" section as: **06** model and effort per
agent, **07** what each model actually spends, **08** the plan meter (session/week/model cap,
absent-is-not-zero), **09** the diff you review before it lands.

Checked each against the current app:

- **06 — model+effort per agent/lane:** real and matches the landing's framing exactly.
  `RosterPanel.tsx` pins model + effort per role, persisted into `projects.json`; `effort.ts`
  defines the ladder; launching a role spawns a session with that config. No gap.
- **08 — plan meter:** real and fully wired. `src/renderer/lib/plan-limits.ts` implements
  exactly what the landing describes — session/week/per-model rows, the "absent is not zero"
  distinction (`hasData`/`readable`), freshness/staleness thresholds, and reset-clause parsing so
  a rolled-over window doesn't keep showing a stale percentage. `PlanMeter.tsx` consumes it end
  to end. No gap.
- **09 — diff review:** `DiffPanel.tsx`/`CanvasDiffPanel.tsx`/`DiffBody.tsx` exist and are wired
  into `CanvasPanel.tsx`'s tab strip. No gap.
- **07 — "what each model actually spends" — real gap.** The pricing/cost engine is fully built
  and current (see commit `1ed9af2`, "Usage rates: Sonnet 5 is 2/10..." — Sonnet-5-vs-4.6 rate
  disambiguation, cache-read-as-a-rate, fast-mode billing) and lives in both
  `electron/src/main/usage.ts` and `src-tauri/src/usage.rs`, exposed over the bridge as
  `getUsageStats`/`getUsageInsights` (`operator-bridge.ts:394-395`, typed in `env.d.ts:173-174`).
  **Nothing in `src/renderer` calls either method** — grep for `getUsageStats`/`getUsageInsights`
  outside `env.d.ts` returns nothing. `AgentLibraryView.tsx:33-34` says as much directly in a
  comment: *"Operator no longer reports spend anywhere (the Usage & cost view is gone)."* The
  landing's item 07 specimen ("what each model actually spends") describes a UI that does not
  currently exist in the app — the backend data is sitting there, unconsumed.

**Recommendation:** this is the one clean, scoped follow-up out of the four audits — a Usage &
Cost view (or a lighter per-project/per-role cost readout) reading `getUsageStats`/
`getUsageInsights`, which are already tested and already the landing's own claim about the app.
Everything else the landing promises under "Tuning" already exists and is wired correctly; this
is not a broad gap, just one missing consumer of an existing, working backend.

**Update, per Operator's follow-up message:** usage is not being removed — it's being re-aimed.
Part 5 below audits what the transcripts actually give per turn and what a tuning-focused view
could show; it reports options, it does not decide.

---

## 5. Per-turn transcript data → concrete tuning signal

Two independent tailers exist and are exact mirrors: `src-tauri/src/transcript.rs` (Tauri,
current) plus `src-tauri/src/usage.rs` (the separate aggregate cost engine), and
`electron/src/main/transcript.ts`/`usage.ts` (Electron, kept in lockstep). Findings below were
checked against both code and a real `~/.claude/projects/.../*.jsonl` file, not just the parser
source.

### 5a. What's captured per turn today, per signal

| Signal | Captured? | Where | Shape | Per-turn/historical, or live-only? |
|---|---|---|---|---|
| Model | Yes | `transcript.rs:480-484` | `Option<String>` on `Track.model` | **Live/overwritten only** — latest turn's model wins, no history of a mid-session model switch |
| Fast mode | Only for pricing, not exposed | `usage.rs:191` (`Record.fast`) | internal to `rates()` | Aggregate-only, never a session/turn field |
| Effort | **No** — dropped despite being present | raw JSONL carries top-level `"effort": "high"` on every assistant record, sibling of `timestamp`/`sessionId`; `transcript.rs`'s `apply_assistant` never reads it | — | Not captured at all. `EffortLevel` in `shared/types.ts` is launch-config only (what Operator told the CLI to use), never what the CLI reports back |
| Input/output/cache-read tokens | Yes, cumulative | `transcript.rs:488-497` | `TokenUsage{input,output,cache_read}` on `Track.usage` → `AgentSession.usage` | **Live cumulative only, never persisted** — one running total per session, no way to recover a single turn's cost from this field |
| Cache-write split (5m/1h ephemeral) | Only in the separate `usage.rs`, folded into `input` in the live tailer | `usage.rs:169-175` (`Record.cache5m/cache1h`) | per-record in a 30s in-memory re-parse, exposed only as aggregates | Aggregate-only (`ModelUsage`/`ProjectUsage`/`DayUsage`); **no command exposes the raw per-turn record list**, so this more complete breakdown is unreachable by any caller even though the parser already produces it |
| Context size / window fullness | No live/per-turn exposure | `usage.rs:187` computes `context = input+cache_read+cache5m+cache1h` per record, folded only into an aggregate `high_context_pct` stat (share of turns >150k context) over a lookback window | — | Aggregate-only; no `contextPct`/`remainingContext` exists anywhere in the app for a specific session |
| Compaction events | **No — actively dropped** | `Track::apply` (`transcript.rs:323-328`) matches only `"user"\|"assistant"\|"queue-operation"`; raw `type:"system", subtype:"compact_boundary"` (carrying `trigger, preTokens, postTokens, cumulativeDroppedTokens, durationMs`) falls into `_ => {}` | — | Not captured. Side effect: the synthetic `isCompactSummary` resumption text that follows a boundary isn't recognized as one either, and gets pushed into narration/chat.db as an ordinary user prompt (can even become a session's title). Also: the `"compacting"` `SessionPhase` is UI-supported everywhere (`chat-signal.ts`, `quit-guard.ts`, status pills) but `derive_phase()` can only return `running`/`waiting` — **`compacting` is dead code in production**, never actually emitted |
| tool_result size | Yes, as a char count (not byte count) | `transcript.rs:378-391`, `ToolBlock.output_chars` (original length before the 2000-char cap) | `ToolBlock` field | **Persisted per-turn** — lives in chat.db's `messages.tool` JSON column, one of the only signals here that survives a restart and is historically queryable |
| Fan-out / sub-agent spawns | Partial | `activity: Vec<ActivityEntry>` (live, sidechain start/stop markers, `transcript.rs:310-321`) is never persisted and rebuilds from scratch each process restart; `ToolBlock.caller` (`transcript.rs:602`) attributing which (sub)agent issued a given tool call **is** persisted (rides inside the same `tool` JSON blob) | mixed | `caller` per-turn/historical; the activity timeline is live-only |
| Timestamp | Yes | every `NarrationEntry.timestamp` | `String` | **Persisted per-turn** (`ts` column in chat.db) |
| Duration (`durationMs`) | Read only by the separate `usage.rs`, never per-turn | `usage.rs:186` → summed into aggregate `UsageStats.api_ms` | — | Aggregate-only, never exposed per-turn or per-session |

**Also present in the raw JSONL, read nowhere:** `usage.service_tier`, `usage.server_tool_use.{web_search_requests,web_fetch_requests}`, `usage.inference_geo`, `usage.iterations[]`, `requestId`, `gitBranch`, `version`, `stop_sequence`/`stop_details`.

### 5b. What DashboardView already computes vs. discards, with file:line

- `AgentSession.usage` (input/output/cacheRead) is read at `DashboardView.tsx:4386-4404`,
  copied verbatim into a `laneRuntime` map, handed to `ProjectView`/`RosterPanel` as
  `LaneSession.usage` (`RosterPanel.tsx:18-21`) — **and never read again.**
  `RosterPanel.tsx:25` defines `formatTokens()` (the k/M compaction helper meant to display it)
  but it has **zero call sites** anywhere in `src/renderer` — dead code. `RosterPanel.tsx:891-894`
  has a comment admitting the per-lane token readout was deliberately hidden ("priced attention
  it didn't earn on a board about who's doing what"), but its own trailing claim that "the Usage
  & cost view still reports it" is stale — `AgentLibraryView.tsx:33-34` confirms that view is
  gone entirely.
- `AgentSession.lastActivityAt` — same path, threaded through, never read downstream.
- `UsageStats`/`ModelUsage`/`ProjectUsage`/`DayUsage`/`UsageInsights` (`shared/types.ts:748-800`)
  — fully computed server-side, IPC-exposed as `getUsageStats`/`getUsageInsights`
  (`env.d.ts:173-174`, `operator-bridge.ts:394-395`) — **zero renderer call sites at all.** This
  is the per-model/per-project/per-day aggregation machinery from part 4's gap; it already knows
  how to slice by model/project/day, it just has no consumer.
- **No aggregation by lane, project, day, or model exists anywhere in the renderer** —
  confirmed by grep for groupBy/reduce/keyed-by-date-or-model patterns across `src/renderer`;
  the only place those slices exist is the orphaned backend module above.
- Model/effort are read per-session for launch-config plumbing and single-lane badges only
  (`DashboardView.tsx:2127,2386,3023-3036,3288`, rendering via `lib/lane-meta.ts`) — never
  counted or grouped across sessions.
- Compaction is tracked only as the transient `phase` string for a status pill/animation
  (`RosterPanel.tsx:19,873`, `TaskBoard.tsx:698`, `chat-signal.ts:74-75`, `StatusWave.tsx`,
  `lane-lifecycle.ts:60`) — no event log, no count, and (per 5a) the backend never actually
  emits `"compacting"` regardless.
- Context-window fullness: not tracked anywhere in `src/renderer`.
- tool_result byte size: not surfaced as a metric anywhere; the only related code is a
  render-safety truncation cap in `ReportBody.tsx:9-11` (`ARTIFACT_CAP = 16 * 1024`), unrelated
  to measurement/display.
- `activeSubagents` (live count) is displayed as an "N sub" badge in several places
  (`ActivityDashboard.tsx:126-131`, `TaskBoard.tsx:611,632,648`, `SessionActivityView.tsx:80-81`,
  `SessionItem.tsx:269-279`, `SessionInfoBar.tsx:78-80`) — instantaneous only, no cumulative
  fan-out counter per lane/session/day. `computeFanMembership` (`lib/fan-out.ts`, called at
  `DashboardView.tsx:2991-2992`) is a different, also-live concept — the human-initiated
  "same task on N worktrees" badge, recomputed fresh from open terminals each render, not a
  history.

### 5c. Slices that would tell Juan a concrete tuning change

Given what's actually available (5a) vs. what's already computed but unconsumed (5b), the
slices that would turn into an actual decision — "move this role's effort down", "this lane on
Opus is burning the weekly cap for no measurable gain", "this project's turns are compacting
constantly and burning tokens on re-establishing context" — are:

- **By role/lane × model × effort, aggregated over a day/week:** total tokens and (if effort
  gets wired into the tailer, see gap in 5a) a token-per-outcome ratio. This is the one slice
  that maps directly onto the actual tuning knob (RosterPanel's per-role model+effort picker) —
  everything else is diagnostic, this one is actionable.
- **By project × day:** which project's spend dominates a session/week window, to catch one
  runaway project eating the shared plan cap before the plan meter (part 4, item 08) goes red.
  `ProjectUsage`/`DayUsage` already compute exactly this shape server-side — it's a matter of a
  consumer, not new backend work.
- **Compaction frequency, if captured:** a lane compacting every few turns is a concrete signal
  that its effort/context budget is mismatched to the task — currently invisible because the
  boundary event is dropped (5a). This is the highest-value gap to close if any backend work is
  in scope, since it's the one signal with no substitute anywhere else in the data.
- **tool_result size by lane:** already persisted per-turn (the one signal in this whole
  inventory that's both granular and historical) — a lane whose tool outputs run consistently
  large is a candidate for effort/verbosity tuning or a narrower toolset, and this needs no new
  capture, only a query over existing chat.db rows.
- **Fan-out count by lane over time:** currently only a live snapshot; a lane that fans out
  heavily is spending differently than one that doesn't, but there's no historical count to slice
  by day/project without persisting the `activity` timeline (currently rebuilt from scratch each
  restart) or reading `ToolBlock.caller` rows out of chat.db as a proxy.

### 5d. Two framings — reported, not decided

**Token view:** raw numbers — input/output/cache-read tokens (and cost, since the pricing table
already exists and is current per commit `1ed9af2`), sliced by role/model/project/day. This is
what `UsageStats`/`ModelUsage`/`ProjectUsage`/`DayUsage` already produce server-side; a consumer
here is close to a straight read of existing data. Legible to someone who thinks in tokens/cost
directly; less legible as "how close am I to being throttled."

**Plan-fraction view:** the same underlying numbers reframed as a share of the plan's actual
limits — session/week/model-cap percentages, the same units `plan-limits.ts` (part 4, item 08)
already uses for the always-visible meter. This would need translating token/cost sums into the
plan's own percentage units, which the meter's cache-TTL and reset-clause logic already models,
but nothing currently maps a historical slice (e.g. "this project last Tuesday") back into
plan-fraction terms — that mapping doesn't exist yet in either shell. More directly answers
"should I turn this lane down" in the same vocabulary the meter already trained the user to read,
at the cost of building a translation layer the token view doesn't need.

Both are buildable from data that already exists or is one query away (5b); the compaction and
per-turn-effort gaps (5a) are the two places actual new capture work would be needed, independent
of which framing is chosen.
