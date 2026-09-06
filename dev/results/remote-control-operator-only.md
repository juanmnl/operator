# Result — Remote Control only for each project's operator lane (Code lane), 2026-09-05

Brief: `dev/briefs/remote-control-operator-only.md`. Branch: `operator/e78fc0`, rebased onto
`24283de`.

## Gates

| Gate | Result |
|---|---|
| `npm test` (renderer) | **1018 pass / 0 fail** (was 1008; +10) |
| `cd electron && npm test` | **450 pass / 0 fail** (was 446; +4) |
| root `tsc` + `npm run build` | clean |
| electron `typecheck` + `build` | clean |
| `cargo test` / `cargo build` | 183 pass / 0 fail, zero warnings |

## Verified against the installed binary, not `--help`

Per `feedback_verify_against_installed_binary` — the gap between the two *was* the effort-ladder
bug. Read out of `~/.local/share/claude/versions/2.1.261`:

**The resolution chain, decompiled verbatim:**

```js
t = projectSettings.remoteControlAtStartup;  r = localSettings.remoteControlAtStartup
if (t === false || r === false) return { value: false, source: "project_or_local_false" }
o = getSecuritySensitiveSettingWithSources("remoteControlAtStartup")[0]
d = legacyGlobalConfig.remoteControlAtStartup
p = o !== undefined ? {…} : d !== undefined ? {…} : { value: undefined, source: "none" }
// and: a repo-scoped `true` is logged as IGNORED — "repo-scoped settings cannot…"
```

with the source order `["policySettings","flagSettings","userSettings"]`. So a `--settings` file
is **`flagSettings`**: it outranks the user's own `~/.claude/settings.json`, and only an org policy
beats it. Everything the brief claimed holds.

**Empirically, not just by reading.** `--version` short-circuits before option validation, so it
proves nothing — the first probe I ran was worthless and I replaced it. Using `mcp list`, which
forces full option parsing and starts no session:

- `claude --remote-controlXX "x" mcp list` → `error: unknown option` (the control works)
- `claude --remote-control "Test · operator" mcp list` → parses, name binds, subcommand survives
- `claude --settings <file> --remote-control "Test · operator" mcp list` → coexists

**No fallback was needed.** The brief allowed retreating to
`CLAUDE_REMOTE_CONTROL_SESSION_NAME_PREFIX` if `--remote-control` disturbed the pty flow; it does
not. (For the record the binary also has `--remote-control-session-name-prefix <prefix>` as a
flag, not only as an env var.)

## What changed

**1. The settings key, written explicitly — including `false`.**
`SessionSettings` gains `remoteControlAtStartup`, and `buildSessionSettings` writes it whenever it
is defined. That is a deliberate exception to the rule the rest of that function follows: every
other key is dropped when it says nothing, because absent and empty mean the same thing to a
merge. Not this one. **Absent means "fall through", and what it falls through to is an org default
that is currently auto-ON** — which is exactly why the phone started listing every open lane.
`terminals.ts` passes `o.remoteControl ?? false`, so a non-operator lane gets a written `false`
rather than an inherited yes.

Actual output, from the real function:

```
operator lane : {"tui":"default","remoteControlAtStartup":true}
code lane     : {"tui":"default","remoteControlAtStartup":false}
```

**2. The name, in `buildArgs`.** `--remote-control "<project> · <role>"`, so the phone reads
`operator · Operator` rather than six identically-named sessions. It lives in `buildArgs` rather
than inline in `terminals.ts` because that is the argv builder and it is already unit-tested.

**One ordering hazard, and it is the reason this has its own test.** `--remote-control [name]`
takes an *optional* argument. If it were ever the last flag before the positional prompt, it would
swallow the prompt as its name — the lane would start with no instruction and the phone would list
it under the first line of a task. The flag is pushed immediately before the prompt and only ever
with a non-empty (trimmed) name, so the two are always separate tokens. A test asserts the
adjacency directly.

**3. The per-role setting.** `Role.remoteControl`, a tri-state like `useWorktree`: absent inherits
the preset, and the preset is `true` for `operator` and unset (→ `false`) for everyone else. It
resolves through `resolveAgentConfig` alongside `model`, `effort` and `useWorktree`, so nothing is
hard-coded to the string `'operator'` at launch.

> **Where the brief said `role-defaults.json`, this went on the roster instead.** That file's
> global tier was removed in the one-altitude collapse (`AgentsHubView.tsx:32` records it), so it
> no longer has a per-role layer to hold this. The roster preset is the only default layer left,
> which is where `useWorktree` already lives for the same reason.

Unlike `useWorktree` there is **no** rule overriding the pin: a coordinator you have deliberately
switched off stays off. `useWorktree` forces `false` for a coordinator on principle; Remote Control
is a preference, not an invariant.

**4. The toggle.** One `Segmented` "remote On/Off" in the role editor, beside the worktree control,
showing inherited-vs-pinned and clearable back to inherit — the same affordance, because it is the
same kind of choice.

**5. Resolution at launch.** `handleLaunchSession` resolves from the roster rather than trusting
the dialog, because a lane launched by a dispatch never passes through that dialog.

## Tests — 14 new

- **session-settings (4):** true is written; **false is written and the key is present in the
  serialised JSON**, not merely falsy; absent stays absent so a merge stays minimal; the other keys
  are undisturbed.
- **launch-args (5):** the flag appears with a name and not without one; empty and whitespace names
  add nothing; **the name precedes the prompt and the token after the flag is the name**; it
  coexists with `--session-id`/`--model`/`--effort`; a padded name is trimmed.
- **model-config (5):** on for the coordinator preset and off for all five others; explicit pins
  honoured both ways; **`false` is a pin and not an absence** (the tri-state — `.find(set)` would
  have skipped it and made "turn the coordinator off" silently do nothing); custom lanes fall back
  to off; the coordinator's `useWorktree` override does not bleed into this field.

**One existing test needed a change, and it is worth naming.** The migration invariant "NO LANE
CHANGES ITS EFFECTIVE CONFIG" compares `legacyResolve` against `resolveAgentConfig` across a matrix
of stores and rosters. `remoteControl` is now excluded from that one comparison — it did not exist
when the legacy cascade did, so there is no "before" for it to be unchanged from, and comparing it
would assert that a *new* feature changed nothing, which is backwards. Every field the migration is
actually about is still compared exactly.

## Not done

- Nothing merged. One commit on `operator/e78fc0`.
- **Tauri not mirrored.** The brief said "only if trivial" and it is not: the Tauri bridge has no
  `writeSessionSettings` equivalent (S0 was an Electron-only port), so there is no per-session
  settings file to put the key in. `buildArgs` is shared, so the *name* flag would ride along, but
  a name without the settings key is the wrong half — it would rename sessions while leaving every
  lane exposed. Left alone deliberately; Electron is the shipping shell.
- **No GUI verification, and here it is the actual proof.** Nothing was checked on a phone. What is
  proven: the exact JSON written per role, that the flag parses and coexists, and the resolution
  chain read out of the binary. What is not: that the Claude app then lists exactly one session per
  project under that name. That needs a launch and a look at the phone.
- Existing lanes keep whatever they launched with — the settings file is written at spawn, so this
  takes effect on the next launch of each lane, not on the ones running now.
