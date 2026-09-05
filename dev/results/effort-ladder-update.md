# Result — effort ladder brought in line with Claude Code 2.1.257

Branch `operator/101200`, worktree `~/.operator/worktrees/operator-101200`. All three defects
implemented in full. Nothing cost/pricing-related touched.

## Verification

| Check | Before | After |
|---|---|---|
| `npx vitest run` (renderer) | 1002 pass / 33 fail (5 files) | **1026 pass / 33 fail (same 5 files)** |
| `electron: npm test` | 415 pass / 0 fail | **415 pass / 0 fail** |
| `tsc --noEmit` (root) | clean | **clean** |
| `electron: npm run typecheck` | clean | **clean** |
| `npm run build` | clean | **clean** |

+24 renderer tests, zero new failures. The 33 pre-existing failures were measured on this exact
worktree by stashing the change and re-running — same 5 files, same count, all `localStorage`/
jsdom-environment errors (`forgotten-projects`, `ghost-probe`, `lane-accents`, `rail-foot`,
`terminal-options`). Untouched by this work.

## New module — `src/renderer/lib/effort.ts`

The union was re-spelled at ten sites; that duplication *is* why it drifted, so everything derived
from the ladder now lives in one file:

- `EFFORT_OPTIONS` / `EFFORT_LEVELS` — the five levels, **ascending** (low → medium → high → xhigh → max).
- `SETTINGS_EFFORT_LEVELS` — the four `settings.json` accepts.
- `migrateEffort(v)` — `normal` → `medium`; real levels pass through; anything else → `undefined`
  (so the caller leaves the field unset and the cascade answers, rather than pinning junk).
- `settingsEffort(level)` — **the one clamp**, `max` → `xhigh`, with the enum named in its comment.
- `effortCode(level)` — sidebar badge glyph. New: `effortLevel[0]` stopped identifying a level the
  moment the ladder gained both `medium` and `max` (both "M"). Now L / M / H / XH / MAX.
- `migrateProjectEfforts(p)`, `migrateSavedEfforts(list)`, `countLegacyEfforts`, `isLegacyEffort` —
  hydrate-time migration, same contract as `clearSeededRoleFields`: content-sniffing, idempotent,
  returns the **same object** when there is nothing to do.

