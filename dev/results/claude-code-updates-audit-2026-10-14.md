# Claude Code updates audit, 2.1.288 to 2.1.300 (2026-10-14)

Scope: what changed in Claude Code since the newest version Operator's code was checked against, and what Operator should do about it. Research only; no code was changed.

## Method and baseline

- Installed CLI: `claude --version` prints `2.1.300`; `~/.local/bin/claude` links to `~/.local/share/claude/versions/2.1.300`.
- Baseline: the highest version cited as "verified against the installed binary" in Operator's code is **2.1.287** (`src/renderer/lib/launch-args.ts:65`). Older markers: 2.1.283 (`bus-name.ts:10`, `session-layout.ts:140`), 2.1.261 (`session-settings.ts:73`), 2.1.257 (`effort.ts:4`, `types.ts:30`), 2.1.235 (`SkillsSection.tsx:13`). Audited range is therefore 2.1.288 to 2.1.300. The changelog has no 2.1.297 or 2.1.298 entry.
- Sources, all checked locally: `CHANGELOG.md` from the claude-code repo (the same text is embedded in the binary, found at `strings` line 362955); `claude --help`; string extraction from the 2.1.300 binary (hook list, settings schemas, baked model catalog and price tables); real transcripts and session descriptors on this machine written by 2.1.294 to 2.1.300.
- Pricing items below are partly older than 2.1.288 (Opus 5.5 is 2.1.280, Sonnet 5.5 is 2.1.284). They are included because the price table in `usage.ts` is wrong for all of them today.

Priority key: **P1** = produces wrong numbers or wrong lane state today; **P2** = real but bounded; **P3** = watch or optional.

## Summary table

