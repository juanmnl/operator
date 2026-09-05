# Brief — bring Operator's effort ladder in line with Claude Code 2.1.257

Scope note: this brief is ONLY about effort levels + how effort reaches a lane, plus one
stale label. **Do not touch anything cost/pricing related** (`usage.ts`, `usage.rs`, the
`rates()` tables, cache-read multipliers). That was explicitly deferred by the user.

## The verified facts (do not re-derive these — they came from the installed binary)

Installed CLI: `claude 2.1.257` at `~/.local/share/claude/versions/2.1.257`.

1. `settings.json` schema for effort, read out of the binary verbatim:
   `effortLevel: ee(["low","medium","high","xhigh"]).optional().catch(void 0)`
   The `.catch(void 0)` matters: an out-of-enum value is **silently dropped**, no error,
   no warning. It falls back to the CLI default.
2. The CLI flag is `--effort <level>` with levels `low, medium, high, xhigh, max`
   (confirmed in `claude --help`). Note `max` is valid for the FLAG but NOT for the
   settings.json enum.
3. `settings.json` also supports a per-model table:
   `modelSettings: { "<model>": { effortLevel: "low"|"medium"|"high"|"xhigh" } }`
   with the same enum. Top-level `effortLevel` is the default; `modelSettings` overrides
   it per model.
4. There is a `/effort <level>` slash command in the interactive session
   ("run /effort high to continue" appears in the binary's own copy).

## Defect 1 — `normal` is not a real effort level

Operator's effort set is `'high' | 'normal' | 'low'`. `normal` is not in the CLI's enum,
so every time Operator writes it, Claude Code throws it away. Right now the user's live
`~/.claude/settings.json` reads `"effortLevel": "normal"` — written by Operator — and is
being ignored. Two default lanes (`operator`, `design`) ship with `effort: 'normal'`, so
they have never actually run at the effort the UI claims.

Also missing entirely: `xhigh`, which is Claude Code's own default for coding work, and
`max`.

Sites carrying the bad set (grep for more, this list is a starting point, not a promise
of completeness):
- `src/shared/types.ts:84` (`effortLevel?: 'high' | 'normal' | 'low'`) and `:678` area
- `src/renderer/lib/model-config.ts:32`, `:123`, `HARD_FALLBACK` at `:39`
- `src/renderer/components/session/ChatComposer.tsx:38` (`EFFORTS`), `:70`, `:195`, `:201`
- `src/renderer/components/session/RosterPanel.tsx:63`
- `src/renderer/components/session/SessionToolbar.tsx:60`
- `src/renderer/components/session/CanvasPanel.tsx:38`
- `src/renderer/components/session/CanvasConversation.tsx:480`
- `src/renderer/components/preferences/GeneralSection.tsx:12` (`EFFORT_LEVELS`)
- `src/renderer/views/DashboardView.tsx:79`
- `src/renderer/lib/roster.ts:248` (operator lane), `:252` (design lane)

### What to do
- New type: `type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'`. Define it
  ONCE in `src/shared/types.ts` and import it everywhere; do not re-spell the union at
  each site. The current duplication across ~10 files is exactly why this drifted.
- Order the UI ladder low → medium → high → xhigh → max (ascending), not the current
  descending high/normal/low.
- **Migrate stored data**: any persisted `'normal'` (in `projects.json` roster pins,
  `Project.defaults`, saved sessions, localStorage, and the user's own
  `~/.claude/settings.json`) maps to `'medium'`. That is the faithful reading of what
  `normal` was trying to mean. Do this in the same place the other hydrate-time
  migrations live (see `migrateGlobalsToLanePins` / `migrateLegacyRoleId` in
  `model-config.ts` / `roster.ts` for the established pattern). Migrate, don't just
  default — a lane that was deliberately set to `normal` must not silently jump to `high`.
- The default roster lanes at `roster.ts:248,252` become `effort: 'medium'` (same faithful
  mapping), unless you find a reason in the code to prefer otherwise — if so, say why in
  the result file.
- **`max` is flag-only.** Anywhere the value is written into a `settings.json`
  `effortLevel` field, clamp `max` → `xhigh`, or the write is silently discarded. Put that
  clamp in one function with a comment naming the enum, not inline at each call site.

## Defect 2 — per-lane effort is delivered by a global settings write

`src/renderer/views/DashboardView.tsx:2282-2286`: every single `handleLaunchSession` call
loads the folder prefs, finds the **global** settings file, and writes `config.effortLevel`
into it. So launching six lanes with six different efforts is last-write-wins across all
of them — the global file is not a per-lane channel. `src/renderer/lib/launch-args.ts`
never emits `--effort` at all, even though the flag exists.

### What to do
- `buildArgs` (`src/renderer/lib/launch-args.ts`) emits `--effort <level>` when an effort
  is resolved, alongside the existing `--model` push at `:37`. Extend
  `src/renderer/lib/launch-args.test.ts` to cover it — that file already has the arg-vector
  assertion shape to copy.
- Delete the global-settings write from `handleLaunchSession`. A lane's effort travels on
  its own launch flag from now on. Check `DashboardView.tsx:2702-2705` too — same pattern,
  same treatment.
- The **global Preferences** screen (`GeneralSection.tsx`) legitimately owns the global
  `settings.json` `effortLevel` — that is an app-wide default for sessions started outside
  Operator, and it should keep writing there (clamped per the `max` rule above). Only the
  per-lane launch path stops doing it.
- The live **effort pill** in `ChatComposer.tsx:195-201` currently mutates global settings
  to change one running lane's effort — same category of bug, and it also can't take effect
  mid-session. Send `/effort <level>` to that lane's pty instead. Use the existing `SLASH`
  delivery path in that same file (bare line + CR, NOT a bracketed paste — the comment at
  `ChatComposer.tsx:44` explains why) and keep the optimistic pill update.

## Defect 3 — stale label (trivial)

`src/renderer/components/agents/AgentLibraryView.tsx:13` reads `'Fable 5 — frontier'`.
The current frontier model is Fable 5.1. Make the label version-less ('Fable — frontier')
so it cannot go stale again; the alias `fable` already resolves to the newest release, so
naming a version in the UI is a liability, not information.

## Definition of done

- `npm test` green, `npx tsc --noEmit` clean, `npm run build` clean.
- New tests: the `normal → medium` migration, the `max → xhigh` settings clamp, and
  `--effort` in the built arg vector. A migration without a test is how the last one rotted.
- `grep -rn "'normal'" src/renderer src/shared --include='*.ts' --include='*.tsx'` returns
  no effort-related hits (there are legitimate unrelated ones: `fontStyle`,
  `buffer.active.type`, `plan-limits`' `LimitTone` — leave those).
- No file under `electron/src/main/usage.ts`, `src-tauri/src/usage.rs`, or any `rates()`
  table is touched.

## Output

Write your result to the ABSOLUTE path
`/Users/juanmnl/Developer/operator/dev/results/effort-ladder-update.md`
(absolute on purpose — a relative `dev/results/` path is invisible from your worktree).
Cover: what changed per file, how many stored `normal` values the migration touched, test
counts before/after, and anything you found that this brief got wrong. Then call
`mcp__operator__report`.
