# Skill management — beyond selection

**Design, 2026-08-24. Design only.** Extends the merged read-only Skills page
(`session-settings-design.md` §4.2 as built in `SkillsSection.tsx`, carrying the S0–S3
correction) with a user-level tier, per-skill source view/edit/create/remove, and per-plugin
install/update/remove.

---

## 0. What was checked, and the five findings that shape it

| # | Finding | Where | Consequence |
|---|---|---|---|
| 1 | **`claude plugin install/update/uninstall` require `-y` when stdout is not a TTY.** The help text says so on all three: *"required when stdin or stdout is not a TTY"*. | `claude plugin install --help` etc. | Electron main spawning these gets **no TTY**. Without `-y` the command blocks on a confirmation prompt with nowhere to render — an install that hangs forever with no error. This is the single most likely way to ship this feature broken. |
| 2 | **`plugin list --json` already returns everything a plugin row needs** — `id`, `version`, `scope`, `enabled`, `installPath`, `installedAt`, `lastUpdated`, `mcpServers`. | run against the live CLI | No scraping, no manifest parsing. The brief's "version shown" is one field. |
| 3 | **The `Skill` tool has no case in `tool-summary.ts`**, and the default fallback probes `file_path / command / path / pattern / description / prompt` — none of which is `skill`. A real invocation is `{"name":"Skill","input":{"skill":"run","args":"…"}}`. | `tool-summary.ts:40-79`; sampled from `~/.claude/projects/**/*.jsonl` | Skill calls currently summarize as `Use Skill` with **target `undefined`** — the name is thrown away. **"Used by" cannot be built until one `case 'Skill'` is added.** Prerequisite, §6 S1. |
| 4 | **`FileViewer` is CodeMirror, and it is already an editor.** Read-only is two explicit lines — `EditorState.readOnly.of(true)` + `EditorView.editable.of(false)` — with a comment saying they are deliberately both. | `files/FileViewer.tsx:130-141`, `files/cm-theme.ts` | "Edit in place" costs a prop and a save path, **not a dependency**. The six-role theme already resolves CSS vars at paint time, so an editable buffer inherits all six palettes for free. |
| 5 | **The S0–S3 correction stands and is load-bearing.** Measured against CLI 2.1.235: `skillOverrides` reaches **global and project skills only** — not `plugin:skill`, not the bare name, not `plugin@marketplace:skill`. `enabledPlugins` is all-or-nothing. | `SkillsSection.tsx:12-20` | A plugin skill gets **no per-skill control anywhere on these pages**, including the new ones. Its row is informational; the only lever is its plugin. Offering one would write a key that silently does nothing. |

One more, from the catalog reader: plugin skill trees are **nested** (`skills/engineering/tdd/SKILL.md`), the in-between directories are shelving, and **the name comes from the front matter, never the path** (`skills.ts:14-20`). Anything this design writes back must preserve that: renaming a skill means editing `name:` in the front matter, not moving a directory.

---

## 1. Two pages, one component set

| Page | Tier | Where |
|---|---|---|
| **Settings → Skills** (new) | global: `~/.claude/skills` + installed plugins/marketplaces | user-level `PageShell`, beside the existing global `.claude` surfaces |
| **Project settings → Skills** (built) | project: `<project>/.claude/skills`, plus the global tier shown as inherited | unchanged location |

They share `SkillList`, `SkillRow`, `SkillSourceView` and `PluginList`. The difference is one
prop — `tier: 'global' | 'project'` — which decides **what is editable** and **what "remove"
means**. A project page never edits a global skill; it shows it as inherited with an
`Edit in Settings ↗` link. One writer per file, the rule this repo keeps re-learning.

---

## 2. The user-level Skills page