| # | Item | Operator file | Action | Priority |
|---|------|---------------|--------|----------|
| 1 | Price table wrong for Haiku 5.5, Opus 5.5, Sonnet 5.5, Mythos 5.1 | `electron/src/main/usage.ts:28-36` | Add explicit rows; see section 1 | P1 |
| 2 | Idle compaction leaves a lane in `compacting` for 5 minutes | `electron/src/main/transcript.ts:515-522, 90, 240` | End compaction on the `informational` "Compacted while idle" record | P1 |
| 3 | Transcripts now carry `api-request*` records (about half of a file's bytes) | `electron/src/main/usage.ts:90-140`, `transcript.ts` | Skip them cheaply; measure scan time | P2 |
| 4 | Session descriptor has a new `waiting` status plus `waitingFor` | `electron/src/main/session-bus.ts:46-62` | Optional: use as an asking/attention signal | P3 |
| 5 | Haiku 5.5 long-prompt price tier above 100K tokens | `usage.ts` | Handle with item 1 | P2 |
| 6 | Opus fast-mode rate differs by model | `usage.ts:35` | Handle with item 1 | P2 |
| 7 | `--permission-mode` help lists `manual`, not `default` | `launch-args.ts:48-52`, `types.ts:249` | No change needed; note only | P3 |
| 8 | Hook list grew to 33 events | none (Operator registers no hooks) | None | none |
| 9 | Resume and compaction fixes in 2.1.288, 2.1.290, 2.1.300 | restore path | None; positive for crash resume | P3 |
| 10 | Exit force-kills background commands after 1.5 s | quit and relaunch paths | Be aware when verifying relaunch | P3 |

## 1. Model IDs and pricing (P1)

Claude Code now carries a baked model catalog (`PMr`, with `schema_version:1`, plus a remote `https://downloads.claude.ai/model-catalog/v1/schema.json` that is fetched). Per-model price tiers read from the 2.1.300 binary, $ per million tokens:

| Model id | in / out | cache write 5m / 1h | cache read | notes |
|----------|----------|---------------------|-----------|-------|
| `claude-haiku-5-5` | 0.10 / 0.50 | 0.125 / 0.20 | 0.01 | above 100K prompt tokens: 0.50 / 2.50, cache read 0.05, write 0.625 / 1.00 |
| `claude-haiku-4-5` | 1 / 5 | 1.25 / 2 | 0.10 | |
| `claude-sonnet-5` | 2 / 10 | 2.5 / 4 | 0.20 | |
| `claude-sonnet-5-5` | 2 / 10 | 2.5 / 4 | **0.10** | cache read lowered in 2.1.296 (was 0.20) |
| `claude-opus-5` | 5 / 25 | 6.25 / 10 | 0.50 | |
| `claude-opus-5-5` | **4 / 20** | 5 / 8 | **0.20** | |
| `claude-fable-5` | 10 / 50 | 12.5 / 20 | 1.00 | |
| `claude-fable-5-1` | 10 / 50 | 12.5 / 20 | 0.25 | |
| `claude-mythos-5` | 10 / 50 | 12.5 / 20 | 1.00 | |
| `claude-mythos-5-1` | 10 / 50 | 12.5 / 20 | **0.25** | |

Fast mode (function `Jft`, read from the binary): `claude-opus-5-5` 8 / 40 with cache read 0.40; `claude-opus-4-8` and `claude-opus-5` 10 / 50 with cache read 1; any other Opus 30 / 150 with cache read 3.

What `rates()` in `usage.ts` does today and where it is wrong:

- `includes('haiku')` returns 1 / 5. Haiku 5.5 is 0.10 / 0.50, so Haiku 5.5 spend is overstated about 10x. Haiku 4.5 is correct.
- `includes('opus')` returns 5 / 25 with cache read 0.5. Opus 5.5 is 4 / 20 with cache read 0.2: input and output overstated 25%, cache reads overstated 2.5x. Cache reads are most of an agent session's tokens, so the total overstatement is close to the high end.
- `includes('sonnet-5')` also catches `sonnet-5-5` and returns cache read 0.2. Sonnet 5.5 is 0.10 now: cache reads overstated 2x.
- `claude-mythos-5-1` falls to the 0.1x default (cache read 1.0). The binary lists 0.25. The comment at `usage.ts:25` says this was "open"; it is answered.
- Fast mode: `opus` with `fast` returns 10 / 50 for every Opus. Opus 5.5 fast is 8 / 40.
- Opus 4.0 and 4.1 are 15 / 75 in the catalog; the table returns 5 / 25. This only affects historical records. Low value, but the fix is the same edit.
- Haiku 5.5 has a long-prompt tier keyed on `input + cache_read + cache_creation` above 100,000 (function `lI`). `cost()` has no such concept.

Recommended action (Code lane):

1. Add rows ahead of the substring fallbacks, most specific first: `haiku-5-5`, `opus-5-5` (with a fast rate of 8 / 40), `sonnet-5-5` (cache read 0.10), `mythos-5-1` with `fable-5-1` (cache read 0.25).
2. Keep the pessimistic default for unknown ids. Replace the "open" comment.
3. Add the long-prompt branch for `haiku-5-5` in `cost()`.
4. Update `usage.test.ts`; its current cache cases use `claude-opus-4`.
5. Consider reading the model catalog's tier names, not copying numbers again. The tier names (`tier_4_20_cache_read_0_20`) encode the numbers, but the catalog is internal and may change shape; copying with a dated comment, as now, is the safer choice.

`src/renderer/lib/roster.ts:5-23` matches family by substring and uses the aliases `fable`, `opus`, `sonnet`, `haiku`. These still resolve (`--model` help text confirms the aliases). No change.

## 2. Idle compaction (P1)

Change (2.1.299): a conversation of 200K+ tokens left idle about 54 minutes is compacted before the one-hour prompt cache expires. `idleCompaction: false` in settings and `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` control it (the binary contains both strings).

What the transcript looks like, verified in two real files (2026-10-11 20:19 and 2026-10-14 06:54): `system/compact_boundary` (trigger `auto`, not a new trigger value), then `user` with `isCompactSummary:true`, then several `attachment` records, then `system/informational` with content "Compacted while idle, before the prompt cache expired". No `assistant` record follows, because nobody prompted.

Operator behaviour: `applySystem` sets `compacting = true` on the boundary (`transcript.ts:517`). The only things that clear it are a real user prompt or an assistant record (`transcript.ts:467, 531`), or the 5-minute ceiling (`COMPACTING_CEILING_MS`, line 91). So every idle compaction shows the lane as `compacting` for up to 5 minutes. `canAnnounceTo` refuses a compacting lane (comment at `transcript.ts:500`), so a dispatch to that lane is held for those minutes. The lanes most likely to be affected are the idle coordinators, which are the ones that receive dispatches.

Recommended action: in `applySystem`, treat `subtype === 'informational'` with content starting "Compacted while idle" as the end of compaction (call `endCompaction`). A text match is fragile across wording changes; the structural alternative is to end compaction when a boundary is followed by the summary record and no further work arrives within a short window. Simplest safe version: both. Add a fixture from the real records above.

## 3. New transcript record types and size (P2)

Counted across the 60 most recently modified transcripts, records with `version >= 2.1.288`: `assistant` 11,367, `attachment` 11,268, `user` 6,798, `system` 910, `api-request` 107, `api-request-shape` 8. Also present in the current session file: `api-request-blob`, `mode`, `permission-mode`, `custom-title`, `agent-name`, `last-prompt`, `atis-latch`, `file-history-snapshot`.

- 2.1.300 changelog: "local session transcripts also record each API request's system prompt, tools and parameters". This is the `api-request` family. In this session's own file, 860 KB of 1.78 MB (48%) is `api-request`, `api-request-shape` and `api-request-blob`.
- `usage.ts:90-140` reads every `.jsonl` under `~/.claude/projects` whole with `readFile(..., 'utf8')`, splits on newline and runs `JSON.parse` on every line, then discards lines without `message.usage`. The parse cost of the new records is paid and thrown away. The 30 s cache bounds frequency, not cost. `transcript.ts` (the tailer) reads by byte offset, so its cost is per appended byte; each model request now appends one `api-request` line, so tail volume is up too.
- Operator ignores unknown `type` values (`transcript.ts:375-378` switch has no default branch that fails), so nothing breaks.

Recommended action: in the `usage.ts` loop, test `line.startsWith('{"type":"api-request')` before `JSON.parse` and skip. Do the same in the tailer before parsing. Time one scan before and after; I did not measure scan time, only byte share.

New fields on `assistant` records that Operator does not read: `perTurnEffort` (present on 11,366 of 11,367), `requestRef`, `requestedModel`, `advisorModel`, `thinkingDurationMs`, `truncatedAfterOutput`, `error`/`isApiErrorMessage`. `message.usage` gained `iterations` (an array of per-iteration usage), `fallback_credit`, `output_tokens_details.thinking_tokens`, `inference_geo`. Operator's cost code uses the top-level counters. In the sample record the top-level `input_tokens` equals the single iteration's, so no double count is visible, but I did not test a turn with a server-side tool loop. Worth one check before relying on the totals for server tools.

`effort` (top level, 11,362 of 11,367) is still present, so `transcript.ts:529-539` and `usage.ts` are unaffected. `perTurnEffort` is new and may differ from `effort` when a subagent or the `Agent` tool's new `effort` parameter (2.1.292) is in play; not needed.

## 4. Session bus and cross-session messaging (P3)

Descriptors in `~/.claude/sessions/<pid>.json` on this machine (18 live) have these keys: `pid, sessionId, cwd, startedAt, procStart, version, peerProtocol, peerFeatures, kind, entrypoint, pidDomain, messagingSocketPath, name, nameSource, nameSince, updatedAt, status, statusUpdatedAt`, plus `bridgeSessionId` (5 of 18) and `waitingFor` (1 of 18).

- Required fields `parseBusSession` uses (`sessionId`, `messagingSocketPath`, `pid`) are all still present. `name`, `status`, `startedAt`, `cwd` are as before. No break.
- `status` values observed: `idle`, `busy`, `shell`, and **`waiting`** (with `waitingFor: "input needed"`). Operator stores `status` as a string and does not branch on it (`session-bus.ts:59`), so `waiting` is harmless. It is a free, real-time "this lane needs an answer" signal and could back the `asking` phase for permission prompts, which the transcript cannot show (the tailer only sees `AskUserQuestion`). Not verified: whether `waiting` also covers permission prompts. Needs a live test by a human.
- `peerFeatures` is `['notify_idle', 'reply_across_default_dirs', 'artifact_yield']`. `kind` is `interactive` for all 18; `claude --bg` sessions will presumably show another kind, not observed.
- The wrapper regex in `src/shared/prompt-kind.ts:27` (`<cross-session-message\b[^>]*>`) tolerates added attributes. The 2.1.300 binary's parser also reads `from-session`, `hop-chain`, `from-name`, `from-mode`; none matter to Operator.
- Behaviour changes that touch the bus: 2.1.290 `--restricted` sessions no longer open the messaging socket (Operator does not launch with it); 2.1.292 delivery notices distinguish similarly named recipients; 2.1.299 `SendMessage` finds a subagent by name after the CLI restarted (names set before the last compaction still need the agent id). `claude agents`, `claude attach`, `claude logs`, `claude stop`, `claude respawn`, `claude rm` are new top-level commands for background sessions; Operator does not use them.

## 5. Resume, continue, session ids (P3)

- `--resume`, `--continue`, `--session-id`, `--fork-session`, `--name` are all still in `--help` with the semantics Operator relies on (`launch-args.ts:44-45, 62`).
- 2.1.288: `--resume` no longer drops files and context a compaction had just restored; a resumed session no longer sometimes fails to save the last response; resume no longer loads a transcript cut short when the file is rewritten during the load. 2.1.300: the first entry written after a resume is no longer lost when a crash had cut the last transcript line short. All four bear on the crash and relaunch resume work from 2026-10-06. They need no Operator change and make the resume path more reliable. A relaunch test on 2.1.300 would confirm it.
- 2.1.290 and 2.1.292: plan mode is now restored on `--resume` and `/resume`. Operator passes `--permission-mode` only for non-default modes; a lane resumed in plan mode will come back in plan mode on its own, which may differ from the saved launch option. Low risk; mention in QA notes.
- The resume line printed at exit now names the session by id, not by name (2.1.299). If anything in Operator parses that exit line, it breaks; I found no such parse in `src` or `electron/src` (not exhaustively checked outside those directories).
- `CLAUDE_CODE_TRANSCRIPT_LOCAL_GC` (2.1.296) can rewrite a large transcript file in place. The tailer already handles a shrinking file by re-reading from zero (`transcript.ts:327`). No change.

## 6. Settings, permission modes, effort (P3)

- `--permission-mode` choices in `--help`: `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`. `default` is not listed but is still accepted (`claude --permission-mode default --version` exits 0; `bogus` is rejected with the choice list). The settings enum for `defaultMode` is `["acceptEdits","auto","bypassPermissions","default","dontAsk","plan"]`. Operator omits the flag for `default` (`launch-args.ts:48`), so it is unaffected. If the UI ever offers an explicit "manual" label, `manual` is the name the CLI now prints. `types.ts:249` has the union `'default' | 'auto' | 'bypassPermissions'`; `acceptEdits`, `dontAsk` and `plan` are not offered. Not a defect.
- `--effort` accepts `low, medium, high, xhigh, max`; an unknown value prints a warning and is ignored (`claude --effort ultra`). This matches `effort.ts`.
- `settings.json` `effortLevel` schema in the binary is still `enum(["low","medium","high","xhigh"]).catch(undefined)`, so `settingsEffort()` (max to xhigh) is still correct. New keys: `maxEffortLevel` (top level and per model under `modelSettings`), a per-model `effortLevel`, and per-model `autoCompactWindow`. `/effort` is saved per model since 2.1.251 and a saved level no longer applies to newly released models (2.1.280). Operator's app-wide default write to the global file therefore applies only to models that have no per-model entry; worth knowing when a user reports "Opus 5.5 ignores my default effort".
- `remoteControlAtStartup` is still a settings key (`remoteControlAtStartup:()=>H().optional()`). The `--settings` file mechanism in `session-settings.ts` is unchanged.
- `--autocompact <auto|tokens>` is a new launch flag (100k to 1M). Operator could expose it per role; optional.
- Settings files that fail validation are now reported on stderr in `-p` runs (2.1.299). No effect on interactive lanes.

## 7. Hooks (no action)

The hook event list in the 2.1.300 binary is: `PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, UserPromptSubmit, UserPromptExpansion, SessionStart, SessionEnd, Stop, StopFailure, SubagentStart, SubagentStop, PreCompact, PostCompact, PreModelSwitch, PostModelSwitch, PermissionRequest, PermissionDenied, Setup, TeammateIdle, TaskCreated, TaskCompleted, Elicitation, ElicitationResult, ConfigChange, WorktreeCreate, WorktreeRemove, InstructionsLoaded, CwdChanged, FileChanged, DirectoryAdded, MessageDisplay`. Operator registers no hooks; the `Stop`, `SubagentStart`, `UserPromptSubmit` names in `src/shared/types.ts:62-77` describe fields derived from the transcript. Behaviour changes that could surprise a lane's own plugins but not Operator: `UserPromptSubmit` now runs before skill or slash command expansion (2.1.299); `updatedInput` from PreToolUse and PermissionRequest is validated (2.1.300); `CLAUDE_EFFORT` is exposed to hooks.

One item that could matter to a future Operator hook feature: the 2.1.300 binary includes `PreModelSwitch` and `PostModelSwitch`, which would give a per-lane model-change event without tailing the transcript. Not needed today.

## 8. Status line (no action)

Operator has no status line integration (no `statusLine` match in `src` or `electron/src`). Changes: `subagentStatusLine` payload gained `agentType` (2.1.293); the status line cost figures follow the price changes in section 1; the percentage shown no longer exceeds 100% (2.1.299). None apply.

## 9. Compaction (beyond section 2)

- `compactMetadata` now carries `trigger`, `preTokens`, `durationMs`, `preCompactDiscoveredTools` (seen in a 2026-10-14 record). `usage.ts:107-117` reads `preTokens` and `postTokens`. Checked across all transcripts modified since about 2026-10-08: 56 of 56 boundaries have `compactMetadata` and `postTokens`. Older records (before that window) include boundaries without `compactMetadata`; `usage.ts` already falls back to 0 for those. No action.
- Auto-compact window is per model (2.1.288) and settable per subagent (2.1.296). 1M-context models compact near the limit (2.1.260). Nothing in Operator depends on the threshold.

## 10. Other changes noted, not requiring action

- Exit force-kills background commands still running 1.5 s after being asked to stop (2.1.300). Operator's dev-server leak note (server is a pty grandchild) gets slightly better; relaunch verification should not expect leftover processes.
- Worktrees: `--worktree` fixes for reftable repos and bare repos; plugin `WorktreeCreate` and `WorktreeRemove` hooks now run with `--worktree`. Operator creates its own worktrees under `~/.operator/worktrees` and does not pass `--worktree`.
- Models: Fable 5.1 is the default Fable (2.1.257); `opus` alias is Opus 5.5 (2.1.280); `sonnet` is Sonnet 5.5 (2.1.284); `haiku` is Haiku 5.5 (2.1.293). Haiku 5.5 and Opus 5.5 default effort is `medium`; Opus 5, Sonnet 5, Fable 5.x default `high`. Operator's seeded roster pins efforts explicitly (`roster.ts:343-350`), so defaults only matter for unpinned lanes.
- `Agent` tool takes an `effort` parameter (2.1.292); a lane's subagents may run at a different effort than the lane's `effort` field. Operator already treats sidechain effort as not the lane's.

## Items not verified

- Whether the `waiting` descriptor status fires for permission prompts as well as questions.
- Scan-time impact of `api-request*` records on `usage.ts` (byte share measured on one file only).
- Whether `usage.iterations` double counts in a turn with server-side tools.
- `claude --bg` descriptor `kind` values.
- 2.1.297 and 2.1.298: no changelog entry exists; assumed unreleased or skipped.
