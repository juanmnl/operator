# Compacted idle lane reads "working" — 2026-10-14

Branch `operator/2f7c00`. Installed CLI: `claude 2.1.300`.

## How the phase is derived

`src/renderer/lib/session-status.ts` only maps `session.phase` to a status-wave state. The phase
comes from the main process, `electron/src/main/transcript.ts`:

- `Track` tails the lane's transcript JSONL and keeps `openTools`, `lastStopReason`,
  `lastWasUserPrompt`, `compacting` (with a 5-minute ceiling), and `openQuestions`.
- `derivePhase` ranks them: compacting > asking > open tools > `stop_reason: tool_use` >
  `lastWasUserPrompt` ("prompt sent, response not started") > `waiting`.
- `Transcript.tick` overrides the result with `running` while the pty is producing output, except
  when the derived phase is `compacting` or `asking`.

Operator installs no Claude Code hooks: no `PreCompact`, no `SessionStart`. The phase comes from
the transcript plus pty activity only.

## What the CLI writes (measured, not recalled)

I classified the records after every `compact_boundary` in `~/.claude/projects/*/*.jsonl`. There
were 108 boundaries, all `trigger: "auto"`, from versions 2.1.270 to 2.1.299. No transcript on
disk has a manual `/compact`, and none has a 2.1.300 compaction yet.

Mid-turn auto compaction (2.1.270 to 2.1.283, and still present later):
`tool_result` → `compact_boundary` → attachments → `user` with `isCompactSummary: true` →
attachments → assistant continuing the turn.

Idle compaction (new in 2.1.294; 56 instances, 2.1.294 to 2.1.299):
`assistant end_turn` → … (possibly an hour later) → `compact_boundary` → `user isCompactSummary`
→ attachments → `system`, `subtype: "informational"`, `level: "notice"`,
`content: "Compacted while idle, before the prompt cache expired"`. **No assistant record
follows.** The lane stays idle until someone prompts it. Example:
`-Users-juanmnl--operator-worktrees-web27-7de040/b120bd78-….jsonl`, lines 586–598 (2.1.299).

2.1.300 binary: `strings` shows the idle path (`compact:()=>this.compactConversation(...)`) still
appends `"Compacted while idle, before the prompt cache expired"` as a `notice`, and
`compactConversation` throws if a turn is in flight. So the notice only appears between turns.

Local slash commands (`/model`, and `/compact` takes the same path): a `user` record
`<command-name>/model…` followed by a `user` (2.1.276) or `system local_command` (later)
`<local-command-stdout>…` record. No assistant follows.

## Root cause

Two defects in `Track`, and both have to happen for the bug to show:

1. **The re-prime counted as a user prompt.** `applyUser` set `lastWasUserPrompt = true` and
   cleared `lastStopReason` for every text `user` record, `isCompactSummary` included. It also
   called `notePrompt`, so the re-prime was announced as a new work prompt (`prompt` event).
   The lane lifecycle reads that event as "the lane took up new work".
2. **Nothing ended an idle compaction.** `compacting` cleared only on a non-summary user record or
   a main-thread assistant record. An idle compaction writes neither.

Result for an idle lane: `compacting` (amber, and `canAnnounceTo` refuses dispatches) for 5
minutes, then the ceiling drops the claim, `derivePhase` reaches `lastWasUserPrompt` and returns
`running`. That `running` lasts until the next turn. Every lane left idle long enough for the CLI
to compact it ended up there. A manual `/compact` at idle reaches the same state through the
command-echo records, which also set `lastWasUserPrompt`. The same applies to any local slash
command at idle, `/model` included.

## Fix (`electron/src/main/transcript.ts`)

- `applyUser`: an `isCompactSummary` record and a local-command echo (`isLocalCommandEcho`:
  `<command-name>`, `<command-message>`, `<command-args>`, `<local-command-`) no longer set
  `lastWasUserPrompt` or clear `lastStopReason`. The re-prime is no longer passed to `notePrompt`.
  A real prompt still ends the compaction as before. The local-command stdout still ends it too.
- `applySystem`: a `system`/`informational` record whose content starts with
  `"Compacted while idle"` ends the compaction.
- The mid-turn path does not change: the boundary still sets `compacting` until the model speaks.
  If the ceiling passes first, the kept `lastStopReason: tool_use` makes it read `running`.
- If a future CLI changes the notice text, the 5-minute ceiling still applies, and with fix 1 the
  lane falls back to `waiting` instead of `running`.

## Test

`electron/src/main/transcript-compact.test.ts`, with two fixtures cut from real transcripts with
the text replaced. The sanitizer keeps record types, flags, ids, timestamps, stop reasons and
block types.

- `__fixtures__/compact-idle.jsonl`: 2.1.299 idle compaction, 22 records, ends at the notice.
- `__fixtures__/compact-midturn.jsonl`: 2.1.283 mid-turn compaction, 25 records, ends at the
  model's next tool call.

Cases: idle reads `waiting`. Idle past the ceiling reads `waiting`. Idle cut before the notice
reads `compacting`, then `waiting` once the notice is appended. The re-prime emits no `prompt`
event. A prompt after the idle compaction reads `running`. Mid-turn reads `compacting` before the
model speaks and `running` after its tool call. Mid-turn past the ceiling reads `running`. A
`/model` echo + stdout after `end_turn` reads `waiting`. A prompt-type command (echo plus an
`isMeta` expansion, as written by real 2.1.28x `/doctor` runs) reads `running`.

Before the fix, 5 of the 9 initial cases failed:

```
× reads `waiting` once the idle notice lands         Received: "compacting"
× still reads `waiting` after the compacting ceiling Received: "running"
× reads `compacting` between the re-prime and notice Received: "compacting" (after the notice)
× the re-prime is not announced as a work prompt     Received: [{ at: "2026-10-14T06:54:58.773Z" }]
× a local command at the end of a turn → waiting     Received: "running"
```

After the fix:

```
electron$ npm run typecheck        → clean (both tsconfigs)
electron$ npx vitest run           → Test Files 51 passed (51), Tests 901 passed (901)
root$     npx vitest run           → Test Files 117 passed (117), Tests 1778 passed (1778)
```

## Not done

- **Manual `/compact` is not verified against a real transcript**, because none exists on disk.
  The fix covers it through the local-command echo rule, and the test uses the real `/model`
  shape. Run one `/compact` in a lane and read its records to confirm.
- **Not GUI-verified.** The tests drive the real tailer over files on disk, but I did not watch an
  avatar in the running app.
- `src-tauri/src/transcript.rs` (the Tauri tailer, which the comments call the mirror) is not
  changed.
- The re-prime still appears in the lane's narration as a `user` message ("This session is being
  continued…"). That was the existing behaviour and is outside this bug.
