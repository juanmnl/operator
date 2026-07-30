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

### 0. Three fields, not two — worktree is the third

`useWorktree` (`types.ts:127`) joins model and effort as a global per-role default. User's rationale:
worktree isolation is a per-lane *posture*, and setting it by hand is 114 toggles across 19 projects
— the same problem the model default solves.

**It behaves differently from the other two, and that difference is the work.** `model` is a string,
so `undefined` and `''` can both mean "unset". `useWorktree` is a **boolean, where `false` is a
meaningful explicit choice** — "definitely do not isolate this lane" is not the same as "no
preference". So it needs a genuine tri-state:

| stored | meaning |
|---|---|
| absent (`undefined`) | inherit the global default |
| `true` | pinned ON for this lane, whatever the global says |
| `false` | pinned OFF for this lane, whatever the global says |

**Verified good news:** `rolePresets()` never sets `useWorktree`, and all **78** stored roles have it
**absent**. So a global default takes effect immediately for this field, and §4's preset-comparison
migration does not need to touch it at all.

**The bug to fix while you are here:** `RosterPanel.tsx:693` writes
`onPatch({ useWorktree: !role.useWorktree })` — an unconditional boolean, so the first click pins the
lane forever with no route back to inherit. Give it a way home: either cycle inherit → on → off →
inherit, or keep the binary toggle and add a small reset-to-default affordance beside it. Either way
**the control must show which of the three states it is in** — a toggle that looks identical when
inherited-on and when pinned-on makes the global setting appear broken.

**Suggested defaults, not a mandate** (the user's read, and mine): worktrees earn their cost for
lanes that WRITE (`code`, `design`) and mostly get in the way for lanes that read and coordinate
(`research`, `review`, `operator`, `qa`). Seed the global defaults that way, and say in your result
what you chose — it is a judgement call the user should be able to see and override in one place,
which is the entire point of the feature.

**Also worth knowing about the launch path:** if `worktreeCreate` fails, `DashboardView.tsx:1459-1467`
logs a warning and launches in the project root anyway. A lane the user believes is isolated can
silently not be. Do not fix that here — but if a global default makes worktrees the norm, that silent
fallback gets hit far more often, so **file it** in your result as a follow-up.

### 1. Global role defaults — a new durable layer

```ts
// keyed by role id: 'operator' | 'code' | 'research' | 'review' | 'design' | 'qa' | custom
type GlobalRoleDefaults = Record<string, {
  model?: string
  effortLevel?: 'high'|'normal'|'low'
  permissionMode?: string
  /** See §0 — tri-state at the ROLE level (absent = inherit this), plain boolean here. */
  useWorktree?: boolean
}>
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
drifts apart. Treat `undefined` **and** `''` as "not set" for STRING fields — `Project.defaults`
already stores `model: ''` in real data, so empty string is ambiguous and must not mean "pinned to
nothing".

**`useWorktree` is the exception and must be handled separately: only `undefined` means "not set".**
An explicit `false` is a pin and has to beat the global default. If you write the resolver with a
generic truthy check it will silently swallow every deliberate opt-out — which is the one bug that
would make a user distrust the whole feature, because their lane keeps isolating after they turned it
off. Cover it with its own test.

There is a third consumer beyond those two launch paths: `roleLaunchSettings` (`lib/roster.ts:84`)
already resolves effort and permission mode against `Project.defaults`. Fold it into
`resolveAgentConfig` rather than leaving a fourth place that answers the same question.

### 3. Where it's edited — the Agents view, NOT Preferences

User's framing, which decides this: *"when I open Operator, even before choosing a project, I could
set up the agents config, so they launch accordingly with each project — that way I can scope token
economy through agent capability."*

So it must be reachable **at the launcher, before a project is scoped**, and it is a first-class
thing you go and do — not a setting you hunt for.

**Add a third tab to `AgentsHubView`** (`:29, :69` — it already has `Fleet` | `Subagent library`;
add `Defaults`). That view is becoming rail-reachable (`dev/briefs/agents-hub-to-rail.md`), and the
rail persists at the gallery, so this lands exactly where the user asked: open Operator, configure
the agents, then pick a project. One place called "Agents" that answers both *what is running* and
*how they are configured*.

Do **not** put it in `onOpenGlobalPrefs`. It is not a preference; it is the roster template.

A row per role: name, **model**, **effort**, permission mode. Editing "Operator → Opus" is the whole
user story — make that the single most obvious action on the tab.

Changing a global default affects **future launches only**. It must not touch a running lane, and it
must not rewrite stored project rosters (that's §4's explicit action, not a side effect).

### 3b. Frame it as capability, not cost — and give effort equal weight

The purpose is token economy, but **do not build a cost display**. No `$/Mtok`, no projected spend,
no running total. That call is already made in this project: economy is controlled *as config*, and
a number that is only ever an estimate invites arguing with it instead of choosing.

What that means concretely:

- **Effort is a spend dial equal to model** (`'high' | 'normal' | 'low'`, `types.ts:119`) and is the
  one users forget. A row that shows only the model hides half the control. Give both the same
  visual weight — not effort tucked behind a disclosure.
- Order the model options by capability so the tier reads off the control itself
  (`ROSTER_MODELS` is already `fable, opus, sonnet, haiku`). Say what each is FOR in a word, in the
  vocabulary the presets already use — coordination / breadth / quality — not in dollars.
- The honest one-liner for the tab is about matching capability to job, e.g. "Every project's lanes
  launch with these. Match the model to what the lane actually does." Nothing about billing.
- **No cost figure anywhere**, including tooltips. If a reviewer asks for one, that is a separate
  decision with its own brief.

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
- **The worktree tri-state, as its own test**: global `code → useWorktree: true`; a role with the
  field absent resolves TRUE; a role with `false` resolves **FALSE** (the pin wins); a role with
  `true` resolves true. Then flip the global to `false` and re-assert all three. This is the case a
  truthy check silently breaks.
- The roster control round-trips all three states: inherit → pinned on → pinned off → back to
  inherit, and the stored record ends with the field **absent** again, not `false`.
- Both launch paths resolve identically for identical inputs — assert it.
- The hydrate migration is idempotent (twice = once) and backs up before its first write.
- Launch a lane after changing only the global model and confirm the pty command carries it
  (`dev/drive-roster.mjs`, or the launch-args test).

## Write your result to

`dev/briefs/global-agent-model-config-RESULT.md` — the cascade semantics, how many seeded fields the
hydrate migration cleared vs left pinned, and any launch path still bypassing the resolver.
