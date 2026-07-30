# Per-project environment variables (and the secrets question)

**User, 2026-07-28:** *"what about env variables? like a railway token for example, could i set that
in project settings?"*

**Deliverable: `dev/project-env-design.md` — the design, not the build.** Research confirms the
Claude Code side; Design settles the shape and the storage rule.

## Where things stand today

- **No support.** `Project` (`shared/types.ts`) has no `env` field; Folder Preferences has no env UI.
- **The injection point exists.** `src-tauri/src/lib.rs:748-758` already sets `OPERATOR_TERMINAL_ID`,
  `OPERATOR_DEV_PORT`, `PORT`, `FORCE_COLOR`, `TERM` on the `CommandBuilder` before spawn. Adding
  project vars is a few lines there. Note `strip_nested_session_env` (`:549`) runs alongside it —
  understand why before adding to that path.
- **Unknown settings keys already round-trip.** `ClaudeSettings` has `[key: string]: unknown`, so an
  `env` block hand-written into `.claude/settings.json` survives Operator's editor today, unshown.

## Research — confirm before anything is designed

1. **Does Claude Code natively read an `env` block from `settings.json`?** If it does, that is very
   likely the right carrier: it works whether a session is launched by Operator or by the user from
   a plain terminal, and it inherits Claude Code's existing scope precedence. Confirm the exact key,
   semantics, and which settings scopes honour it. Do not assume — check.
2. **How do the scopes differ for this?** `SettingsFileScope` already models `project` (shared,
   committed) vs `project-local` (gitignored). That distinction is the whole ballgame for secrets.
3. Whether env values reach subagents and spawned tools, since that determines the blast radius.

## The design question — two tiers, not one

**Config and secrets are not the same feature and must not share a storage rule.**

- **Non-secret config** (`NODE_ENV`, `API_BASE_URL`, a region): plaintext is fine. Project settings,
  visible, editable, shown in full.
- **Secrets** (a Railway token, an API key): must never land in a file that can be committed.
  `~/.operator/projects.json` is the wrong home — it is plaintext on disk and this project routinely
  dumps it for debugging. `.claude/settings.json` is worse: it is the *shared* one and lands in git.

Constraints that should shape the answer:

- **A token in a pty is visible to everything the agent runs**, and to anything that prints its
  environment. This is not a UI concern that a masked input solves.
- **It can reach the transcript.** If a command echoes the environment, the value flows through
  `transcript.rs` into `chat.db` and onto the chat surface — durably. Consider whether known secret
  values should be redacted on the way through, and note that redaction-by-value is a real approach
  with real limits.
- **macOS Keychain is the correct store for a credential.** A plausible shape: the project holds the
  variable *name* and a reference; the value lives in Keychain and is resolved at spawn. Design
  should judge whether that complexity is warranted now or whether the honest v1 is "config only,
  secrets explicitly out of scope, and say so in the UI."
- **Never render a secret value back to the screen**, and never log it.

An honest, small, correct v1 beats a broad one that quietly encourages putting a live token in a
committed file. If the answer is "config now, secrets later", say that plainly and make the UI say
it too.

## Also worth settling

Whether these are **project-scoped only**, or whether a lane/role can add its own — the roster
already pins model, effort and worktree per lane, so per-lane env is a natural question. Do not
build it; just say whether the data model should leave room for it.
