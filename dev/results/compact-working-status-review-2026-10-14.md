# Review: idle-compacted lane reads "working" — 2026-10-14

Branch `operator/2f7c00`, commit 41533e8, compared with main b8ae343. Installed CLI 2.1.300.
Reviewed: `electron/src/main/transcript.ts` (diff plus `applyUser`, `applySystem`,
`endCompaction`, `applyAssistant`, `phase`, `tick`), `transcript-compact.test.ts`, both fixtures,
the `prompt` event consumer in `electron/src/main/index.ts`, `canAnnounceTo`, and the 2.1.300
binary. No fixes made.

Method: I scanned every transcript in `~/.claude/projects` (338 projects), compared each fixture
record with its source record by uuid, read the relevant code paths in the 2.1.300 binary with
`strings`, ran the branch's tests from an exported copy of the tree, and ran 7 probe cases against
both the branch's and main's `transcript.ts`.

**Verdict: no regressions found. Mergeable.** The fix does what it claims for the common idle
compaction (55 of the 56 on disk). One real idle-compaction shape still reads `running`
(finding 1). That cause existed before this branch.

## Findings by severity

### Medium

**1. An idle compaction after a turn that ended without an assistant record still reads `running`.**
`transcript.ts:481-485`, `transcript.ts:549-551`.
Real case: `~/.claude/projects/-Users-juanmnl-Developer-web27/59ae5610-…jsonl`, lines 2150–2173
(2.1.296). A `/goal` Stop hook blocked the turn 9 times and was then overridden. The last record
was an `isMeta` user record, "Stop hook feedback: …", followed by `system/turn_duration`. No
assistant record came after it. 54 minutes later the lane was compacted while idle (boundary →
re-prime → notice).
- The `isMeta` feedback record set `lastWasUserPrompt = true`, and nothing clears it. The notice
  now ends the compaction, so `derivePhase` falls through to `lastWasUserPrompt` and returns
  `running`.
- Probe, same record shape: the branch reads `running` as soon as the notice lands. Main read
  `compacting`, then `running` after the ceiling. Both are wrong; this branch moves the lane
  straight to the end state.
- The same thing happens after an Escape interrupt (`[Request interrupted by user]` as the last
  user record), probe E: the branch reads `running`.
- How often: across all transcripts, 8 turn ends (`turn_duration`) had `lastWasUserPrompt` still
  set under the branch's rules: 5 after a `/goal` "A session-scoped Stop hook…" expansion, 1 Stop
  hook feedback, 2 interrupts. The other 7,880 turn ends were clean. The `/goal` cases are the
  user's own workflow, so this is not hypothetical.
- Consequence: `canAnnounceTo` (`src/renderer/lib/comms.ts:253`, `isBetweenTurns`) refuses the
  lane until its next turn, and the quit guard counts it as busy. This is the symptom the brief
  asked to fix.
- Fix direction, for Code: clear `lastWasUserPrompt` on `system/subtype:"turn_duration"`. It is
  written at every turn end, it is structured, and it has no text to match. Also clear it on the
  idle notice: in the 2.1.300 binary, `compactConversation` throws "a turn is in flight; the
  conversation compacts between turns", so a lane is never mid-turn at that notice.

### Low

**2. The idle notice is matched on its English prefix, and 2.1.300 has no structured field for it.**
`transcript.ts:118`, `transcript.ts:549`.
I looked for a more stable marker and did not find one:
- The idle path (`compact:()=>this.compactConversation({instructions:"",apiAttemptsLeft:{count:1}})`)
  passes no `origin`, so the boundary gets `trigger: C===void 0?"auto":"plugin"`, which is `"auto"`.
  Mid-turn auto-compaction also writes `"auto"`.
- The notice is built as `Bt("Compacted while idle, before the prompt cache expired","notice")`:
  text and level only.
- `compactMetadata` has the same keys on idle and mid-turn boundaries (2.1.294–2.1.299).
- `armTrigger: "idle"` exists in the binary, but only in telemetry; it is not written to the
  transcript.

All 56 notices on disk match the exact string. The other `informational` notices (cross-session
uds claims, "X is idle — finished a turn", hook-block warnings) do not match the prefix.

If the text changes, the fallback is the 5-minute ceiling and then `waiting`, not a stuck
`running`, so a change would cost 5 minutes of refused announces.

Optional hardening that needs no text: treat a boundary that arrives while the lane is between
turns as an idle compaction. Measured: in 55 of 56 idle boundaries the last main-thread assistant
record before the boundary had `end_turn`. In 0 of 48 mid-turn boundaries did it: 44 had
`tool_use`, and 4 had a real prompt before the boundary. Finding 1's fix (`turn_duration`) would
make this rule reliable.

**3. `!` bash-mode at idle still reads `running`.** `transcript.ts:122-125`.
`<bash-input>` and `<bash-stdout>`/`<bash-stderr>` are `user` records that Claude Code answers
itself, with no assistant after them. That is the same class as the local-command echo, but they
are not in `isLocalCommandEcho`. Probe F: `running` on both branch and main. There are about 170
`<bash-input>` records on disk. This existed before the branch; it is listed because the branch
fixes the rest of this class.

**4. A real prompt whose text starts with `<command-name>`, `<command-message>`, `<command-args>` or
`<local-command-` no longer sets `lastWasUserPrompt`.** `transcript.ts:122-125`, `482`.
Probe D: with a quiet pty the branch reads `waiting` until the first assistant record. Main read
`running`. In practice Claude Code's spinner keeps the pty active, so `tick` shows `running`
anyway. On main, `isInjectedTurn` already kept such a prompt out of the narration and out of
`notePrompt`, so nothing else changes. A real prompt that contains one of these tags later in the
text is unaffected (the check is `startsWith`). Negligible.

