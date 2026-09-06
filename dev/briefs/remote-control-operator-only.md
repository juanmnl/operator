# Brief: Remote Control only for each project's operator lane (Code lane) — 2026-09-05

Juan: since Claude Code changed Remote Control, the Claude phone app lists EVERY open lane. He
wants to remote-control only the operator of each project.

Verified against the installed binary (claude 2.1.261, `~/.local/share/claude/versions/2.1.261`),
not `--help`:
- Setting `remoteControlAtStartup` (boolean, "Start Remote Control bridge automatically each
  session") is resolved as: project/local settings `false` → off; else the first of
  policy → **flag** (`--settings` file) → user settings; else legacy global config; else the
  org default, which is currently auto-ON (`remote_control_auto_on_by_default`). Repo-scoped
  settings cannot turn it ON, but a `--settings` file CAN (scope "flag"). Nothing in
  `~/.claude/settings.json` sets it today, so every lane inherits the org default → all appear.
- `--remote-control [name]` on the interactive command names the session as shown on the phone;
  `CLAUDE_REMOTE_CONTROL_SESSION_NAME_PREFIX` sets the auto-name prefix (default hostname).

Change (Electron, electron/src/main):
1. `writeSessionSettings` (session-settings.ts, called from terminals.ts:145): add
   `remoteControlAtStartup: roleId === 'operator'` to every per-session settings file. Explicit
   `false` for non-operator roles is required, since unset means the org default.
2. For operator lanes, name the session so the phone reads the project: pass
   `--remote-control "<projectName> · operator"` in the argv built at terminals.ts:151 (verify it
   coexists with `--session-id` and `--settings`; if `--remote-control` changes the mode in a way
   that breaks the pty flow, fall back to the prefix env `CLAUDE_REMOTE_CONTROL_SESSION_NAME_PREFIX=<projectName>`
   and say so in the result).
3. Roster/per-role setting: add a per-role boolean `remoteControl` in role-defaults.json
   (default true for `operator`, false otherwise) so the choice is not hard-coded, surfaced in the
   role editor as one toggle "Remote Control". Keep it minimal.
4. Tests: session-settings emits the key per role; argv contains the name only for roles with
   remoteControl on. Mirror in src-tauri only if trivial.

Done: electron tests + tsc + build green; `dev/results/remote-control-operator-only.md`; call
`mcp__operator__report`. Commit on your branch; do not merge. Take this after the orphan reaper
— or before it if it is faster to slot in, your call; it is small.