`src/renderer/lib/effort.test.ts` — 21 tests: the `normal → medium` migration (incl. idempotence
and the same-object contract), the `max → xhigh` clamp (incl. "never produces a value outside the
file's enum" across the whole ladder), and badge-code uniqueness.

## Defect 1 — `normal` is not a real effort level

- **`src/shared/types.ts`** — added `EffortLevel = 'low'|'medium'|'high'|'xhigh'|'max'` and
  `SettingsEffortLevel = Exclude<EffortLevel,'max'>`, defined **once**, with the `.catch(void 0)`
  behaviour written down. Replaced the union at all six sites: `AgentSession.effortLevel`,
  `Role.effort`, `SessionConfig.effortLevel`, `Project.defaults.effortLevel`,
  `SavedSession.effortLevel`, and `ClaudeSettings.effortLevel` — that last one is typed
  `SettingsEffortLevel`, so **the type system now refuses a `max` write to a settings file.**
- **`model-config.ts`** — `ResolvedAgentConfig.effort: EffortLevel`. `resolveAgentConfig` and
  `legacyResolve` both run the resolved value through `migrateEffort`: the resolver is the last
  line of defence for a stored `normal` that reached memory ahead of hydrate (the localStorage seed
  paints first). `LegacyGlobalDefaults.effort` is typed `StoredEffort` — `role-defaults.json` was
  written when `normal` existed, so it is the one field that legitimately still models it.
- **`roster.ts`** — `operator` and `design` presets → `effort: 'medium'`. No reason found in the
  code to prefer otherwise; `medium` is the faithful reading and it keeps the two coordinator-ish
  lanes below the `high` the writing lanes carry, exactly as the old set intended.
- **UI, all now importing the one ladder**: `ChatComposer` (deleted its local `EFFORTS`),
  `RosterPanel` (deleted its local `EFFORTS`; the Segmented control and both card summaries),
  `SessionItem` (badge via `effortCode`), `SessionToolbar`, `CanvasPanel`, `CanvasConversation`,
  `DashboardView`'s `TerminalTab`. `AgentLibraryView`'s list — which happened to be *correct* while
  the rest of the app was wrong — is now derived from the ladder instead of a second copy.
- **`GeneralSection.tsx`** renders `SETTINGS_EFFORT_LEVELS` (four), not the full ladder: it edits
  the file directly and must not offer a value the file discards. The write still goes through
  `settingsEffort()`.

### Migration wiring (`DashboardView.tsx`)

Four places, all following the established hydrate-migration pattern:

1. `projects` localStorage seed — `.map(migrateLegacyCoordinator).map(migrateProjectEfforts)`.
2. `savedSessions` localStorage seed — `migrateSavedEfforts(...)`.
3. Durable hydrate — `nextSaved = migrateSavedEfforts(nextSaved).sessions`, and
   `renamed.map(migrateProjectEfforts).map(clearSeededRoleFields).map(clearCoordinatorWorktree)`.
   **Order matters and is commented**: the effort migration runs *first*, so `clearSeededRoleFields`
   compares a migrated `medium` against the migrated preset — otherwise every operator/design lane
   keeps a pin that is now identical to its preset. It feeds the existing `rewrites` counter, so a
   migrating store gets the same backup-then-write treatment as the other two.
4. A new one-shot effect for the user's own `~/.claude/settings.json` (+ `settings.local.json`),
   since nothing else would ever fix it: the launch path no longer writes that file at all, and
   Preferences only rewrites it if the user clicks something. Deliberately narrow — it rewrites
   **only** the exact legacy value, so it is idempotent, needs no one-shot flag, and cannot touch a
   level the user chose in Claude Code itself.

### How many stored `normal`s the migration touches

Counted against the live store (`~/.operator/projects.json`, `sessions.json`), read-only:

| Where | Count |
|---|---|
| Roster pins (`Role.effort`) | **6** — `operator/research`, `fastrack/{research,code,review,qa}`, `uwazi_app/operator` |
| `Project.defaults.effortLevel` | **5** — `importer`, `Operator-landing`, `fastrack`, `enfant-terrible`, `darkmatter` |
| `SavedSession.effortLevel` | **15** of 53 rows |
| `~/.claude/settings.json` | **0** — see the correction below |
| **Total** | **26** |

(16 projects scanned. localStorage copies are not countable from here; they go through the same
migration on the seed path.)

## Defect 2 — per-lane effort no longer travels on a global settings write

- **`launch-args.ts`** — `buildArgs` emits `--effort <level>` right after `--model`. Four new tests
  in `launch-args.test.ts`: emitted when resolved, omitted when not, `max` passed through
  **unclamped** (this is the flag seam, not the file seam), and the composed arg-vector order.
- **`DashboardView.handleLaunchSession`** — the global-settings write is **deleted**; the level goes
  into `launchOptions.effort`. Launching six lanes at six efforts is now six independent flags
  instead of last-write-wins on one file.
- **`DashboardView` restore path (was ~2702)** — same treatment: write deleted,
  `launchOptions.effort = migrateEffort(saved.effortLevel)` (migrating because a saved row can
  predate this change).
- **`ChatComposer.pickEffort`** — now sends `/effort <level>` to that lane's pty via the existing
  `terminalWrite` path used by `/model` (bare line + CR, not a bracketed paste), and keeps the
  optimistic pill update. The old code both moved every other lane's default and could not reach a
  running session anyway.
- **Preferences keeps its write.** `GeneralSection` still owns global `settings.json` `effortLevel`
  — it is the app-wide default for sessions started outside Operator — clamped via `settingsEffort`.

## Defect 3 — stale label

`AgentLibraryView.tsx:13` — `'Fable 5 — frontier'` → `'Fable — frontier'`.

## What the brief got wrong / notes

1. **`~/.claude/settings.json` already reads `"effortLevel": "medium"`, not `"normal"`.** Operator
   could never have written `medium` (its set was high/normal/low), so this was changed
   out-of-band since the brief was written — most likely by the user or by a `/effort` in a
   session. The migration is still correct and still shipped; it is simply a no-op against the
   current file. Nothing was overwritten.
2. **The DoD grep is self-contradictory as stated.** `grep -rn "'normal'" src/renderer src/shared`
   cannot return zero effort-related hits *and* contain a `normal → medium` migration. The literal
   is now confined to exactly two places: `LEGACY_EFFORT` in `lib/effort.ts` (one occurrence, so a
   grep for it lands on the migration and nothing else) and `lib/effort.test.ts`. Every other
   remaining hit is one of the legitimate unrelated ones the brief named (`fontStyle`,
   `buffer.active.type`, `plan-limits`' `LimitTone`).
3. **The brief's site list was complete for the union but missed two consequences**: the sidebar
   effort badge (`SessionItem.tsx:294-306`) derived its glyph from `effortLevel[0]`, which stops
   working once `medium` and `max` are both on the ladder; and `AgentLibraryView.tsx:22` already
   carried a *correct* five-level list, which is now derived from the shared ladder rather than
   left as a second copy waiting to drift the other way.
4. **`HARD_FALLBACK.effort` left at `'high'`.** Not in scope, and changing it would move every
   preset-less custom lane. Worth a separate decision: Claude Code's own default for coding work is
   `xhigh`.
5. **Not GUI-verified.** No real window was driven — GUI verification is the user's. What is proven
   is the arg vector, the migration, the clamp, and that the whole suite, both typechecks and the
   build are green.

## Files changed

```
 M src/shared/types.ts
 M src/renderer/lib/model-config.ts        M src/renderer/lib/model-config.test.ts
 M src/renderer/lib/launch-args.ts         M src/renderer/lib/launch-args.test.ts
 M src/renderer/lib/roster.ts              M src/renderer/lib/roster.test.ts
 M src/renderer/views/DashboardView.tsx
 M src/renderer/components/session/{ChatComposer,RosterPanel,SessionToolbar,CanvasPanel,CanvasConversation}.tsx
 M src/renderer/components/sidebar/SessionItem.tsx
 M src/renderer/components/preferences/GeneralSection.tsx
 M src/renderer/components/agents/AgentLibraryView.tsx
 ?? src/renderer/lib/effort.ts             ?? src/renderer/lib/effort.test.ts
```

No file under `electron/src/main/usage.ts`, `src-tauri/src/usage.rs`, or any `rates()` table was
touched.
