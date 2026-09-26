# Claude Code settings facts — `--settings`, `skillOverrides`, `enabledPlugins`, `env`

**Scope:** research only, no code changed, no real settings files touched. Verified against the
installed CLI (`claude --version` → `2.1.241`), official docs (`code.claude.com`), one GitHub
issue, and a handful of throwaway `claude -p` runs in a scratch project dir
(`/private/tmp/claude-settings-test/proj`, deleted after use) using a purpose-made throwaway
skill and, for the plugin test, the user's real *installed* plugins (queried read-only via
`--settings`, which is session-scoped and never writes to `~/.claude/settings.json`).

## (1) `--settings`: file path vs inline JSON, and precedence

Confirmed from `claude --help`:

> `--settings <file-or-json>`  Path to a settings JSON file or a JSON string to load additional settings from

Both forms work — verified empirically: a file path (`--settings /tmp/.../env-settings.json`)
and an inline JSON string (`--settings '{"env":{"FOO":"bar"}}'`) both took effect identically in
the `echo $FOO` test below.

**Precedence**, from the official docs page (`code.claude.com/docs/en/settings`, embedded
`SettingsPrecedence` component data — highest wins, quoted verbatim from the page's own labels):

1. **Managed settings** — `managed-settings.json`, MDM, or the claude.ai console (org-controlled)
2. **Command line** — `claude --settings` (this session only)
3. **Project local** — `.claude/settings.local.json` (this project, not shared)
4. **Shared project** — `.claude/settings.json` (everyone in the project)
5. **User** — `~/.claude/settings.json` (every project)

So `--settings` (whether Operator's `terminals.ts:103` or an ad-hoc file) sits **second**,
beneath only an org's managed policy — it overrides the repo's `.claude/settings.json`, the
repo's `.claude/settings.local.json`, and the user's own `~/.claude/settings.json`. This is
exactly what makes it a reliable per-lane override channel for Operator: nothing short of a
managed-settings policy can out-rank it.

## (2) `skillOverrides` — accepted values, and does `--settings` honour it

**Accepted values** (per-skill, keyed by skill name):
- `"off"` — hidden from the model entirely (not listed, not invocable)
- `"user-invocable-only"` — hidden from the model's own skill listing, but still reachable via
  `/skill-name`
- `"name-only"` — bare name shown, description stripped

⚠ **There is a known bug for this exact key**, filed as
[anthropics/claude-code#50631](https://github.com/anthropics/claude-code/issues/50631)
("`skillOverrides` in user/project settings has no effect — `g7H()` is a stub returning `\"on\"`"),
against **v2.1.114**. The report says the resolver only consulted `policySettings`/`flagSettings`
and skipped `userSettings`/`projectSettings` entirely, so a user's or project's own
`skillOverrides` was silently ignored in the system prompt (the `/skills` UI showed the override
correctly — only the actual prompt-construction path was broken). No maintainer response or
fix-version is visible on the issue itself.

**Verified live against the installed v2.1.241** (later than the reported-broken 2.1.114), using
a throwaway skill (`throwaway-test-skill`, project-local `.claude/skills/`, with a distinctive
description mentioning "Zorblatt Quonch Ferrenmire" so a positive answer can't be a guess):

| `--settings` payload | Result (`claude -p`, asked "is this skill listed?") |
|---|---|
| *(none)* | **YES**, full description echoed back verbatim |
| `{"skillOverrides":{"throwaway-test-skill":"off"}}` | **NO** |
| `{"skillOverrides":{"throwaway-test-skill":"name-only"}}` | **YES**, bare name only — description not shown |
| `{"skillOverrides":{"throwaway-test-skill":"bogus-value"}}` | No error, no crash (invalid value silently no-ops — consistent with `--help`'s "Settings files that fail validation are silently ignored" for `-p` mode) |

**Conclusion: fixed (or never regressed) as delivered via `--settings` specifically.** The bug
report was about `userSettings`/`projectSettings` (the settings *files*), not the CLI flag path —
and this test only exercises the CLI-flag path, which behaved correctly in both directions
(`off` hid it, `name-only` stripped the description). This does **not** prove the file-based
`skillOverrides` bug is fixed — that would need a separate test writing to a real
`~/.claude/settings.json` or `.claude/settings.json`, which was out of scope (never touch real
settings files). For Operator's purposes this is moot either way: `terminals.ts` builds the
`--settings` JSON itself and passes it on the CLI, so it only ever exercises the
confirmed-working path.

## (3) `enabledPlugins` via `--settings` — cross-direction override

**Accepted shape:** object keyed by `"plugin-name@marketplace-name"` → boolean.

Verified live, using the user's real installed plugins (`claude plugin list`), with the CLI flag
only — nothing written to `~/.claude/settings.json`:

- **Disable a globally-enabled plugin:** `frontend-design@claude-code-plugins` is enabled at user
  scope (`claude plugin list` → `✔ enabled`). Baseline `-p` query: skill `frontend-design` listed
  = **YES**. With `--settings '{"enabledPlugins":{"frontend-design@claude-code-plugins":false}}'`:
  **NO** — confirmed suppressed.
- **Enable a globally-disabled plugin:** `frontend-design@claude-plugins-official` (a *different*
  marketplace, same skill name) is disabled at user scope. To isolate it from the plugin above
  (which supplies the same skill name and would otherwise mask the result), one call forced
  *both*: `{"frontend-design@claude-code-plugins": false, "frontend-design@claude-plugins-official": true}`.
  Result: skill `frontend-design` still listed = **YES** — since the only enabled source in that
  call was the one flipped on from its disabled default, this confirms `--settings` can enable a
  plugin that's off in the user's real settings, not just disable one that's on.

Both directions work, consistent with `--settings` sitting above `~/.claude/settings.json` in the
precedence table in (1). One documented constraint worth flagging (from the plugins reference
page / search synthesis, not independently re-tested): **`skillOverrides` cannot resurrect a
skill from a plugin that is switched off** — plugin-level enable/disable is a hard gate that
`skillOverrides` can only narrow, never widen.

## (4) Does `env` via `--settings` reach Bash-tool subprocesses?

**Yes, confirmed directly**, both as a file and inline:

```
$ claude -p --settings /tmp/.../env-settings.json 'Run: echo $FOO'
# settings file: {"env":{"FOO":"bar-from-settings"}}
Output of `echo $FOO`:
bar-from-settings
```

```
$ claude -p --settings '{"env":{"SUPERSECRETMARKER123":"visible-in-argv"}}' 'Run: sleep 4 && echo $SUPERSECRETMARKER123'
visible-in-argv
```

The Bash tool's child shell inherits whatever `env` sets, exactly like the `OPERATOR_DEV_PORT`/
`PORT`/`OPERATOR_TERMINAL_ID` vars Operator already sets a different way (via the pty's own spawn
env in `terminals.ts:121-129`, not via `--settings`'s `env` key). Both mechanisms land in the
same place — a `--settings`-supplied `env` key is a viable *alternative* channel to what
Operator does today, not a distinct capability.

## (5) Enumerating every skill Claude Code would load

Three sources, confirmed by directory inspection (read-only) plus this session's own available-
skills listing:

1. **Global user skills:** `~/.claude/skills/<name>/SKILL.md` — one directory per skill. Verified
   present on this machine (`framer`, `framer-code-components`, `no-ai-slop`, two
   `framer-project-*` dirs). Shown to the model with a **bare name** (no prefix) unless it
   collides.
   - Non-obvious: `claude plugin init|new <name>` explicitly scaffolds *into this same directory*
     (`~/.claude/skills/<name>/`) and the CLI's own `--help` text says it "auto-loads next
     session as `<name>@skills-dir`" — i.e. everything under the global skills dir is internally
     treated as an implicit plugin named `<name>@skills-dir`, not a wholly separate mechanism from
     plugin skills.
2. **Project skills:** `<project-root>/.claude/skills/<name>/SKILL.md`. Verified directly — a
   throwaway skill placed there was picked up by `claude -p` run from that directory (see (2)
   above) and, per the Skill tool's own description available in this session, a directory-scoped
   variant is shown as `<relative-dir>:<name>` (e.g. `apps/web:deploy`) when it needs
   disambiguating from an unscoped skill of the same name — "most specific wins; unscoped
   otherwise."
3. **Plugin skills:** `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/**/SKILL.md`
   — verified directly (`.../claude-code-plugins/frontend-design/1.1.0/skills/frontend-design/`,
   `.../claude-plugins-official/mattpocock-skills/1.2.3/skills/{deprecated,engineering,in-progress,misc,productivity}/…`
   — plugins can nest skills under categorized subdirectories, not just a flat list). Shown to the
   model as **`plugin-name:skill-name`** — confirmed directly from this very session's own
   available-skills listing (`frontend-design:frontend-design`, `mattpocock-skills:diagnosing-bugs`,
   etc.), and matches the enable/disable test in (3): the plugin id used for `enabledPlugins`
   (`plugin@marketplace`) and the skill id shown to the model (`plugin:skill`) are related but
   distinct strings — marketplace is part of the *plugin* identity, not the *skill* identity.

Which of these Operator would actually want to enumerate for a lane depends on what it's
building (e.g. a "what skills will this lane see" preview): walking all three directory roots
(`~/.claude/skills/`, `<cwd>/.claude/skills/` and any parent up to the project root, and
`~/.claude/plugins/cache/*/*/*/skills/`) plus reading `~/.claude/plugins/installed_plugins.json`
for which plugin versions are actually active would reproduce what the CLI itself resolves,
without needing to shell out to `claude` to ask.

## (6) `ps` argv-visibility caveat for inline JSON

**Confirmed real and worth treating as a hard constraint.** Captured with `ps -axwwo
pid,ppid,command` while a `--settings`-inline call was mid-flight (a `sleep 4` inside the Bash
tool kept the parent alive long enough to catch it):

```
20882 20881 claude -p --settings {"env":{"SUPERSECRETMARKER123":"visible-in-argv"}} Run: sleep 4 && echo $SUPERSECRETMARKER123
```

The full inline JSON — including anything placed in `env` — sits in the process's argv for its
entire lifetime, readable by **any local user** via a plain `ps`, no elevated privilege and no
TCC prompt needed (this is standard, unrelated to the per-pid-`lsof` TCC issue documented
elsewhere in this project — argv is public kernel process-table data). The **file-path** form
does not have this problem: only the path shows up in argv, not the file's contents.

**Direct implication for Operator:** `terminals.ts` today only ever puts non-secret data in
`--settings` (`{tui: o.tuiMode}`, `terminals.ts:103`) and sets actual env (`OPERATOR_DEV_PORT`,
`OPERATOR_TERMINAL_ID`, etc.) via the pty's own spawn `env` object, not via `--settings`'s `env`
key — so today's design is already argv-safe by construction. This is corroborating evidence for
the project's standing per-project-env-vars decision (carrier = Claude Code's own
`settings.json` `env` block, secrets kept separate) — **if that ever needs a *session-scoped*
variant** (e.g. Operator wants to pass something per-lane via `--settings` rather than through the
persistent `settings.json` file), it must go through the **file-path** form of `--settings`, never
inline JSON, for anything secret-shaped.

## Summary table

| Question | Answer |
|---|---|
| File path accepted by `--settings`? | Yes, confirmed — identical behavior to inline JSON |
| Precedence | Managed > **`--settings` (CLI)** > project-local > shared-project > user (docs, verbatim) |
| `skillOverrides` values | `"off"`, `"user-invocable-only"`, `"name-only"` — invalid values silently ignored |
| `skillOverrides` honoured via `--settings`? | Yes, verified on v2.1.241, both `off` and `name-only` behaved correctly. Known bug (#50631) was scoped to *file*-based user/project settings on v2.1.114, not the CLI flag |
| `enabledPlugins` via `--settings`: disable a globally-enabled plugin? | Yes, verified |
| `enabledPlugins` via `--settings`: enable a globally-disabled plugin? | Yes, verified |
| `env` via `--settings` reaches Bash subprocesses? | Yes, verified (file and inline) |
| Skill sources | `~/.claude/skills/<name>/`, `<project>/.claude/skills/<name>/` (walk up to project root; directory-scoped id when ambiguous), `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/**/` (id = `plugin:skill`) |
| Inline `--settings` JSON visible via `ps`? | Yes, confirmed — full payload in argv for any local user. Use the file-path form for anything secret-shaped |

## Sources

- [Claude Code settings](https://code.claude.com/docs/en/settings) — precedence order (fetched)
- `claude --help` (installed v2.1.241, this machine)
- [anthropics/claude-code#50631](https://github.com/anthropics/claude-code/issues/50631) — `skillOverrides` file-based bug report (v2.1.114)
- [Plugins reference — Claude Code Docs](https://code.claude.com/docs/en/plugins-reference)
- [Understanding enabledPlugins in Claude Code](https://thejavaguy.org/posts/025-understanding-enabledplugins-in-claude-code/)
- Live experiments: `claude -p` runs against a scratch project + a throwaway skill, and against the user's real installed plugins via session-scoped `--settings` (no files written)
