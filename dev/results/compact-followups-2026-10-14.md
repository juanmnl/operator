# Compaction follow-ups — 2026-10-14

Branch `operator/b3a2c0`, based on main 3c46abc. Follows Review's
`dev/results/compact-working-status-review-2026-10-14.md` (in the main checkout, untracked).
Changed: `electron/src/main/transcript.ts`, `electron/src/main/transcript-compact.test.ts`, new
fixture `electron/src/main/__fixtures__/compact-idle-after-hook.jsonl`. The Tauri mirror
(`src-tauri/src/transcript.rs`) is not touched, as asked.

## What changed

1. **`system/turn_duration` clears `lastWasUserPrompt`** (Review finding 1, medium). A turn that
   ended on a `user` record (a `/goal` Stop hook overridden after nine blocks, or an Escape
   interrupt) left the flag set, so after an idle compaction the lane read `running` until its
   next turn. `turn_duration` is written at every main-thread turn end and has no text to match.
2. **The idle notice also clears `lastWasUserPrompt`.** Review found that the 2.1.300 binary
   refuses to compact while a turn is in flight, so a prompt flag at that notice is stale. This
   covers an idle compaction whose turn end was not recorded.
3. **`!` bash mode no longer reads `running`** (finding 3, low). `<bash-input>`, `<bash-stdout>`
   and `<bash-stderr>` are added to `isLocalCommandEcho`, the same check the slash-command echoes
   use.
4. **Text-free idle rule** (finding 2, low). A new `turnEnded` flag is set by a main-thread
   `turn_duration` and cleared by a real prompt or a main-thread assistant record. A
   `compact_boundary` that arrives while `turnEnded` is set still counts as a compaction but does
   not enter `compacting`: the boundary is written after the compaction has finished, and no turn
   follows it. The "Compacted while idle" text match stays, and now only matters when no
   `turn_duration` came before the boundary.

## Measurements behind it (all transcripts in `~/.claude/projects`)

- 7,891 main-thread `turn_duration` records, none on a sidechain. The next main-thread
  user/assistant record was a user record in 7,484 cases and end of file in 406. In 1 case it was
  an assistant record with no user record before it (umbra, 2.1.296: a `/login` local command,
  then a turn started without a `user` record). That is a new turn, not more of the old one, and
  the assistant record clears the flags anyway.
- At those turn ends the last main-thread stop reason was `end_turn` 7,871 times,
  `stop_sequence` 18 and `tool_use` 2. The 2 `tool_use` cases are Escape interrupts on
  `AskUserQuestion`, where the interrupt text record had already cleared `lastStopReason`.
- Boundaries: 56 idle (the notice comes before any assistant) and 48 mid-turn. `turnEnded` was set
  at all 56 idle boundaries and at none of the 48 mid-turn ones. No real `user` record lies
  between an idle boundary and its notice on disk, so clearing the prompt flag at the notice
  loses nothing seen in practice.

## Fixture

`compact-idle-after-hook.jsonl` is cut from
`~/.claude/projects/-Users-juanmnl-Developer-web27/59ae5610-…jsonl` lines 2149–2173, the case
Review named. The records carry `version: "2.1.295"` (Review wrote 2.1.296). Kept: record types,
subtypes, `isMeta`, `isCompactSummary`, `isSidechain`, stop reasons, attachment types,
timestamps, uuids. Replaced: assistant text, the hook feedback text, the summary. Dropped: extra
keys and the metadata records (`last-prompt`, `custom-title`, `agent-name`, `mode`,
`permission-mode`, `atis-latch`, `bridge-session`) that `Track.apply` ignores. Claude Code's own
`informational` texts are kept verbatim.

## Tests

New or changed in `transcript-compact.test.ts`:

- Idle fixture cut before the notice now reads `waiting`, also past the ceiling (text-free rule).
  This replaces the old "reads `compacting` between the re-prime and the notice" test: with
  `turn_duration` before the boundary there is no compacting window any more.
- Idle fixture without its `turn_duration` reads `compacting` until the notice, then `waiting`
  (text rule still works).
- Hook fixture: `running` while the hook holds the turn, `waiting` at `turn_duration`, `waiting`
  after the compaction and past the ceiling, and `waiting` when `turn_duration` is removed (the
  notice clears the flag).
- Escape interrupt shape (2.1.274): `waiting` after `turn_duration`.
- `!` bash mode at the end of a turn: `waiting`.

Against the old `transcript.ts` the 6 new assertions fail and the other 11 pass. With the change:

```
electron$ npx vitest run src/main/transcript
 Test Files  5 passed (5)
      Tests  102 passed (102)
electron$ npm run typecheck        # both tsconfigs, no errors
electron$ npx vitest run
 Test Files  51 passed (51)
      Tests  908 passed (908)
root$ npx vitest run
 Test Files  117 passed (117)
      Tests  1778 passed (1778)
```

Not GUI-verified.

## Left out

- **A `!` bash command still counts as a work prompt.** It goes through `isWorkPrompt` and
  `notePrompt`, so running `!git status` in a released lane cancels its release, and the command
  shows in the narration. The brief asked for the phase fix only. If that should change, add the
  bash prefixes to `isInjectedTurn` too; that also hides them from the narration.
- Review findings 4, 5 and 7 (a real prompt that starts with a command tag, `system/local_command`
  not ending a compaction, the re-prime in the narration) were not in the brief.
- Tauri mirror (finding 6), as asked.
- A turn started by a queued prompt without a `user` record (the one umbra case) leaves
  `turnEnded` set until its first assistant record. A compaction in that gap would not read
  `compacting`; the pty is active then, so `tick` shows `running` anyway.
