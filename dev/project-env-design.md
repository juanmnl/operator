# Per-project environment variables — the design

**Design, 2026-07-28.** Answers `dev/briefs/project-env-vars.md`. Design, not build. Research's findings on the Claude Code side are incorporated; nothing here is pending.

---

## 1. Two tiers, and they are not the same feature

> **Config describes the project. A secret authorises you.**
> Config can live anywhere the project lives. A secret may only live somewhere the project *isn't*.

That is the whole rule, and every decision below follows from it. `NODE_ENV=staging` is a fact about the project that every teammate wants and that belongs in version control. A Railway token is a fact about *you*, is worthless to a teammate, and is a liability the moment it's committed. Giving them one storage mechanism is what makes people paste tokens into shared files.

Consequence: separate UI, separate storage, and **separate wording** — the secrets affordance must never look like "the same box, but private", because a masked input trains people to believe the value is protected when only the pixels are.

---

## 2. The carrier: Claude Code's own `env` block

**Confirmed by Research: Claude Code natively reads an `env` block from `settings.json`, at every scope.** That settles it — the carrier is `.claude/settings.json`, and Operator does **not** invent a mechanism.

It wins for reasons Operator could not replicate:

- It works when the user launches `claude` from a plain terminal, not only when Operator spawns the session.
- It inherits Claude Code's existing scope precedence rather than adding a second, competing one.
- It already round-trips through Operator's editor today — `ClaudeSettings` has `[key: string]: unknown`, so a hand-written `env` block survives unshown.

**Operator's job shrinks to being an editor.** No `CommandBuilder` changes, no new field on `Project`, no injection path to maintain. That is the single most valuable consequence of the finding and should be protected: if a later feature is tempted to also set env at spawn, it is creating the second precedence chain this decision avoided.

### Scope precedence (Claude Code's, highest wins)

| | Scope | File | Our use |
|---|---|---|---|
| 1 | Managed | policy | not ours |
| 2 | CLI args | — | not ours |
| 3 | **Local** | `.claude/settings.local.json` | personal overrides — **not secrets**, see §4 |
| 4 | **Project** | `.claude/settings.json` | **where project config goes** — shared, committed |
| 5 | User | `~/.claude/settings.json` | the user's own defaults across projects |

The brief's `project` vs `project-local` split maps directly onto Local-vs-Project. No new mechanism, and `SettingsFileScope` already models both — the editor picks a scope the same way the other `.claude` surfaces already do.

---

## 3. What the mechanism forces

### 3a. A reserved-name denylist — still mandatory, for revised reasons

The carrier changes *how* a bad name does damage, not *whether* it does. Env from `settings.json` is applied by Claude Code to the processes it spawns — so a hostile name no longer breaks Operator's own spawn; it breaks what the agent runs. Two of the three groups get worse under this mechanism, not better.

| Group | What happens now |
|---|---|
| `PORT`, `OPERATOR_DEV_PORT` | **The worst case.** Operator reserves a unique port per lane, and the code comments describe at length how parallel lanes otherwise fight over it (Vite silently falls back to port+1). A `PORT` in `settings.json` is applied to every subprocess the agent starts — so the dev server binds the wrong port, and it does so *identically for every lane*, which is precisely the collision the reservation exists to prevent. |
| `CLAUDE_CODE_*`, `CLAUDECODE` | Some are simply **ignored** — Research confirms `CLAUDE_CODE_REMOTE` and `CLAUDE_CODE_ACCOUNT_UUID` have no effect via `env` as of v2.1.195. The rest affect any nested `claude` invoked from a Bash tool. Either way the user gets no feedback: the variable is set and nothing happens. |
| `TERM`, `FORCE_COLOR`, `COLORTERM`, `COLORFGBG` | Applied to subprocesses inside the pty, so tool output is coloured against Operator's terminal assumptions. |

**Rule: reject these at the edit surface, with the reason stated.** Two different reasons, and the UI should say which: *"Operator manages this"* for the port and terminal vars, *"Claude Code ignores this"* for the hosting-identity ones. A variable that is silently ignored is a bug report waiting to happen, and one that silently breaks port reservation is worse.

### 3b. Empty string is not "unset" — the editor must not pretend it is

Research: setting a variable to `""` still gets inherited as empty by subprocesses; it does **not** unset it. This matters more than it looks, because a great many tools test *presence*, not value — `if [ -z "$X" ]` and `if [ -v X ]` disagree exactly here, and so do most language runtimes' `env.get(...) ?? default` patterns.

So a user who clears the value field expecting removal instead changes behaviour, silently, in the direction of "set but blank".

**Rule: deleting the row is the only unset.** A blank value must not masquerade as removal — clearing the field should prompt *"Remove this variable, or set it to an empty value?"* rather than quietly choosing one. Empty is a legitimate thing to want; it just must be chosen deliberately.

### 3c. Blast radius: confirmed for tool subprocesses, open for subagents