```
  Skills                                                     ← page title
  Everything Claude Code loads for you, in every project.     ← subtitle

  ─Instructions─Permissions─General─Hooks─┃Skills┃─Plugins─

  YOUR SKILLS                                    ~/.claude/skills
  Editable here. These load in every project.

  ┌ ⌕ filter                                                        ┐
  │                                                     used by     │
  │  no-ai-slop         Edit drafts into sharper, human…   Design 4 │
  │  framer             Design, edit, or publish a website     —    │
  │  framer-code-com…   Framer code components            off   —   │
  │  ⌄ 2 more                                                       │
  ├─────────────────────────────────────────────────────────────────┤
  │  + New skill                                                    │
  └─────────────────────────────────────────────────────────────────┘

  FROM PLUGINS                                              6 plugins
  Skills a plugin brings. Claude Code has no per-skill control for
  these — a plugin is on or off as a whole.

  ┌─────────────────────────────────────────────────────────────────┐
  │  mattpocock-skills@claude-plugins-official                      │
  │  v1.2.3 · updated 12 Aug · 9 skills            ⟨On⟩ Off  ⋯      │
  │    diagnosing-bugs · tdd · code-review · research · grilling    │
  │    · prototype · domain-modeling · wizard · writing-for-agents   │
  ├─────────────────────────────────────────────────────────────────┤
  │  frontend-design@claude-code-plugins                            │
  │  v1.1.0 · updated 27 May · 1 skill      update →  ⟨On⟩ Off  ⋯   │
  │    frontend-design                                              │
  ├─────────────────────────────────────────────────────────────────┤
  │  + Install a plugin                                             │
  └─────────────────────────────────────────────────────────────────┘

  MARKETPLACES                                                     2
  claude-plugins-official · anthropics/claude-plugins-official   ⋯
  claude-code-plugins   · anthropics/claude-code-plugins         ⋯
                                                 + Add a marketplace
```

Notes on what this asserts:

