# Review r2: compaction follow-ups — 2026-10-14

Branch `operator/63300` @ 98bba77: d0fe20c, then 43c7fa2 merging main a29c015, then the fix
103db5e and the note 98bba77. It replaces `operator/b3a2c0`. Compared against
`compact-followups-review-2026-10-14.md`. No fixes made.

**Verdict: every item from round 1 is addressed. Mergeable.** Three Lows remain, all theoretical
or already present on main.

## Suites on the branch head

These ran on an exported copy of 98bba77 in the scratchpad.

- electron `npx vitest run`: 51 files, 936 tests, all pass. `npm run typecheck`: clean.
- root `npx vitest run`: 117 files, 1778 tests, all pass.
- a29c015 is an ancestor of the branch, so the merge from main is in. `isApiRequestLine` with the
  exact three types is present in `poll()`.

## The four items from the brief

**1. Is the bash change fully reverted?** Yes.
- `isLocalCommandEcho` is back to main's four prefixes (`transcript.ts:122-126`). The bash
  prefixes moved to a separate `isBashModeRecord`, and `applyUser` consults that only through
  `isEcho`.
- The round-1 test "`!` bash mode at the end of a turn leaves the lane `waiting`" is removed. In
  its place:
  - "reads `running` from the command until the reply, then `waiting`"
  - "a compaction before the reply reads `compacting`"
  - the two caveat tests
- Probe A (bash after `turn_duration`, before the reply) reads `running`, which matches main.

**2. Can `bashUnqueried` leak onto a later bash command or a real prompt?** Not on any shape that
exists on disk or in the 2.1.300 binary.
- Every main-thread user text record sets the flag to `startsWith('<local-command-caveat>')`, and
  the bash output record clears it after use.
- Probes, all correct:
  - C: an unqueried command, a turn, then a queried command → `running`.
  - C2: the same with no turn between → `running`.
  - D: a slash command's caveat, its echo, then `!ls` → `running`.
  - F: a caveat, then a real prompt → `running`.
  - H: a caveat and `<bash-input>`, then a real prompt → `running`.
- On disk, every one of the 7,653 caveats is followed by a main-thread user text record: the
  `<command-name>` echo 7,651 times, a `<bash-input>` once and a real prompt once. So the flag is
  always reset before anything else can read it.
- In the binary, a regular local command returns `[v, y]`: `v` is a `Re()` user echo and `y` is the
  `system` stdout. A bash command that skips the query returns `[rbe() caveat, d, stdout]`.
- The only leak is synthetic. Probe E: a caveat, then a slash command written entirely as
  `system/local_command`, then a queried `!ls` reads `waiting`. The two system-shaped commands on
  disk (2.1.278 `/model`, 2.1.296 `/login`) had no caveat before them. See Low 1.

**3. Does an enqueue clear `turnEnded`?** Yes. `applyQueueOp` clears it on every `enqueue`, before
the content check (`transcript.ts:427-431`).
- Probe I: `turn_duration`, an enqueue, then a boundary reads `compacting`. The new test "a
  main-thread enqueue clears it" covers the same case.
- An enqueue that is withdrawn without a turn (`popAll`) leaves `turnEnded` false. The next idle
  compaction then falls back to the notice rule, `compacting` until the notice (probe M). That is
  the safe direction. See Low 3.

**4. Does the notice clear `lastWasUserPrompt` only while compacting, closing the race, without
leaving a real idle compaction reading `running`?** Yes.
- The race: probe L puts a prompt between the compaction and its notice, and reads `running`. The
  new tests cover both the case with `turn_duration` and the case without it.
- A real idle compaction after `turn_duration`: `turn_duration` already cleared the flag, and the
  boundary does not enter `compacting`. The notice therefore has nothing to clear, and the lane
  reads `waiting` (probe J; fixture tests).
- The stale flag with no `turn_duration` (hook feedback, then boundary, then notice): the boundary
  enters `compacting`, so the notice still clears the flag, and the lane reads `waiting` (probe K).
- Can a stale flag reach a notice while `compacting` is false? Any non-echo text record that sets
  the flag also clears `turnEnded`, so the boundary that follows it does enter `compacting`. The
  only path that would not is a flag set after `turn_duration` without clearing `turnEnded`, and
  no such path exists in `applyUser`.

## Findings by severity

### Low

**1. A caveat followed only by `system`-shaped records carries over to the next bash command.**
`transcript.ts:532-541` (`isEcho`).
Probe E reads `waiting` for a queried `!ls` after that sequence. It needs a caveat with no
user-text echo after it, which neither the binary nor any of the 7,653 real caveats produces. The
fix, if wanted: also reset `bashUnqueried` in `applySystem` and on `turn_duration`.

**2. An interrupted unqueried bash command still leaves the lane reading `running`.**
Probe G: a caveat, `<bash-input>`, then `[Request interrupted by user]`. The binary writes exactly
this shape for an interrupted command: `[rbe(), d, uk(…)]`. The interrupt is a non-echo text record,
so it sets the flag, and no turn or `turn_duration` follows. Main behaves the same, because
`<bash-input>` set the flag there too. Treating an interrupt that directly follows an unqueried
`<bash-input>` as an echo would close it.

**3. A withdrawn enqueue (`popAll`, with no turn) leaves `turnEnded` false until the next turn.**
The next idle compaction reads `compacting` until its notice. This is the text-only fallback, and
it is safe: it never reads `running`.

## Recommendations for the coordinator

- Merge `operator/63300`, in place of `operator/b3a2c0`.
- Lows 1 and 2 are optional one-liners for Code. Low 3 needs nothing.

Probe file (not in the repo): `/private/tmp/claude-501/-Users-juanmnl-Developer-operator/05545980-1a16-4848-a3e7-91b41b141178/scratchpad/tree5/electron/src/main/zz-probe3.test.ts`.
