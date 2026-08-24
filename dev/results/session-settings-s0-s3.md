# Session settings — S0 through S3

**Branch:** `operator/a30080` · commit `ca33211` · 2026-08-24 · Code lane
**Design:** `dev/results/session-settings-design.md` (operator/311c00)
**Correction applied:** the launch path is `electron/src/main/terminals.ts`, the Electron shell —
not `lib.rs`. The Tauri bridge is untouched apart from one stub (below).

---

## Open question 1, settled — and it changes the design

The design left this open and said not to guess: *for a plugin skill, does `skillOverrides` use
`plugin:skill` or the bare name?* I measured it against CLI 2.1.235 with
`claude -p --settings <file>`, asking the model which of three named skills were in its
available-skills list. Baseline first, so every row below is a delta against known state.

| `--settings` file | `no-ai-slop` | `framer-code-components` | `mattpocock-skills:tdd` |
|---|---|---|---|
| *(none — baseline)* | yes | **no** (user's global `off`) | yes |
| `{"skillOverrides":{"no-ai-slop":"off"}}` | **no** | no | yes |
| `{"skillOverrides":{"framer-code-components":"on"}}` | yes | **yes** | yes |
| `{"skillOverrides":{"tdd":"off"}}` | yes | no | **yes** |
| `{"skillOverrides":{"mattpocock-skills:tdd":"off"}}` | yes | no | **yes** |
| `{"skillOverrides":{"mattpocock-skills@claude-plugins-official:tdd":"off"}}` | yes | no | **yes** |
| `{"enabledPlugins":{"mattpocock-skills@claude-plugins-official":false}}` | yes | no | **no** |

**The answer is neither.** No key form reaches a plugin skill. `skillOverrides` applies to
global and project skills only; `enabledPlugins` — all-or-nothing per plugin — is the only
control for plugin-contributed ones.

Three consequences, all now built in:

1. **§4.2's per-skill checkbox must not be offered on a plugin row.** It would write a key that
   silently does nothing — precisely the failure the env denylist's second sentence exists to
   prevent elsewhere. The page states the limitation instead; the plugin group header carries the
   only real control. This is a change to the design, not an implementation detail, and S4 should
   be built against this table rather than against §4.2 as written.
2. **`--settings` merges at highest precedence — confirmed in the app's own terms, not from a
   help string.** Row 3 is the proof: a per-session `"on"` overrode the user's global `"off"`.
   That was the design's single biggest risk (finding #2) and it is retired.
3. **An explicit `"on"` is written, not dropped as "the default".** Absent means on *only* when
   nothing below says otherwise, and this user's global settings say otherwise for three skills.
   Dropping `on` would throw away the only way to re-enable one for a project.

---

## S0 — the per-session settings file

`electron/src/main/session-settings.ts`; wired at `terminals.ts` `buildCommand`.

`~/.operator/sessions/<sessionId>/settings.json`, **mode 600**, containing today's `{tui}` plus
whatever S3 resolves. The path is passed as `claude --settings <path>`.

- **Written synchronously.** The caller is `buildCommand`, whose result is the argv the pty is
  about to exec. An async write is a race between the file existing and `claude` reading it, and
  losing it means a lane launched with settings it was supposed to have and doesn't. A few
  hundred bytes, once per lane.
- **Empty blocks are omitted.** `"enabledPlugins": {}` is a well-formed instruction that says
  nothing, and this file is merged at the highest precedence there is — a future reader must not
  find one and take it for an intentional empty set.
- **A write failure returns `null` and the caller falls back to the old inline JSON.** Never
  being able to launch a lane because a directory wasn't writable is strictly worse than
  launching one without its env block.

**Verified end to end, outside the app**, with a file in exactly the shape the code emits:

```
$ echo "Run this bash command: printenv OPERATOR_S0_PROBE. Output only what it printed." \
  | claude -p --settings s0.json --allowedTools Bash
reached
```

That is the design's S3 verification (`env | grep NODE_ENV` in a lane) proven at the mechanism
level. What it does **not** prove is Operator's own wiring, which needs a real lane — see
*Not verified*.

## S1 — the catalog and the read-only Skills page

`electron/src/main/skills.ts`, `skillsCatalog(projectPath)` on the bridge, and a Skills tab.

- **The plugin tree is nested.** On this machine:
  `…/mattpocock-skills/1.2.3/skills/engineering/tdd/SKILL.md`. The flat
  `skills/<name>/SKILL.md` a first reading suggests would have missed most of it. Walk is
  recursive, depth-capped at 4, does not follow symlinked directories, and the skill's name comes
  from the front matter — the intermediate directories (`engineering`, `in-progress`) are
  shelving, not identity.
- **Front matter is parsed by `indexOf`, not `split(':')`.** Real descriptions are full of
  colons (`"Triggers on: 'chart', 'graph'"`), and splitting mangles them.
- **`installed_plugins.json` is the authority.** A cache directory left behind by an uninstalled
  plugin contributes nothing to a session; listing its skills would be a lie. If that file itself
  can't be read we keep everything — an over-full catalog is recoverable, an empty one looks like
  the feature is broken.
- **Nothing writes.** A read-only page can be wrong safely. It opens onto pre-existing state on
  day one: the three `framer-*` skills show `off` without anyone touching the page, exactly as
  the design predicted, because that is what `~/.claude/settings.json` already says.
- An unreadable root renders as *"Couldn't read …"* with a retry, never as an empty group
  claiming there are no skills.

## S2 — `env-policy.ts` and the Environment page

Pure module, 20 tests, both surfaces will share it.

**Two denial reasons, and the UI says which** — the whole point, because they lead somewhere
different:

- `PORT`, `OPERATOR_DEV_PORT`, `OPERATOR_TERMINAL_ID`, `OPERATOR_APP_PID`, `TERM`, `FORCE_COLOR`,
  `COLORTERM`, `COLORFGBG`, `TERM_PROGRAM` → *"Operator manages this… a value here would be
  replaced at spawn."*
- `CLAUDECODE`, `CLAUDE_CODE_*` → *"Claude Code ignores this… accepted and then silently do
  nothing."* The worse one to get wrong, because it fails quietly.

`CLAUDE_CONFIG_DIR` and `ANTHROPIC_API_KEY` are deliberately **not** denied — the same closed-set
rule `stripNestedSessionEnv` follows, since a `CLAUDE_*` wildcard would take a lane's auth with
it. There is a test asserting exactly that.

Shape is validated before policy (`MY-VAR`'s problem is the hyphen, not the denylist), delete is
the only unset, and clearing a value prompts — `""` and absent are different things and
`[ -z ]` / `[ -v ]` disagree exactly there.

Writes **`Project.env` in `projects.json`**, never the repo's `.claude/settings.json`. That file
has a writer one tab to the left; one writer per file. The repo's own `env` renders as a
read-only *Inherited* block, and only when it actually has one.

## S3 — the resolver and the launch path

`src/renderer/lib/resolve-session-config.ts`, tests written first.

**Merge by NAME, last writer wins, origin recorded per row.** The design names this as the thing
most likely to be built wrong, so the first test is the one it warns about: a lane that sets one
variable leaves the project's other two untouched, with their origins intact.

Three things never reach the settings file, each for its own reason:
- **a tombstone**, because the file has no way to say "remove this name" — a key with any value
  is a key that gets set. Honoured in the pty env instead, which is the only place it can be;
- **a secret**, because the file is plaintext, on disk, written by us, and outlives the run;
- **a denied name**, as a backstop against a hand-edited `projects.json` or one written by an
  older build.

Resolved in `ipc.terminalSpawn` from the `projectId` both launch paths **already** stamp, so this
step adds no surface at all — which is where the design wanted the risk to sit. Only the project
layer exists; `Role.env` (S5) and the run layer (S6) are added as list elements, not as a shape
change. Everything fails soft: an unreadable store or an unmatched id means a lane launches
exactly as it did before this existed.

---

## Deviations and additions, stated

- **A per-skill control is withheld on plugin rows** (open question 1 above). Design change.
- **One Tauri stub.** `skillsCatalog` has no Rust command behind it, so `src/operator-bridge.ts`
  answers with an empty catalog carrying an explicit error, and the page says it couldn't read
  the roots — which is true there — rather than rendering an empty list claiming there are none.
- **Config env is set on the pty env as well as in the settings file.** The file is what Claude
  Code reads for its own subprocesses; the pty env is what the lane's *shell* sees, which is
  where a user checks with `env | grep`. Set before the terminal-capability block, so the names
  Operator manages still win.
- **`FolderPreferencesView` gained `project` / `onPatchProject`.** It only ever received a path,
  and Environment writes the Operator-side record. Matched by path in `DashboardView`, which is
  the canonical repo root `projects.json` keys on.

## Checks

| | |
|---|---|
| `tsc --noEmit` (root) | **0** |
| `tsc --noEmit -p electron/tsconfig.json` | **0** |
| `vitest run` (electron) | **287 passed, 20 files, 0 failed** (was 265) |
| `npm test` (root) | **800 passed / 33 failed** — the 33 unchanged from before this branch |

57 new tests: the resolver's per-row merge, tombstone-vs-empty, secret exclusion, shadow
recording; the denylist's two reasons and the `CLAUDE_*` near-miss; front-matter parsing with
colons and quotes; the plugin-id path reversal; the settings file's shape and its 600 mode.

The 33 root failures are the pre-existing jsdom-25-under-Node-26 breakage documented in
`dev/results/titlebar-drag.md` (`localStorage` undefined). Verified unchanged against a reverted
tree earlier this session.

## Not verified — needs the user

Every mechanism above is proven against the real CLI or unit-tested, but **no lane was launched
from the app**. Worth an eyeball:

1. Launch a lane; confirm `~/.operator/sessions/<id>/settings.json` exists and `tui` is still
   honoured, and that `/status` still shows your global model (i.e. the merge, in the app).
2. Add `NODE_ENV=staging` on a project's Environment tab, launch, run `printenv NODE_ENV`.
3. Open the Skills tab and confirm the three `framer-*` skills read as `off` without touching
   anything.

## Not built, and not by accident

Secrets (S7 — the only step that can leak, deliberately last), the Skills page's writes (S4), the
lane altitude (S5), and the launch sheet (S6). No launch sheet, no `⌥Launch`, no secret store.
