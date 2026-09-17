# Session env and worktree cleanup: gap audit (2026-09-16)

Read-only audit against `main` at the current worktree checkout (`operator-ff1740`,
commit `c463d90`). No code changed, no worktrees removed. Part B's classifier data below
is from a **standalone Python re-implementation** of `classify()`/`gatherFacts()` (the
actual TS could not be run directly — no `tsx`/`ts-node` in the repo, and Node's
`--experimental-strip-types` doesn't resolve extension-less relative imports) run against
the real `~/.operator/worktrees` directory, `worktree-provenance.json` and
`sessions.json`. One simplification: `dangerousRemovalReason` (the path-safety guard) was
**not** re-implemented — every row below assumes `guardReason: null`, which is accurate
for ordinary `<repo>-<hash>` worktree paths but not verified per-row.

---

## A. Session env → RAILWAY_TOKEN for mantel

**Bottom line: plaintext project env vars work end to end today. Secrets (S4–S7) do not exist — no code, no store, no UI.**

### What exists (config tier, S0–S3 — all real and wired)

- **Settings file, not inline JSON.** `electron/src/main/session-settings.ts:94-105`
  `writeSessionSettings()` writes `~/.operator/sessions/<id>/settings.json`, mode 600, and
  every currently-running session on this machine has one (verified: `sessions/*/settings.json`
  all contain `{"tui": "fullscreen", ...}`).
- **Environment tab, reachable in the UI.** `src/renderer/components/preferences/EnvironmentSection.tsx`
  is the `Environment` tab of `FolderPreferencesView` (`FolderPreferencesView.tsx:26,112-117`),
  which is reachable via `DashboardView.tsx:3357` (`setActiveFolderPrefs(...)` → `contentMode: 'folderPrefs'`,
  rendered at `DashboardView.tsx:4888-4903`). It's a real project settings surface, not dead code.
- **Denylist.** `src/renderer/lib/env-policy.ts` refuses `PORT`, `OPERATOR_*`, `TERM*`/`COLOR*`,
  `CLAUDECODE`/`CLAUDE_CODE_*`, with a reason (`operator-manages` vs `claude-ignores`) surfaced
  in the add-row UI (`EnvironmentSection.tsx:174-182`). `RAILWAY_TOKEN` is not on it — it would be accepted.
- **Storage.** A plain-value entry (`{name, value}`) is written to `~/.operator/projects.json`
  on the `Project.env` array via `onPatch` → `updateProject` (`DashboardView.tsx:4897-4900`).
  Verified: no project in the current `projects.json`, including mantel, has an `env` block
  yet — the feature is wired but unused.
- **Spawn → settings file → pty env, traced end to end:**
  1. `terminalSpawn` IPC handler calls `projectConfig(projectId)` (`electron/src/main/ipc.ts:69-99`),
     which runs the entry through `resolveEnv` → `envForSettingsFile` (denylist re-checked as a
     backstop) → passed into `d.terminals.spawn({ ...layers })` (`ipc.ts:124-146`).
  2. `TerminalManager.buildCommand` (`electron/src/main/terminals.ts:196-304`) writes the value
     into the session settings file (`terminals.ts:211-213`, so Claude Code's own subprocesses see
     it too) **and** into the pty's actual `env` object (`terminals.ts:294`: `for (const [k,v] of
     Object.entries(o.env ?? {})) env[k] = v`), before `ptySpawn(...)` at `terminals.ts:318`.
  3. Tombstones (`unset: true`) are honored the same way — `envNamesToUnset` deletes the key from
     the pty env at `terminals.ts:296`.
  - **This path is real for a plaintext value.** A `RAILWAY_TOKEN` set on the mantel project today,
    as a plain value, would reach every lane's shell (`env | grep RAILWAY_TOKEN` in the pty) and
    Claude Code's own env.

### What is missing (secrets, S4–S7 — none of it exists)

- **No secret store.** `~/.operator/secrets.json` does not exist on disk and no code
  references it — `grep -rl "secrets.json"` across `electron/src/main` and `src/renderer`
  returns nothing. The hub note's "S4–S7 pending" is accurate as of this build.
- **The type exists, the path to fill it does not.** `EnvEntry` (`src/shared/types.ts:271-276`)
  has a `{ name, secret }` variant, and `ResolvedEnvRow.secret` / `secretNames()`
  (`src/renderer/lib/resolve-session-config.ts:118-120`) exist to extract secret *names* from a
  resolved row — but `secretNames()` has **zero callers** anywhere in the codebase
  (`grep -rn "secretNames"` matches only its own definition and its `.test.ts`). Nothing ever
  resolves a secret name into a value.
  `envForSettingsFile` explicitly **drops** any `secret` row rather than writing it
  (`resolve-session-config.ts:102`), so even if a secret entry existed in `projects.json` it
  would silently vanish before reaching a lane.
- **No UI to create one.** `EnvironmentSection.tsx:118-120` only *renders* a `'secret' in entry`
  row (`from Operator secrets`) if one is already present — there is no "add as secret" toggle
  or button anywhere in the add-row form (`EnvironmentSection.tsx:155-183`), which only ever
  writes `{ name, value }`. A secret-typed entry cannot be created from the app at all today.
- **No IPC, no encryption, no keychain integration.** No handler in `ipc.ts` reads or writes a
  secret store; there's no macOS Keychain use anywhere in `electron/src/main`.

### What it means for the actual request

To set `RAILWAY_TOKEN` for mantel's sessions **today**, the only working path is the
Environment tab's plain-value row — which stores the token in cleartext in
`~/.operator/projects.json` on disk. That reaches every lane Operator launches for that
project (settings file + pty env), so it will work functionally. It is not what the secrets
tier was designed to be (a value that never touches a file Operator owns in plaintext), and
there is currently no lower-risk alternative built.

### Gaps, ranked

1. **No secret store at all** — `~/.operator/secrets.json` was never built. Everything downstream
   (S4–S7) has nothing to read from. *Biggest gap; blocks the "secret" promise entirely.*
   `resolve-session-config.ts:118-120` (dead code), `env-policy.ts` (no secret-specific denial).
2. **`secretNames()` is unwired** — even a hand-written secret record in `projects.json` would
   never resolve to a real value at spawn; `envForSettingsFile` drops it silently instead of
   erroring. `resolve-session-config.ts:96-107,118-120`; no caller in `electron/src/main/terminals.ts`.
3. **No UI affordance to create a secret entry** — `EnvironmentSection.tsx:155-183` (add-row form)
   only produces `{name, value}`. The read-only "from Operator secrets" row
   (`EnvironmentSection.tsx:118-120`) is unreachable UI for a state nothing can put it in.
4. **The only real path today writes tokens in cleartext to `projects.json`** — functionally
   works end to end (traced above), but is a plaintext-on-disk token, not a scoped secret.
   Worth flagging to the user explicitly before they use it for `RAILWAY_TOKEN`.

---

## B. Worktrees — `~/.operator/worktrees` cleanup

**Bottom line: the page is real and reachable, the classifier is dry-run-only by design
(`AUTO_REAP_ON_TRIGGERS = false`), and today it would reclaim only ~1.1 GB of the 16.5 GB
on disk — because most of the disk is stuck in `unattributed`, a class the UI has no way
to act on at all beyond looking at it.**

### Ground truth right now

- `~/.operator/worktrees`: **55 directories** (not 57 — `du` was run without excluding
  `.DS_Store`/`copa-run.log`, two non-directory files also at that root, which the real
  `readdir(..., withFileTypes).filter(isDirectory)` at `worktree-reap.ts:323` excludes), **16.49 GB**.
- `AUTO_REAP_ON_TRIGGERS = false` (`worktree-reap.ts:43`) — confirmed hardcoded off. Boot
  (`reconcileAtBoot`, `worktree-reap.ts:577-592`) and quit (`reapOnQuit`, `:599-610`) both compute
  and log the plan but pass `dryRun: !AUTO_REAP_ON_TRIGGERS` → always `true`. The **only** live
  `dryRun: false` caller in the app is the Settings button (`WorktreesSection.tsx:75`, commented
  "The ONLY `dryRun: false` in the app"). Confirmed by grep — no other call site.

### Is the page reachable?

Yes. `Settings → Worktrees` tab (`FolderPreferencesView.tsx:26,120-123`) renders
`WorktreesSection` (`src/renderer/components/preferences/WorktreesSection.tsx`), reachable
through the same `activeFolderPrefs`/`globalPrefsActive` navigation as the Environment tab
(`DashboardView.tsx:3357`, `4888-4913`). It's machine-wide (not per-project) by design — the
tab sits inside a project's prefs view but lists every worktree under `~/.operator/worktrees`
regardless of project (comment at `FolderPreferencesView.tsx:109-111`).

### Classifier output today (dry-run, re-implemented from `worktree-reap.ts:149-167`)

| class | dirs | size | auto? |
|---|---|---|---|
| `unattributed` | 34 | 13.82 GB | No — never auto |
| `merged-dirty` | 11 | 1.07 GB | **Yes** (after `commitAll`) |
| `live-claimed` | 5 | 1.14 GB | No — never touched |
| `dead-source-repo` | 4 | 0.46 GB | No — never auto |
| `debris` | 1 | ~0 GB | **Yes** |
| `merged-clean` | 0 | — | — |
| `unmerged` / `corrupt` | 0 | — | — |

Auto tier = `merged-dirty` + `debris` = **12 dirs, ~1.07 GB**. That's what the button on
the Settings page would remove today, dry-run confirmed nothing touched.

### Why the other 15.4 GB was never reclaimed

This is the real finding, and it's a data fact, not a code bug: **`worktree-provenance.json`
has 162 records, all dated 2026-08-11 or later** (checked directly). None of the 34
`unattributed` directories — `operator-63cc58`, `operator-808fe8`, every `el-encanto-*`,
`web27-*`, `mantel-landing-*` currently on disk except the six most recent, `Operator-landing-78e140`
— appear in it. They **predate provenance tracking** (built as part of this same reap
system). Per the classifier's stated policy (`worktree-reap.ts:14-22,146-148`: "the reaper
may only remove what Operator can PROVE it made"), a directory with no provenance record is
`unattributed` regardless of anything else true about it — and most of these are already
`registered=Y`, `merged=True`, i.e. **look exactly like the `merged-clean`/`merged-dirty`
directories that do get auto-removed**, except for the missing provenance record. That is
13.82 GB — 84% of the total — permanently stuck in a class the UI can only display, never act on.

The 4 `dead-source-repo` dirs (`uwazi_2026-*`, 0.46 GB) are a second, smaller case: their
source repo (`uwazi_2026`) no longer exists on disk at all, so no git command can ever
answer "is this merged" for them again — they're correctly excluded from the merge-based
classes but there's no path to reclaim them either, since `reap()` (`worktree-reap.ts:516-522`)
requires `entry.sourceRepo` for removal and `dead-source-repo`/`unattributed` aren't in the
auto tier in the first place.

The 5 `live-claimed` (1.14 GB) are correctly excluded — real open lanes (`mantel-3cdcc0`,
`mantel-d58cc0`, `mantel-e3e80`, `operator-ff1740` itself, `operator-db3d00`).

### What's missing for the user to actually clean this up

1. **No manual/bulk action on the `unattributed` tier at all** — `WorktreesSection.tsx` has
   exactly one action (`Remove N safe worktrees`, `:169-179`), scoped to `plan.auto`. There is no
   checkbox, no per-row delete, no "I vouch for this one" affordance for the other 43 dirs
   (`asks`) the page lists. This is the single largest gap — it blocks 15.4 GB / 93% of the
   reclaimable-looking space with no UI path forward, not even a manual one.
   `WorktreesSection.tsx:118-183` (list-and-one-button is the entire surface).
2. **No per-project grouping or filter** — the list is flat, ordered by class only
   (`CLASS_ORDER`, `WorktreesSection.tsx:16-20`); a user with 6 source repos represented (operator,
   el-encanto, web27, mantel, mantel-landing, uwazi_2026/uwazi_app) has no way to scope the view
   to "just mantel's worktrees" or sort/filter by source repo or size. `WorktreesSection.tsx:90-92`
   (`byClass`, class is the only grouping key).
3. **`unattributed` has no escape hatch even for a directory the user recognizes** — since
   provenance is the gate and there's no manual "attribute this to `<repo>`" action, a directory
   like `operator-63cc58` (4 GB, merged, dirty — very obviously safe by every other signal) can
   never move out of `unattributed` without either a code change (backfilling provenance for
   pre-2026-08-11 dirs) or a manual `rm -rf` outside the app. `worktree-reap.ts:161` (`if
   (!f.provenance) return 'unattributed'`) has no code path elsewhere that ever sets provenance
   retroactively for an existing directory.
4. **`dead-source-repo` (4 dirs, 0.46 GB) has no removal path either**, automatic or manual — same
   root cause as #1 (no per-row action), compounded by `reap()` requiring `entry.sourceRepo`,
   which by definition doesn't resolve to a repo that still exists for this class.
   `worktree-reap.ts:516-522`.
5. **Sizes require the boot/quit sweeps to explicitly opt in (`withSizes`) and cost a full `du`
   walk** (`worktree-reap.ts:238-256`) — not a UI gap, but worth noting the Settings page's own
   `reapPlan()` call incurs that cost every time the tab opens; fine at 55 dirs, would not scale
   silently at 10x.

---

## Summary — ranked gaps

**A. Session env (RAILWAY_TOKEN):**
1. No secret store exists (`~/.operator/secrets.json` absent) — `resolve-session-config.ts:118-120`
2. `secretNames()` unwired even if a secret record existed — no caller in `terminals.ts`
3. No UI to create a secret-typed entry — `EnvironmentSection.tsx:155-183`
4. Only working path today is a plaintext value in `projects.json` — functional, but not the
   secrets tier the user may be expecting

**B. Worktrees cleanup:**
1. No manual/bulk action on the 43-dir `asks` tier (blocks 15.4 GB, 93% of the disk) —
   `WorktreesSection.tsx:118-183`
2. No per-project or per-repo grouping/filter — `WorktreesSection.tsx:90-92`
3. No way to retroactively attribute an `unattributed` directory — `worktree-reap.ts:161`
4. `dead-source-repo` (4 dirs) has no removal path even conceptually —
   `worktree-reap.ts:516-522`
5. Per-tab `du` walk on every Settings visit — `worktree-reap.ts:238-256` (minor, notes scaling)