Research confirms env reaches spawned tool subprocesses — **a Bash command sees the value**. Reach into Task-tool subagents is *not* confirmed either way (the docs say "subprocesses"; subagents may run in-process).

Two consequences, pointing opposite ways:

- **For secrets, the confirmed half is already decisive.** "Everything the agent runs can read it" is established fact, not a worry. §4 does not depend on the open half.
- **For config, the open half is a correctness question** — will a subagent's Bash see `NODE_ENV`? Until it's known, don't design anything that *depends* on it, and don't claim it in the UI. If a project's build genuinely needs the variable inside delegated work, that's a case to test rather than assume.

---

## 4. Tier 2 — secrets: not in v1, and the UI says so

**Recommendation: ship config only. Say plainly, in the UI, that this is not for secrets, and point at the mechanism that already works.**

This is not deferral for its own sake. **The pty is `$SHELL -ilc` — an interactive *login* shell** (`lib.rs:745`), so anything exported from `.zshrc` / `.zprofile` is already in every session's environment today. "Secrets: not yet" strands nobody; it points at an existing mechanism that lives outside the repo, cannot be committed, and that most developers already use for exactly this. A Railway token in a shell profile is *already* reaching the agent.

Shipping a secrets box now, in any available home, is actively harmful:

- **`.claude/settings.json`** is the shared, committed file. This is the disaster case, and an unlabelled "env vars" box invites it.
- **`.claude/settings.local.json`** looks safe and is not guaranteed to be. Checked on this machine: it is ignored by the user's **global** git config (`~/.config/git/ignore`), *not* by this repo's `.gitignore`. That is a property of one machine, not of the project — a teammate cloning fresh has no such rule, and `git add -A` commits the token. Being a real Claude Code scope makes it mechanically convenient; it does nothing about the guarantee, and the guarantee is the whole objection.
- **`~/.operator/projects.json`** is plaintext on disk and this project routinely dumps it while debugging. A token there ends up pasted into a chat transcript sooner rather than later.

### What the UI must say

Not fine print — the affordance itself: *"Project variables are stored in plain text and shared with your team. Don't put tokens or keys here — export those from your shell profile."* One line, at the point of entry, naming the alternative. If the wording has to be defensive, the feature is wrong.

### The shape secrets take when they are built

Stated now so the v1 data model leaves room and nobody reinvents it: the project stores a **name and a reference**, never a value — `{ name: 'RAILWAY_TOKEN', source: 'keychain' }`. The value lives in the macOS Keychain under a per-project account, written through a dedicated flow and **never read back to the screen**. At spawn Operator resolves the reference and sets it on the `CommandBuilder`.

Note this is the one case that *does* reintroduce a spawn-time path — deliberately, because a secret must not be written to any settings file. Worth the exception; not worth it for config.

That earns its complexity when the need is a token scoped to **one project**, which a shell profile genuinely cannot express. It does not earn it as a v1 for a token the user already has globally.

### Redaction is not a substitute

A token in the environment is visible to everything the agent runs (§3c, confirmed). Any command that prints its environment sends the value through `transcript.rs` into `chat.db` and onto the chat surface, **durably**. Redaction-by-value is worth doing *alongside* Keychain secrets and worth nothing without them: it only catches values Operator already knows, misses transformed or partial echoes, and cannot un-write what is already stored. **Damage limitation, never the reason it is safe to store a secret.** Nothing to build in v1 — there are no known values to redact until tier 2 exists.

---

## 5. Per-lane env — leave room, and know what it costs

The roster already pins model, effort and worktree per lane, so per-lane env is a fair question. **Do not build it.** But the carrier decision has a consequence worth writing down before someone discovers it mid-build:

**`settings.json` has no concept of a lane, so per-lane env cannot be expressed in the carrier.** It would need Operator's own storage plus a spawn-time injection — i.e. exactly the second precedence chain §2 avoided. That doesn't make it wrong, but it means per-lane env is a materially bigger change than per-project env, not an increment on it.

So: leave room in the shape, not in the carrier. If Operator ever holds env entries of its own, make them a **list of `{ name, value }`, not a `Record`**, so an optional `roleId` can be added without a migration — a map keyed by name cannot express "this value, but only for the Code lane". Precedence, if it arrives: **profile → Claude Code's scopes → lane.**

---

## 6. v1 scope

**In:** an editor for the `env` block in `.claude/settings.json`, at Project scope, in Folder Preferences beside the other `.claude` surfaces; values shown in full, unmasked; name validation against the §3a denylist with a plain-language reason; delete-to-unset with an explicit prompt when a value is cleared (§3b); UI wording that names what this is not (§4).

**Out, deliberately:** secrets of any kind, masked inputs, per-lane overrides, redaction, and any spawn-time injection path.

**Known unknown to carry, not resolve:** whether env reaches Task-tool subagents (§3c). Don't depend on it, don't claim it.

The honest v1 is small — an editor over a block Claude Code already honours. It is also the only version that doesn't quietly teach someone to commit a live token.