- **Plugin skills are listed as names only, inline, not as rows.** They cannot be acted on
  individually (finding #5), and a row that looks like the actionable rows above it but isn't is
  worse than a list. The sentence above the section says why, once.
- **`update →`** appears only when a newer version is known. `plugin list --json` gives the
  installed version; the available one comes from `plugin list --available --json`. When we have
  not checked, there is **no chip at all** — not a greyed one, which would claim we looked.
- **`used by`** is §5.
- **`⋯`** is the per-plugin menu (`Update`, `Uninstall`, `Reveal in Finder`, `Details…`).
  A menu, not three inline buttons: uninstall must not sit one pixel from a toggle.

---

## 3. A skill, opened

Clicking a skill row expands it in place — the same disclosure idiom the roster card's charter
uses, not a modal:

```
  │  no-ai-slop         Edit drafts into sharper, human…   Design 4 │
  │  ┌───────────────────────────────────────────────────────────┐  │
  │  │ ~/.claude/skills/no-ai-slop/SKILL.md      2.4 KB · md     │  │
  │  ├───────────────────────────────────────────────────────────┤  │
  │  │  1 │ ---                                                  │  │
  │  │  2 │ name: no-ai-slop                                     │  │
  │  │  3 │ description: Edit drafts into sharper, more human…   │  │
  │  │  4 │ ---                                                  │  │
  │  │  5 │                                                      │  │
  │  │  6 │ # Editing for voice                                  │  │
  │  │  7 │ …                                                    │  │
  │  └───────────────────────────────────────────────────────────┘  │
  │     Edit    Reveal ↗    Duplicate to project    Delete skill…   │
```

- **The viewer is `FileViewer`**, unchanged, at `form="wide"` with `root` = the skill's directory
  and `path` = `SKILL.md`. Finding #4 means it already highlights markdown across six palettes.
- **`Edit` flips the same view editable** — `readOnly`/`editable` become a new `editable` prop
  rather than hardcoded `true`/`false`. The header gains `Save` / `Cancel`; `⌘S` saves. **No
  second editor component, and no modal**: the thing you were reading becomes the thing you are
  writing, in place, which is the whole argument for reusing it.
- **Four verbs, four distinct marks, none reused** — `Edit`, `Reveal ↗`, `Duplicate to project`,
  `Delete skill…`. All words. The `✕` glyph appears nowhere on this page: it means *delete lane*
  elsewhere in this app, and the v0.10.0 data-loss note is explicit that two verbs never share a
  glyph. The trailing `…` on `Delete skill…` is the standard "this will ask" mark.
- **A plugin skill's expansion has no `Edit` and no `Delete`** — it shows the source read-only,
  with `Its plugin owns this file. Updating the plugin overwrites it.` That is true and is the
  reason, so it is the sentence.
- **A global skill opened from the *project* page** shows the same viewer read-only with
  `Edit in Settings ↗`.

**Front-matter guard on save.** The name and description come from the front matter, and the
catalog dedupes by name (`dedupeByName`). So a save that changes `name:` renames the skill and
can collide with another. On save, if `name:` changed: *"This renames the skill to `x`. Claude
Code will stop loading it as `no-ai-slop`."* — and if the new name already exists in the same
tier, refuse with *"A skill called `x` already exists in ~/.claude/skills."* Parsing already
exists (`parseSkillFrontMatter`); this is a check, not a parser.

---

## 4. Create, and remove

### Create — `+ New skill`

```
  ╭ New skill ───────────────────────────────────────────────╮
  │  NAME     ┃release-notes                              ┃  │
  │           ~/.claude/skills/release-notes/SKILL.md         │
  │                                                           │
  │  WHEN TO USE IT                                           │
  │  ┃Drafting release notes from a set of merged PRs      ┃  │
  │  This becomes the `description:` — it is how Claude       │
  │  decides whether to load the skill, so write the          │
  │  trigger, not the summary.                                │
  │                                                           │
  │  SCOPE     ▏Global▕  This project                         │
  │                                                           │
  │                              Cancel      Create skill     │
  ╰───────────────────────────────────────────────────────────╯
```

Writes a SKILL.md with valid front matter and a short body scaffold. **The scope segment is the
only thing that differs between the two pages** — the project page defaults to `This project`,
the settings page to `Global`, and both offer both, because "I meant the other one" is the most
likely mistake here and it is cheaper to prevent than to move a directory afterwards.

Name validation: lowercase, digits, dashes; must not already exist in the chosen tier. Rejected
inline with the reason, the same shape as the env denylist.

**Not `claude plugin init`** — verified, that scaffolds a *plugin* at `~/.claude/skills/<name>/`
that auto-loads as `<name>@skills-dir`, which is a different object with a different lifecycle.
A plain skill is one directory and one file; writing it directly is honest and has no CLI
dependency.

### Remove — guarded in proportion to what is lost

Three different destructions, three different guards. This is the rule, applied rather than
asserted:

| Action | What is lost | Guard |
|---|---|---|
| **Turn a skill off** | nothing — a settings key | none; click the lit option to clear |
| **Disable a plugin** | nothing — reversible from the same row | none |
| **Uninstall a plugin** | recoverable: reinstall from the marketplace | one confirm naming the plugin, with `--keep-data` offered as a checkbox: *"Keep its data directory"* |
| **Delete a global/project skill** | **user-authored prose, nowhere else** | confirm requiring the skill's **name typed** |

The last one is deliberately the heaviest thing on the page. A hand-written SKILL.md is not
recoverable from a marketplace, is not in git if it lives in `~/.claude/skills`, and a mis-click
on a list of similarly-named rows destroys it silently:

```
  ╭ Delete no-ai-slop? ──────────────────────────────────────╮
  │  This deletes ~/.claude/skills/no-ai-slop/ and           │
  │  everything in it. It is not in a repository and there    │
  │  is no undo.                                              │
  │                                                           │
  │  Type the skill's name to confirm:                        │
  │  ┃                                                     ┃  │
  │                                                           │
  │                        Cancel      Delete skill           │
  ╰───────────────────────────────────────────────────────────╯
```

`Reveal ↗` sits beside `Delete skill…` in the expanded row precisely so the cheap escape ("let me
just look at it in Finder first") is always one click closer than the expensive one.

---

## 5. "Used by"

A count per skill of `Skill` tool invocations, attributed to the lane that made them, read from
the transcripts already being tailed.

```
   used by
   Design 4              one lane
   Design 4 · Code 1     two, most-used first
   —                     never invoked
   Design 4 · +2         more than two lanes
```

- Source: `tool_use` blocks with `name: "Skill"`, keyed on `input.skill`. **Blocked on finding
  #3** — `tool-summary.ts` currently discards it.
- **Scope: this project's lanes**, over the retained transcript window. Hovering gives the
  precise sentence, because a bare number invites over-reading:
  *"4 times in this project since 12 Aug — the window Operator keeps."*
- `—` for never-invoked, not `0`. Zero looks measured; an em dash reads as "nothing recorded",
  which is the honest claim when the window is bounded.
- It is **information, never a control.** Nothing sorts by it, nothing suggests removing an
  unused skill, and there is no "unused" badge. A skill invoked zero times may be the one that
  saves the next session, and a UI that nudges toward pruning on this number would be acting on
  evidence it does not have.

---

## 6. The CLI surface, exactly

Every plugin operation shells out from Electron main. Commands verified against the installed
CLI, with the flags that matter:

| Operation | Command |
|---|---|
| list installed | `claude plugin list --json` |
| list available | `claude plugin list --available --json` |
| install | `claude plugin install <plugin>[@<marketplace>] --scope user -y` |
| update | `claude plugin update <plugin> --scope user -y` |
| uninstall | `claude plugin uninstall <plugin> --scope user -y [--keep-data]` |
| enable / disable | `claude plugin enable <plugin>` / `claude plugin disable <plugin>` |
| details | `claude plugin details <name>` |
| add marketplace | `claude plugin marketplace add <url\|path\|owner/repo> --scope user` |
| list marketplaces | `claude plugin marketplace list` |
| update marketplaces | `claude plugin marketplace update [name]` |
| remove marketplace | `claude plugin marketplace remove <name>` |

**`-y` on install/update/uninstall is not optional** (finding #1) — no TTY, no prompt, and
without it the child never exits. The `--scope` flag is passed explicitly on every call rather
than relying on the `user` default: the project page will want `--scope project`, and a default
that silently differs between the two pages is the bug this avoids.

**Two things the UI must carry from the CLI's own words:**

- `update` says **"restart required to apply"**. So a successful update leaves the row saying
  `updated to v1.2.0 · restart Operator to load it`, and does not pretend the new version is live.
- A marketplace-declared install command can require confirmation, which `-y` accepts on the
  user's behalf. So the install flow **shows the source before running**: *"Installs from
  `anthropics/claude-plugins-official`. Plugins run code in your sessions."* One sentence, at the
  point of entry, before the `-y` is spent.

**Running them:** `spawn`, never `shell: true` — plugin names and marketplace sources are user
input and a marketplace source is a URL. Timeout 60s (a git clone), stderr captured and shown
verbatim on failure. A failed install says what the CLI said; a paraphrase of a git error helps
nobody.

---

## 7. Components and props

```
electron/src/main/
    skills.ts              EXISTS — catalog. Gains: readSkill, writeSkill, createSkill, deleteSkill
    plugins.ts             NEW — the CLI wrapper above, one function per row of the table
src/renderer/components/skills/
    SkillList.tsx          the filterable list + groups (extracted from SkillsSection)
    SkillRow.tsx           row + expansion
    SkillSourceView.tsx    FileViewer at form="wide", editable when the tier allows
    NewSkillDialog.tsx
    DeleteSkillDialog.tsx  the type-the-name guard
    PluginList.tsx         plugin rows, version, update, ⋯
    InstallPluginDialog.tsx
    MarketplaceList.tsx
src/renderer/lib/
    skill-usage.ts         NEW — Skill invocations → per-skill, per-lane counts. Pure, tested.
```

```ts
export function SkillRow(props: {
  entry: SkillCatalogEntry
  mode: SkillMode                 // 'on' | 'name-only' | 'user-invocable-only' | 'off'
  /** Which tier this PAGE writes. Decides whether Edit/Delete are offered at all. */
  tier: 'global' | 'project'
  /** Plugin skills get no per-skill control anywhere — S0–S3, measured. */
  controllable: boolean
  usage?: { lane: string; count: number }[]
  expanded: boolean
  onExpand(): void
  onSetMode(m: SkillMode): void
  onEdit?(): void
  onDelete?(): void
  onDuplicate?(to: 'global' | 'project'): void
}): JSX.Element
```

```ts
// FileViewer's ONE change: read-only stops being hardcoded.
export interface FileViewerProps {
  /* …unchanged… */
  /** Default false — every existing caller keeps today's behaviour with no edit. */
  editable?: boolean
  /** Required when `editable`. Resolves on write; rejects with the fs error verbatim. */
  onSave?(path: string, text: string): Promise<void>
}
```

```ts
export function PluginList(props: {
  plugins: InstalledPlugin[]      // straight from `plugin list --json`
  available?: Record<string, string>   // id → latest version, when checked
  skillsByPlugin: Record<string, string[]>   // names only, from the catalog
  busy?: Record<string, 'installing' | 'updating' | 'removing'>
  onToggle(id: string, on: boolean): void
  onUpdate(id: string): void
  onUninstall(id: string, keepData: boolean): void
}): JSX.Element
```

`busy` matters: a `claude plugin install` is a git clone and can take ten seconds. The row shows
`installing…` in place of its controls and the controls do not grey out — they are replaced, so
nothing looks disabled-and-broken.

---

## 8. Build plan

**S1 — `case 'Skill'` in `tool-summary.ts`.** One case, returning
`{ action: 'Use skill', target: input.skill }`, with a test. Nothing else depends on it and
everything about §5 does.
*Verify:* a `Skill` call in the transcript shows the skill's name in the chat's tool line, which
it does not today.

**S2 — `plugins.ts`: the read half.** `list --json` and `list --available --json`, parsed and
typed. No writes.
*Verify:* the six real plugins on this machine come back with versions, and `frontend-design`
shows an available version different from its installed one, or none if the marketplace has no
newer.

**S3 — the user-level Skills page, read-only.** `PageShell` tab, `SkillList` extracted from
`SkillsSection` so both pages share it, plugin section with versions, marketplace list.
*Verify:* the page matches `claude plugin list` exactly, and the three `framer-*` skills already
`off` in `~/.claude/settings.json` show as off without anyone touching the page.

**S4 — source view.** `SkillSourceView` wrapping `FileViewer`, read-only, on both pages.
*Verify:* a nested plugin skill (`…/skills/engineering/tdd/SKILL.md`) opens — the path is not
`skills/<name>/SKILL.md` and a flat assumption would miss it.

**S5 — edit + save.** `editable` on `FileViewer`, `writeSkill` in main, the front-matter rename
guard.
*Verify:* editing a description changes what the catalog reports on reload; renaming to an
existing name is refused; `⌘S` saves and the dirty state survives collapsing the row.

**S6 — create and delete.** `NewSkillDialog` both scopes, `DeleteSkillDialog` with the typed
name.
*Verify:* a created skill appears in the catalog on reload and loads in a new session; delete
removes the directory and nothing else.

**S7 — plugin writes.** install / update / uninstall / enable / disable, `-y` on all three of the
first, `busy` states, stderr surfaced verbatim, the restart-required line after update.
*Verify:* an install with `-y` **completes** rather than hanging — the finding-#1 case, and the
one to test first, not last.

**S8 — marketplaces**, then **used-by** wired into the rows.

**Not in scope:** editing a plugin's own skills (its update overwrites them), skill authoring
assistance beyond the scaffold, `claude plugin eval` / `validate` / `tag` (developer commands,
not management), and any automatic pruning suggestion based on usage.

---

## 9. Open questions

1. **Does `plugin list --available --json` hit the network on every call?** If it does, it cannot
   sit in the page's load path — it becomes a `Check for updates` action with a timestamp. Time
   it at S2 before deciding where it runs.
2. **Does a `--scope project` install write into the repo?** If it touches
   `.claude/settings.json` or adds a directory, the project page's install button is a repo
   mutation and needs to say so. Check before S7.
3. **Where does a project-scope skill live for a lane in a worktree** — the worktree's
   `.claude/skills`, or the main checkout's? Lanes have different checkouts, so "this project"
   is ambiguous exactly here. The catalog takes a `projectPath`; whoever passes it decides, and
   the dialog should name the resolved path (it already shows the full path under the name field).
4. **Skill usage attribution across subagents.** A `Skill` call made inside a `Task` subagent
   carries the subagent's caller, not the lane's. Whether those count toward the lane is a
   judgement; `ToolBlock.caller` is present on 100% of real blocks, so it is answerable — decide
   before S8 rather than letting the first implementation settle it silently.
