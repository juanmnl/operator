# Per-session environment + skills — two surfaces

**Design, 2026-08-24. Design only; nothing here is built.** Answers the brief for Surface A
(the lane launch sheet) and Surface B (Project settings → Environment / Skills). It stands on
`dev/project-env-design.md`, whose config-vs-secret rule and reserved-name denylist carry over
unchanged; where the brief moves the carrier (a per-session settings **file** instead of the
project's `.claude/settings.json`), the consequences are worked through below rather than
assumed away.

---

## 0. What was checked, and what it changes

Everything in this table was read in this repo or pulled out of the installed CLI. It is here
because three of the five findings change the build order.

| # | Finding | Where | Consequence |
|---|---|---|---|
| 1 | `--settings` today is passed **inline as a JSON string** — `{"tui":"default"}` — not a file. | `src-tauri/src/lib.rs:717-721` | There is no per-session settings file yet. Creating it is **step S0**, before any UI. |
| 2 | `--settings <file-or-json>` loads **"additional settings"**, at highest precedence. | `claude --help` | Merge, not replace. Writing a file with only our keys does **not** drop the user's global model/permissions. This was the single biggest risk in the brief and it is retired. |
| 3 | `skillOverrides` is real, and is **not a boolean**: `"on" | "name-only" | "user-invocable-only" | "off"`, absent = on. | CLI 2.1.241 binary strings | The Skills list cannot be a plain checklist and stay honest. Design in §4.2. |
| 4 | The user's own `~/.claude/settings.json` **already carries three `skillOverrides: "off"`** (the `framer-*` skills) and six `enabledPlugins`. | `~/.claude/settings.json` | The Skills page opens onto pre-existing state on day one. There is no empty-slate version of this screen to design for the real user. |
| 5 | Skills are enumerable from disk: `~/.claude/skills/<name>/SKILL.md`, `<project>/.claude/skills/…`, and `~/.claude/plugins/marketplaces/<mkt>/plugins/<plugin>/skills/<name>/`. | filesystem | The catalog is a Rust directory walk, not a CLI shell-out. No new dependency. |

Claude Code's own words for the four listing modes, verbatim from the binary — the UI copy
should not paraphrase them into something less exact:

> Per-skill listing overrides keyed by skill name. `"name-only"` lists the skill without its
> description; `"user-invocable-only"` hides it from the model but keeps `/name`; `"off"` hides
> it from both. Absent = on.

---

## 1. The rules that carry over

**Config describes the project. A secret authorises you.** Separate storage, separate UI,
separate wording. Unchanged from the original design; the brief's `~/.operator/secrets.json`
is a *home* for secret values, not a licence to blur the two tiers.

**The denylist stands**, with its two distinct reasons — the UI must say **which**:

| Name | Reason shown |
|---|---|
| `PORT`, `OPERATOR_DEV_PORT` | *"Operator manages this."* It reserves a port per lane; set here, every lane binds the same one. |
| `CLAUDE_CODE_*`, `CLAUDECODE` | *"Claude Code ignores this."* Silently. |
| `TERM`, `FORCE_COLOR`, `COLORTERM`, `COLORFGBG` | *"Operator manages this."* Tool output gets coloured against the terminal's assumptions. |

**Deleting the row is the only unset.** Clearing a value prompts *"Remove this variable, or set
it to an empty value?"* — never picks one silently. `""` is inherited as empty, and presence
tests (`[ -z ]` vs `[ -v ]`) disagree exactly there.

**One thing the new carrier changes, and it must not be quietly dropped:** a per-session
settings file is written to disk *by Operator*, lives on after the run, and can be `cat`-ed by
anything the agent starts. So **a secret's value is never written into it.** Secret rows
resolve at spawn into the pty process environment, from `~/.operator/secrets.json`. The
settings file carries the *name*, never the value — in fact it carries nothing for a secret row
at all. Honest wording for the surface: *"Stored on this Mac, outside the repo."* Not
"protected", not "encrypted" — the file is plaintext until a Keychain step lands.

---

## 2. The cascade — and the trap in it

`src/renderer/lib/model-config.ts` carries a hard rule, earned by deleting a third altitude:
lane launch config resolves through **preset → lane pin**, and *"nothing else may decide a
launch's model/effort/permission mode."* Env and skills add a run-time layer, so this design has
to say exactly how it avoids rebuilding what was torn down.

**Three layers, and the retired one stays retired:**

```
    project defaults   (projects.json — Project.env / Project.skills)
        ↓
    lane / role        (Role.env / Role.skills — the roster card)
        ↓
    this run           (the launch sheet — never persisted to projects.json)
```

`role-defaults.json` — the old user-global tier — is **not** revived. Model/effort/worktree
keep their own two-altitude cascade untouched; this is a separate cascade for a separate kind
of value, and the two are never reconciled into one legend.

**The thing that makes it survivable: env and skills are SETS, not scalars.** Origin is resolved
**per row**, never per section. A lane that adds one variable must not shadow the project's whole
block; a run that turns one skill off must not silently drop the project's other twelve. Written
as a rule for the resolver:

> `resolveEnv(project, role, run)` merges by NAME, last writer wins, and returns
> `{ name, value | secret | unset, origin: 'project' | 'lane' | 'run' }` per row.
> `resolveSkills(...)` merges by skill name the same way. There is exactly one resolver, and
> both surfaces render its output.

Same two display channels as `Segmented` — and deliberately the same, so there is one dialect
in the app for "where did this come from":

- **the value** → the row's own ink. Always legible, whatever its origin.
- **the origin** → a hairline **ring** (a `box-shadow: inset`, never a colour-changing border on
  a radiused element) around rows set *at this altitude*. Inherited rows get nothing. The ring
  marks the exception, and inherited is the common case.

---

## 3. Surface A — the lane launch sheet

### 3.0 What exists today, and what this adds

Today there is no launch sheet. `RosterPanel` has a brief field (`What do you want done?`) and
lane rows that expand into a `RoleCard` with `Segmented` controls; `Launch →` spawns
immediately. **That one-click path must survive** — env and skills are not worth a dialog on
every launch.

So the sheet is **opt-in and non-blocking**:

- `Launch →` on a row or card: unchanged. Launches with the resolved defaults.
- `⌥`-click `Launch →`, or the card's new `Set up run →` affordance: opens the sheet, prefilled.
- The sheet's own `Launch →` is its primary action; `Esc` closes without launching.

A lane whose run config differs from its defaults shows a single mono chip on the collapsed row —
`+2 env · 3 skills off` — so the sheet is never the only place the difference is visible.

### 3.1 The sheet, whole

Bottom sheet in the main content card, same idiom and same slide as `ShellSheet`
(`transform: translateY`, `0.24s cubic-bezier(.32,.72,0,1)`, `--bg-terminal`, 1px top border).
Width = the content card; height `min(72%, calc(100% - 84px))`. It scrolls itself.

```
╭──────────────────────────────── ▭ ─────────────────────────────────────────╮
│  Set up this run — Code                                                 ×  │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  ┌ BRIEF ──────────────────────────────────────────────────────────────┐   │
│  │ Wire the skills catalog to the launch path                          │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                            │
│  MODEL  ▏opus▕ sonnet  haiku      EFFORT  ▏high▕ normal  low               │
│                                            WORKTREE  ▏On▕ Off              │
│                                                                            │
│  ENVIRONMENT                                          3 vars · 1 secret ▾  │
│  Passed to Claude Code and to everything it runs.                          │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ NODE_ENV          staging                            project     ✕  │   │
│  │ API_BASE          http://localhost:1429             ⟨ run ⟩   ↺  ✕  │   │
│  │ VITE_FLAGS        (empty)                            lane        ✕  │   │
│  │ RAILWAY_TOKEN     from Operator secrets               lane        ✕  │   │
│  ├─────────────────────────────────────────────────────────────────────┤   │
│  │ + variable          + secret                                        │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                            │
│  SKILLS                                    24 available · 3 off · 1 muted ▾ │
│  Everything Claude Code would load in this lane.                           │
│  ┌ ⌕ filter ───────────────────────────────────────────────────────────┐   │
│  │                                                                     │   │
│  │ GLOBAL  ~/.claude/skills                                          5 │   │
│  │  ☑ no-ai-slop           Edit drafts into sharper, human writing     │   │
│  │  ☐ framer               Design, edit, or publish a website     off  │   │
│  │  ☑ framer-code-comp…    Framer code components         name-only    │   │
│  │                                                                     │   │
│  │ PROJECT  operator/.claude/skills                                  0 │   │
│  │  No skills in this project.                                         │   │
│  │                                                                     │   │
│  │ PLUGIN  mattpocock-skills@claude-plugins-official     ⟨On⟩ Off    9 │   │
│  │  ☑ diagnosing-bugs      Diagnosis loop for hard bugs                │   │
│  │  ☑ tdd                  Test-driven development                     │   │
│  │  … 7 more                                                           │   │
│  │                                                                     │   │
│  │ PLUGIN  rust-analyzer-lsp@claude-plugins-official      On ⟨Off⟩   2 │   │
│  │  Disabled — its 2 skills won't load.              show them ▾       │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                            │
├────────────────────────────────────────────────────────────────────────────┤
│  Differs from Code's defaults: +1 var, 1 skill off        Reset   Launch →  │
╰────────────────────────────────────────────────────────────────────────────╯
```

Notes on what the mockup is asserting:

- `⟨ run ⟩` is the **ring** — this row is set for this run only. `project` / `lane` are plain
  muted text, no border: inherited is the common case and gets no decoration.
- `↺` appears **only** on a ringed row. It is `Segmented`'s `onClear` in list form — the route
  home. Without it, an override is a one-way door.
- `(empty)` is how a deliberately-empty value renders. Never a blank cell: blank reads as "not
  set", and the whole point of §1 is that those are different.
- The footer sentence is the answer to *"what will this launch with, and how is it different?"*
  — the question the collapsed cascade exists to keep answerable.
- `Reset` clears the run layer only. It never touches lane or project.

### 3.2 Deleting an inherited row — masking, not editing

`✕` on a **run** row removes the override. `✕` on a **project** or **lane** row cannot delete
the project's variable — the sheet must never edit the altitude above it. It writes a tombstone:

```
│ NODE_ENV          s̶t̶a̶g̶i̶n̶g̶                             ⟨ masked ⟩  ↺  │
```

Struck value, `masked` ring, `↺` to restore. The tombstone is `{ name, unset: true }` and
resolves to "not present in this run's env". This is the one legitimate unset that isn't a
deletion, and it exists precisely because delete-is-the-only-unset holds one layer up.

### 3.3 Clearing a value — the prompt

Inline, in the row. Not a modal: a modal over a sheet over a card is three layers for a
two-button question.

```
│ API_BASE          ┃                    ┃                                │
│    Remove this variable, or set it to an empty value?                   │
│    Empty is inherited as "" — most tools test presence, not value.      │
│                                     [ Remove ]  [ Set empty ]  Cancel   │
```

The row holds this state until answered; blur does **not** resolve it (blur-picks-one is the
silent choice the rule forbids). `Esc` = Cancel and restores the prior value.

### 3.4 A denied name

Rejected at the edit surface, with the reason, and the row cannot be committed:

```
│ ┃PORT            ┃ 3000                                              ✕  │
│    Operator manages PORT — it reserves one per lane. Set here, every    │
│    lane binds the same port and they collide.                           │
```

Name field in `WARN_INK` (`color-mix(in srgb, var(--color-warning) 50%, var(--fg))` — the
roster's existing warning ink, already contrast-checked across the six palettes), reason in body
ink at the 72% step-down, `+ variable` disabled while a row is invalid. The `CLAUDE_CODE_*`
group gets the other sentence: *"Claude Code ignores this — it will be set and nothing will
happen."*

### 3.5 Adding a secret

`+ secret` is a **different verb from `+ variable`**, and that is the point — the affordance
itself carries the tier distinction, so no masked input has to pretend to.

```
╭ Add a secret ──────────────────────────────────────────────────╮
│  NAME    ┃RAILWAY_TOKEN                                      ┃ │
│  VALUE   ┃••••••••••••••••••••                               ┃ │
│                                                                │
│  Stored on this Mac in ~/.operator/secrets.json, outside the   │
│  repo. Operator sets it on the session at launch and never     │
│  writes it to a settings file. It is plain text on disk, and   │
│  anything the agent runs can read it from its environment.     │
│                                       Cancel      Save secret  │
╰────────────────────────────────────────────────────────────────╯
```

After saving, the value is **never shown again** — the row reads `from Operator secrets`, and
its only actions are `Replace value…` and `✕`. There is no reveal, because a reveal is what
turns "we store it" into "we protect it".

An existing secret is attached by name from the same control (a `PopMenu` of names from
`secretsList()`), so the same token can serve several projects without being retyped.

### 3.6 Component / prop notes — Surface A

New directory `src/renderer/components/launch/` for the sheet, `…/env/` and `…/skills/` for the
two shared blocks (Surface B reuses both, verbatim — that is the reason they are not inlined).

```ts
// launch/LaunchSheet.tsx
export function LaunchSheet(props: {
  project: Project
  role: Role
  open: boolean
  /** Resolved defaults, so the sheet never re-runs a cascade of its own. */
  resolved: ResolvedAgentConfig
  env: ResolvedEnvRow[]        // from resolveEnv(project, role, run)
  skills: ResolvedSkillGroup[] // from resolveSkills(...)
  brief: string
  onBrief(v: string): void
  onPatchRun(patch: RunPatch): void   // the run layer, in memory only
  onResetRun(): void
  onLaunch(): Promise<void>
  onClose(): void
}): JSX.Element
```

```ts
// env/EnvRowList.tsx — shared by the sheet and the project page
export function EnvRowList(props: {
  rows: ResolvedEnvRow[]
  /** Which altitude this editor writes. Decides ring copy, and whether ✕ deletes or masks. */
  altitude: 'project' | 'lane' | 'run'
  secrets: string[]                        // names only, never values
  onSet(name: string, value: string): void
  onSetSecret(name: string, secretName: string): void
  onRemove(name: string): void             // delete at own altitude, mask above
  onRestore(name: string): void            // the ↺
  /** Returns null when allowed, or the sentence to show. Pure; unit-testable alone. */
  validateName(name: string): string | null
  emptyLabel?: string
}): JSX.Element
```

`EnvRow` is internal to the list. `ClearValuePrompt` is a row state, not a component with its
own portal. `validateName` is deliberately injected rather than imported: the denylist is one
exported pure function (`src/renderer/lib/env-policy.ts`) with its own test, and the surfaces
never re-implement it — the two-resolvers-drift failure mode `model-config.ts` warns about
applies here identically.

```ts
// skills/SkillChecklist.tsx
export function SkillChecklist(props: {
  groups: ResolvedSkillGroup[]     // grouped by source, order: global, project, plugin…
  altitude: 'project' | 'lane' | 'run'
  query: string
  onQuery(q: string): void
  onSetMode(skill: string, mode: SkillMode): void   // 'on'|'name-only'|'user-invocable-only'|'off'
  onRestore(skill: string): void
  onTogglePlugin(plugin: string, on: boolean): void
  /** Collapsed groups past this many rows; the header keeps the true count. */
  previewRows?: number   // default 8
  loading?: boolean
}): JSX.Element
```

Reused as-is: `Segmented` (model/effort/worktree, plugin on/off), `PopMenu` (listing mode),
`ShellSheet`'s slide/backdrop treatment, `WARN_INK` and `CONTROL_OFF` from the existing modules
rather than re-declared.

---

## 4. Surface B — Project settings → Environment / Skills

Two pages on the existing `PageShell` (`src/renderer/components/settings/PageShell.tsx`),
`measure="form"` (720), `SettingsSection` for each block, and the exported type tokens
(`sectionHeader`, `sectionDesc`, `fieldLabel`) — nothing re-declared inline.

These pages edit **Operator's launch defaults in `projects.json`**, not the repo's
`.claude/settings.json`. That distinction has to be visible, because `FolderPreferencesView`
already has a Plugins tab writing the *real* file. Rule: **this page shows the repo's settings as
an inherited layer and never writes them.** One writer per file.

### 4.1 Environment

```
  Operator                                                    ← page title
  ~/Developer/operator                                        ← subtitle

  ─Instructions─Permissions─General─Hooks─Plugins─┃Environment┃─Skills─

  ENVIRONMENT
  Set on every lane Operator launches in this project. Values are stored in
  ~/.operator/projects.json on this Mac — not in the repo, not shared with
  your team.

  ┌──────────────────────────────────────────────────────────────────┐
  │ NODE_ENV            staging                                   ✕  │
  │ API_BASE            http://localhost:1429                     ✕  │
  │ VITE_FLAGS          (empty)                                   ✕  │
  ├──────────────────────────────────────────────────────────────────┤
  │ + variable                                                       │
  └──────────────────────────────────────────────────────────────────┘

  SECRETS
  Stored on this Mac in ~/.operator/secrets.json, outside the repo. Operator
  sets them on the session at launch and never writes them to a settings
  file. Plain text on disk; anything the agent runs can read them.

  ┌──────────────────────────────────────────────────────────────────┐
  │ RAILWAY_TOKEN       from Operator secrets    Replace value…   ✕  │
  ├──────────────────────────────────────────────────────────────────┤
  │ + secret                                                         │
  └──────────────────────────────────────────────────────────────────┘

  INHERITED
  From this repo's .claude/settings.json — edit it on the General tab.

  ┌──────────────────────────────────────────────────────────────────┐
  │ CLAUDE_PROJECT_TAG  operator                        read-only    │
  └──────────────────────────────────────────────────────────────────┘
```

Two sections, not one list with a tier column: **the split is the feature.** A user scanning
this page must not be able to mistake which box a token goes in.

The `INHERITED` block renders only when the repo file actually has an `env` — otherwise the
section is omitted entirely (a permanently-empty box teaches nothing).

**Empty state**, first visit, no variables:

```
  ┌──────────────────────────────────────────────────────────────────┐
  │ No variables. Every lane launches with your shell's environment  │
  │ as it is.                                                        │
  ├──────────────────────────────────────────────────────────────────┤
  │ + variable                                                       │
  └──────────────────────────────────────────────────────────────────┘
```

Not "None configured" — it says what *is* true, which is the more useful sentence and the one
that keeps someone from adding a variable they already have exported.

### 4.2 Skills

The four listing modes are the whole design problem here: a checkbox is right for the 90% case
and cannot express the middle two. Answer — **the checkbox is the primary, the mode is a quiet
second control in a fixed-width right column** (width reserved always, ink drawn only when
non-default, so nothing reflows on hover; ink alignment, not box alignment).

```
  SKILLS
  Every skill Claude Code would load in this project. Off here means off for
  every lane Operator launches; a lane or a single run can still differ.

  ┌ ⌕ filter                                                         ┐
  │                                                                  │
  │ GLOBAL   ~/.claude/skills                                      5 │
  │  ☑ no-ai-slop          Edit drafts into sharper, more human …    │
  │  ☑ framer              Design, edit, or publish a website        │
  │  ☐ framer-code-com…    Framer code components               off  │
  │  ☐ framer-project-0…   Framer project 0HbRcQ…                off │
  │  ☑ artifact-design     Design guidance for Artifacts   name-only │
  │                                                                  │
  │ PROJECT  operator/.claude/skills                               0 │
  │  No skills here yet. Add one at .claude/skills/<name>/SKILL.md.  │
  │                                                                  │
  │ PLUGIN   mattpocock-skills@claude-plugins-official   ⟨On⟩ Off  9 │
  │  ☑ diagnosing-bugs     Diagnosis loop for hard bugs and perf…    │
  │  ☑ tdd                 Test-driven development                   │
  │  ☑ code-review         Review changes since a fixed point        │
  │  ☑ research            Investigate against high-trust sources    │
  │  ☑ grilling            Grill the user about a plan               │
  │  ⌄ 4 more                                                        │
  │                                                                  │
  │ PLUGIN   frontend-design@claude-code-plugins         ⟨On⟩ Off  1 │
  │  ☑ frontend-design     Distinctive, intentional visual design    │
  │                                                                  │
  │ PLUGIN   swift-lsp@claude-plugins-official            On ⟨Off⟩ 0 │
  │  Disabled — it contributes no skills.                            │
  └──────────────────────────────────────────────────────────────────┘

  Three skills are off in your global ~/.claude/settings.json. They show as
  off here and stay off unless you turn them on for this project.
```

The **listing-mode menu**, on the right-column control (a `PopMenu`, opened from the mode chip
or from `⌥`-clicking the checkbox):

```
        ╭──────────────────────────────────────────────╮
        │  ▸ On                                        │
        │    Name only        listed without its desc  │
        │    /command only    hidden from the model    │
        │    Off              hidden from both         │
        ╰──────────────────────────────────────────────╯
```

`user-invocable-only` is shown as **`/command only`** — the setting's own name describes the
mechanism, the label has to describe the effect. The hint line carries Claude Code's exact
wording so nobody has to guess.

**Plugin groups.** The header toggle writes `enabledPlugins`. A disabled plugin's rows are
**not** rendered greyed — a greyed checkbox implies it could be ticked. The group collapses to
one sentence with a `show them ▾` disclosure that lists names as plain text, non-interactive,
with a line: *"Enable the plugin to choose among these."* A control that vanishes reads as a
bug; a sentence in its place does not.

**Loading.** The catalog is a disk walk over three roots, so it can take a beat on a cold cache.
The group headers and counts render from the last known catalog; rows render as a three-row
skeleton at `--overlay-subtle`. No spinner over the whole page — the page's identity (its
groups) is known before its contents are.

**Overflow.** Groups past 8 rows collapse with `⌄ N more`; the header count is always the true
total, never the visible one. The filter searches name **and** description and expands every
group that matches, showing `N of M` in the header while a query is active.

### 4.3 Role defaults carrying a skill set

A role default is a lane's altitude, and the roster card is where lanes are configured — so it
lands on the expanded `RoleCard`, not on a new screen. Two compact rows under the charter:

```
  ┌ Code ────────────────────────────────────────────────── opus ─┐
  │  … model / effort / worktree segmented rows, unchanged …      │
  │                                                               │
  │  ▸ charter                                                    │
  │  ▸ environment   2 vars                                       │
  │  ▸ skills        3 off · 1 muted                              │
  └───────────────────────────────────────────────────────────────┘
```

Same tiny mono disclosure the charter already uses (9px, uppercase, `--fg-muted`, a chevron).
Expanding renders the *same* `EnvRowList` / `SkillChecklist` with `altitude="lane"`, in place.
No new component, no third dialect. At rest a lane with no env and no skill pins shows
`▸ + environment` / `▸ + skills` — the same "+ charter" idiom already on the card.

---

## 5. States, themes, and the checks this design owes

| State | Environment | Skills |
|---|---|---|
| **Empty** | "No variables. Every lane launches with your shell's environment as it is." | Per group. Project group: "No skills here yet. Add one at `.claude/skills/<name>/SKILL.md`." |
| **Loading** | Instant (in-memory) — no state needed. | Headers + counts from cache, three skeleton rows per group. |
| **Overflow (long value)** | Value truncates with ellipsis; full value in `title`. A `file://`-length path must not push `✕` off the row — the actions column is fixed-width and never shrinks. | Description clamps to one line, `-webkit-line-clamp: 1`. Skill names can be long (`framer-project-0HbRcQlMdLdNKenJm9Mr`) — name column truncates at the *end*, never the middle. |
| **Overflow (many rows)** | List scrolls with the page. 40+ variables is not a case worth designing for. | Groups collapse at 8; filter is the answer above ~30. |
| **Error** | Denied name (§3.4). Duplicate name: the second row shows *"Already set above — the last one wins."* and is refused. | Catalog read failed: the group header says *"Couldn't read ~/.claude/skills"* with a `retry` link. Never an empty group pretending there are no skills. |
| **Conflict** | Repo `.claude/settings.json` sets the same name: the row shows `overrides repo` in muted text with the repo value in `title`. | A repo-level `skillOverrides` entry shows as the inherited value, ring-less. |

**Themes.** Every colour above is a token: `--fg`, `--fg-muted`, `--border`, `--bg-surface`,
`--overlay-subtle`, `--accent`, plus the two derived inks already in the codebase (`WARN_INK`,
`CONTROL_OFF`). No opacity is stacked on `--fg-muted` anywhere — the token *is* the recede.
Transparent badges only; the rings are `color-mix(… var(--accent) 40%, transparent)`, never a
solid accent fill. The one thing to check on the three light palettes when this is built: the
`(empty)` and `from Operator secrets` placeholders sit at the 72% `--fg` step-down, not at
`--fg-muted` — they carry meaning, and 1984-light is where a meta-weight sentence disappears.

---

## 6. Data shapes

```ts
/** A list, never a Record — a map keyed by name can't hold an origin or a tombstone,
 *  and the original design already called this out as the shape to leave room in. */
export type EnvEntry =
  | { name: string; value: string }
  | { name: string; secret: string }   // secret NAME, resolved at spawn. Never a value.
  | { name: string; unset: true }      // a tombstone — masks the altitude above

export type SkillMode = 'on' | 'name-only' | 'user-invocable-only' | 'off'

export interface SkillPolicy {
  /** Keyed by skill name; plugin skills by `plugin:skill`. Absent = on. */
  overrides: Record<string, SkillMode>
  /** Mirrors Claude Code's own key, so it can be written straight through. */
  plugins?: Record<string, boolean>
}

// projects.json
interface Project { /* … */ env?: EnvEntry[];  skills?: SkillPolicy }
interface Role    { /* … */ env?: EnvEntry[];  skills?: SkillPolicy }

// in-memory only, per launch
interface SessionConfig { /* … */ env?: EnvEntry[]; skills?: SkillPolicy }

/** What the resolver hands the surfaces. */
interface ResolvedEnvRow {
  name: string
  value?: string
  secret?: string
  unset?: boolean
  origin: 'project' | 'lane' | 'run' | 'repo'
  /** What the layer below said, for the ↺ and the tooltip. */
  shadowed?: { value?: string; secret?: string; origin: ResolvedEnvRow['origin'] }
}

interface SkillCatalogEntry {
  name: string
  description: string
  source: { kind: 'global' | 'project' | 'plugin'; label: string; path: string; plugin?: string }
}
```

**The per-session settings file** — `~/.operator/sessions/<sessionId>/settings.json`, written
immediately before spawn, passed as `claude --settings <path>`:

```json
{
  "tui": "default",
  "env": { "NODE_ENV": "staging", "API_BASE": "http://localhost:1429" },
  "skillOverrides": { "framer-code-components": "off", "artifact-design": "name-only" },
  "enabledPlugins": { "mattpocock-skills@claude-plugins-official": true }
}
```

Secrets appear **nowhere** in that file. They go onto the pty `CommandBuilder` at spawn — the
one deliberate spawn-time path, and the reason it is worth the exception is exactly that it
keeps values off disk in a file Operator itself creates.

**New bridge calls:**

```ts
skillsCatalog(projectPath: string): Promise<SkillCatalogEntry[]>   // walks the three roots
secretsList(): Promise<string[]>                                   // NAMES only
secretSet(name: string, value: string): Promise<void>
secretDelete(name: string): Promise<void>
// terminalSpawn launchOptions gains: env, secretNames, skillOverrides, enabledPlugins
```

`secretsList` returning names only is not a nicety — no bridge call may ever return a secret
value to the renderer, or one `console.log` in a debug session puts it in the transcript, and
`transcript.rs` writes that to `chat.db` durably.

---

## 7. Build plan, in order

Each step is shippable and verifiable on its own; nothing later is needed to prove anything
earlier.

**S0 — the per-session settings file.** `lib.rs` writes
`~/.operator/sessions/<id>/settings.json` containing today's `{"tui":…}` and passes the path
instead of the inline JSON. No UI. *Verify:* a lane launches, the file exists, `tui` is still
honoured, `/status` still shows the user's global model — i.e. `--settings` merged rather than
replaced (the help text says "additional", and S0 is where that gets confirmed in the app rather
than in a help string).
**Risk if skipped:** everything else writes into a file that doesn't exist.

**S1 — `skillsCatalog` + a read-only Skills page.** The disk walk, plus Surface B's Skills page
rendering groups, counts, descriptions, and the *existing* overrides from
`~/.claude/settings.json` as read-only state. Nothing writes yet.
*Verify:* the page lists this Mac's real skills, and the three `framer-*` skills show as `off`
without anyone having touched the page. A read-only page can be wrong safely; a writing one
cannot.

**S2 — `env-policy.ts` + `EnvRowList`, on Surface B's Environment page.** Config tier only —
no secrets. The denylist as a pure exported function with its own test; the clear-value prompt;
delete-to-unset. Writes `Project.env` in `projects.json`.
*Verify:* `PORT` is refused with the right sentence; `CLAUDE_CODE_FOO` is refused with the
*other* sentence; clearing a value prompts and neither branch happens by accident.

**S3 — the resolver + the launch path.** `resolveEnv` / `resolveSkills` (one module, tests
first: per-row origin, tombstones, last-writer-wins), and S0's file gains `env`,
`skillOverrides`, `enabledPlugins` from the project layer.
*Verify:* launch a lane, run `env | grep NODE_ENV` in it, run `/skills` and see the project's
overrides applied.
**This is the first step where the feature actually does something**, and it does it with no new
surface at all — which is the right place for the risk to sit.

**S4 — Surface B's Skills page writes.** Checkbox → `off`/`on`, the listing-mode `PopMenu`, the
plugin toggles. Writes `Project.skills`.
*Verify:* turn a skill to `name-only`, launch, `/skills` shows it without a description.

**S5 — the lane altitude.** `Role.env` / `Role.skills`, the two disclosures on the expanded
`RoleCard`, reusing both shared components with `altitude="lane"`.
*Verify:* a lane pin overrides one project variable and leaves the rest alone — the per-row
merge, which is the thing most likely to be built wrong.

**S6 — the launch sheet.** `LaunchSheet`, `⌥Launch` and `Set up run →`, the run altitude, the
`↺` restore, masking, the footer difference sentence, the collapsed-row chip.
*Verify:* the one-click `Launch →` path is byte-identical to before; the sheet's run layer
survives to the spawned session and is *not* written to `projects.json`.

**S7 — secrets.** `~/.operator/secrets.json`, `secretsList`/`secretSet`/`secretDelete`, the
`+ secret` flows on both surfaces, spawn-time resolution onto the pty env.
*Verify:* the value never appears in the session settings file, in `projects.json`, or in any
bridge return; the row shows `from Operator secrets` after a restart.
**Last deliberately** — it is the only step that can leak, and it should land on machinery that
is already proven.

**Not in this plan, and not by accident:** reveal-a-secret, masked inputs for config, Keychain
storage (the honest upgrade after S7, and the point at which the wording can change), redaction
of secret values in the transcript (worth doing *alongside* Keychain, worthless without it), and
any user-global tier for env or skills — `role-defaults.json` stays retired.

---

## 8. Open questions — carry them, don't guess

1. **Plugin skill override keys.** `skillOverrides` is documented as "keyed by skill name". For
   a plugin skill the invocation name is `plugin:skill` (`mattpocock-skills:tdd`), but whether
   the override key uses that form or the bare skill name is **unverified**. Settle it in S1 by
   writing one override by hand and watching `/skills` — before any UI can write them.
2. **Does env reach Task-tool subagents?** Still open from the original design. Don't depend on
   it, don't claim it in copy.
3. **`enabledPlugins` has two writers** after S4 — `PluginsSection` (the repo's
   `.claude/settings.json`) and the Skills page (the per-session file). They can disagree, and
   the per-session file wins. The Skills page's inherited line has to say so; if that reads
   badly in use, the fix is for `PluginsSection` to link *here* rather than for this page to
   start writing the repo file.
4. **`(empty)` vs a genuinely absent value** is a distinction this design draws in copy. Worth
   watching whether it survives contact — if users read `(empty)` as "nothing here", the
   fallback is `""` rendered literally, in mono.
