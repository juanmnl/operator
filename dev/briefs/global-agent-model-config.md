# Brief — global PER-ROLE defaults: "Operator uses Opus from now on", configured once

User's example, which defines the feature: *"I want from now on, Operator to use Opus instead of
Fable. I should be able to config once."*

So this is **not** one model for all agents. It is a **global, user-editable roster template**:
per-role defaults (model, effort, permission mode) that every project inherits, everywhere, for all
future launches.

`rolePresets()` (`lib/roster.ts:134`) is already exactly that template — it just lives in source and
isn't editable. Make it a durable, user-owned layer.

## Why the naive version does nothing

- `Role.model` is **required** (`types.ts:118`); every stored roster entry already carries an explicit
  model because it was **seeded from a preset at project creation**.
- Role launch reads it directly: `model: role.model` (`DashboardView.tsx:1239`).
- A **second, separate** launch path (folder/ad-hoc) uses `config.model || undefined` (`:1167`).
- `Project.defaults.model` exists in the type but **never reaches a role launch**.

The crux: a seeded value is **indistinguishable from a deliberate override**. Every one of the ~114
stored role entries looks pinned, so a new global default would be ignored forever. Solving that is
most of this work — see §4.

## Build

### 1. Global role defaults — a new durable layer

```ts
// keyed by role id: 'operator' | 'code' | 'research' | 'review' | 'design' | 'qa' | custom
type GlobalRoleDefaults = Record<string, { model?: string; effortLevel?: 'high'|'normal'|'low'; permissionMode?: string }>
```

Persist to `~/.operator/` (new file, or a `roleDefaults` key in a global settings file) — **not**
localStorage; it must survive a profile reset and be read by the launch path. Follow the
`projects.json` precedent: opaque JSON, atomic tmp+rename, no Rust schema needed.

### 2. One resolver, both launch paths

```ts
// src/renderer/lib/model-config.ts (new)
/** Precedence, FIRST DEFINED WINS, evaluated PER FIELD:
 *    project role override → global role default → built-in rolePresets() → hard fallback
 *  Per-field so a lane that pins only effortLevel still inherits the global model. */
export function resolveAgentConfig(role, globalRoleDefaults, projectDefaults): Required<AgentConfig>
```

**Both** `DashboardView.tsx:1239` and `:1167` must route through this. Two resolvers is how this
drifts apart. Treat `undefined` **and** `''` as "not set" — `Project.defaults` already stores
`model: ''` in real data, so empty string is ambiguous and must not mean "pinned to nothing".

### 3. Where it's edited

The global preferences surface (`onOpenGlobalPrefs`, built on `PageShell`). A row per role — name,
model, effort, permission mode — reading as the defaults they are. Editing "Operator → Opus" here is
the whole user story; make that the one obvious thing the page does.

Changing a global default affects **future launches only**. It must not touch a running lane, and it
must not rewrite stored project rosters (that's §4's explicit action, not a side effect).

### 4. Reconciling the ~114 seeded values — the crux

A role whose stored model **equals the built-in preset's model for that role id** was almost
certainly seeded, never chosen. One whose model **differs** was deliberately changed. Use that:

- **On hydrate**, an idempotent content-sniffing migration in the style of `migrateLegacyCoordinator`
  (`lib/roster.ts:49-70`, early-bail when there's nothing to do): where a role's `model`/`effort`
  matches the built-in preset for its id **exactly**, clear the field so it inherits. Where it
  differs, leave it pinned — that's a real user choice.
- This is safe because clearing a field that equals the preset is a **no-op today** (the cascade
  falls through to the same preset value) and becomes meaningful the moment a global default is set.
  State that reasoning in a code comment.
- **Back up `projects.json` before the first write** (`~/.operator/backups/`, existing pattern).
- Also provide an explicit **"Reset all lanes to inherit"** action for the harder case — a user who
  *did* change models per project and now wants the global to win. That one **must confirm**, name
  the count ("clears pinned models on N lanes across M projects"), and be undoable from the backup.

### 5. Show what's inherited

In `RosterPanel`, a lane on a global default must read as *inherited*, not pinned — resolved value in
muted ink plus an inherited affordance; pinned values in normal ink with a way to clear back to
inherit. Without this nobody can tell what the global setting is doing, or why one lane ignores it.
Existing tokens only; no new colours; **never stack opacity on `--fg-muted`**.

### 6. Keep the preset tiering

**Do not flatten `rolePresets()`.** The tiering is deliberate (fable for coordination, sonnet for
breadth, opus where quality matters) and remains the factory default for new projects. The global
layer overrides it; it does not replace it.

## Verify

- `npm test` + `npm run build` green.
- `resolveAgentConfig` tests: project override beats global beats preset beats fallback; per-field
  independence (pinning effort alone still inherits the global model); `undefined` and `''` both mean
  not-set; never returns undefined for a field the launch path requires.
- **The user's exact story, as a test**: set global `operator → opus`; assert every project's operator
  lane resolves to opus, including projects whose stored role still says `fable` because it matched
  the preset; assert a project that explicitly pinned `sonnet` keeps sonnet.
- Both launch paths resolve identically for identical inputs — assert it.
- The hydrate migration is idempotent (twice = once) and backs up before its first write.
- Launch a lane after changing only the global model and confirm the pty command carries it
  (`dev/drive-roster.mjs`, or the launch-args test).

## Write your result to

`dev/briefs/global-agent-model-config-RESULT.md` — the cascade semantics, how many seeded fields the
hydrate migration cleared vs left pinned, and any launch path still bypassing the resolver.