**5. A local command written as `system/local_command` does not end a compaction.** `transcript.ts:535-552`.
Probe C: boundary → re-prime → `system/local_command` echo and stdout reads `compacting` until
the ceiling, then `waiting`. Manual `/compact` does not take this path in 2.1.300 (see "Checked"
below). Two interactive transcripts write a local command's echo as `system/local_command`
(`/model` in 2.1.278, `/login` in 2.1.296). That only matters if one lands between a boundary and
a missing closing record. The lane's note says "the local-command stdout still ends it too". That
holds only for a `user`-shaped stdout. In 2.1.300 a regular local command's stdout is
`Ey(...)` = `system/local_command`, so the `user` echo ends the compaction, not the stdout.

### Info

**6. The Tauri mirror is not updated.** `src-tauri/src/transcript.rs`. The comments at
`transcript.ts:89` and on `Track` say the two are kept in lockstep. The Rust file was last changed
2026-09-06, and it already lacks the `asking` phase, so the two were out of step before this
branch. `build.yml` still builds `src-tauri`. Decide whether to keep the mirror or delete the
lockstep comments.

**7. The re-prime is still narrated, and can become the session summary.** `transcript.ts:489-503`.
This behavior is older than the branch and the lane's note already lists it. If the file has no
earlier real prompt, the summary becomes "This session is being continued…". The idle fixture
shows this: it has no real prompt before the re-prime.

## Checked and clean

- **Mid-turn auto-compaction still reads `compacting`, then `running`.** On disk there are 48
  mid-turn boundaries (2.1.270–2.1.289). In 44 the last assistant record before the boundary had
  `stop_reason: tool_use`. In the other 4 a real prompt came before the boundary (compaction at
  the start of a turn). Under the branch, the re-prime no longer clears `lastStopReason`, so both
  shapes read `running` after the ceiling. The longest boundary→assistant gap on disk is 9.5 s,
  so the ceiling never matters there. The fixture tests cover this.
- **Manual `/compact` (2.1.300 binary).** `/compact` is `type:"local"`. On a `compact` result the
  REPL builds `E=[O,v,stdout]`, where `O` is the caveat (`rbe()`), `v` is the echo, and stdout is
  `<local-command-stdout>…`. All three are `Re()` user records. They are appended to
  `messagesToKeep`, so they land after the boundary and the summary. The echo ends the compaction
  (it is not `isCompactSummary`), and `isLocalCommandEcho` keeps `lastWasUserPrompt` false. Probe
  B: branch `waiting`, main `running`. Still not seen in a real transcript: no boundary on disk has
  `trigger: "manual"`.
- **Prompt-type commands still read `running`.** `/goal`, `/doctor`, `/claude-api`, and the
  binary's `query` path all write the expansion as an `isMeta` user text record, which still sets
  `lastWasUserPrompt`. I checked a real `/goal` sequence (2.1.295: echo, user stdout, `isMeta`
  expansion, assistant) and the branch test for `/doctor`.
- **A prompt typed during an idle compaction** (lands before the notice) reads `running`
  (probe G).
- **`prompt` event consumers.** The only main-process listener is `index.ts:390` →
  `cancelReleasesBefore`. Local-command echoes were already excluded on main by `isInjectedTurn`,
  so nothing changes for them. The re-prime no longer emits a `prompt` event. On main it did,
  because `isWorkPrompt` is true for it. So on main, a released lane that got compacted while idle
  cancelled its own release: it was not retired on the next dispatch, and its worktree was kept at
  exit. The branch fixes that. The renderer's submission cancel path does not read
  transcript records and is unaffected. `canAnnounceTo` gates on `isBetweenTurns(phase)`. On main
  an idle-compacted lane read `running` until its next turn; on the branch it reads `waiting` and
  can receive announces again.
- **The fixtures match the real transcripts.** Every fixture record matches its source record
  (looked up by uuid) on type, subtype, `isSidechain`, `isCompactSummary`, `isMeta`,
  `stop_reason`, content block types, attachment types and timestamps. What was left out: extra
  keys (`gitBranch`, `requestId`, `rendered`, `slug`, `content` on `away_summary`, …) and, per gap,
  6 metadata records (`last-prompt`, `custom-title`, `agent-name`, `mode`, `permission-mode`,
  `atis-latch`) that `Track.apply` ignores. Sources: idle =
  `-Users-juanmnl--operator-worktrees-web27-7de040/b120bd78-…jsonl` lines 566–599 (2.1.299);
  mid-turn = `-Users-juanmnl--operator-worktrees-uwazi-app-ad9c40/b2a3b0a2-…jsonl` lines
  3571–3613 (2.1.283).
- **Tests.** In an exported copy of the branch, `npx vitest run src/main/transcript*`: 5 files,
  95 tests, all passed. I did not run the full suite.

## Recommendations for the coordinator

- Merge as is, or first ask Code for the `turn_duration` / idle-notice clear of
  `lastWasUserPrompt` (finding 1). Finding 1 does not block the merge: it existed on main.
- The bash-mode exclusion (finding 3) is a one-line follow-up for Code.
- Someone should run one `/compact` in a real lane and read the records to confirm the
  binary-derived order.

Probe file (not in the repo): `/private/tmp/claude-501/-Users-juanmnl-Developer-operator/05545980-1a16-4848-a3e7-91b41b141178/scratchpad/tree/electron/src/main/zz-probe.test.ts`.
