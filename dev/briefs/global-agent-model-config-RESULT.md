# RESULT — global per-role defaults

"From now on, Operator uses Opus" is now one click on **Agents → Defaults**, and it reaches every
project — including the 19 whose stored rosters said `fable`.

---

## The cascade

`src/renderer/lib/model-config.ts`, `resolveAgentConfig(role, globals, projectDefaults)`. **First
defined wins, evaluated per field:**

1. the lane's own pin (`Role.model` / `.effort` / `.permissionMode` / `.useWorktree`)
2. the **global** role default (`~/.operator/role-defaults.json`)
3. the project's saved `defaults` (effort / permission mode — it has no per-role model)
4. the built-in `rolePresets()`
5. `HARD_FALLBACK` (`sonnet` / `high` / `default` / no worktree)

Per **field**, not per source: a lane pinning only `effort` still inherits the global model. `''`
counts as not-set for strings, because `Project.defaults` really does store `model: ''`.

**`Role.model` is now optional**, and that is the load-bearing change. Required meant every seeded
entry was indistinguishable from a pin. Making it optional let tsc point at all three readers, which
is how I know none were missed.

### useWorktree — the tri-state

`false` is a choice, not an absence, so it gets `setBool` (only `undefined` is unset) rather than the
generic check. An explicit `false` **beats a global `true`**; its own test says so. Origins report it
as `pinned`, not as a fall-through.

The lane control was `onPatch({ useWorktree: !role.useWorktree })` — one click pinned a lane forever
with no route back. It now cycles **inherit → on → off → inherit**, and the three states look
different: pinned-on is a filled swatch in the lane accent, pinned-off a solid empty box, inherited a
**dashed** box filled only if the inherited value is on.

## Both launch paths — and the fourth answer I removed

There is exactly **one** caller of the spawn primitive (`handleLaunchSession`), and it is
`handleLaunchRole`. The brief's "second launch path" is that primitive's own internals, so routing
`handleLaunchRole` through the resolver covers both. It reads the defaults through a **ref**, because
a dispatch-triggered launch comes from a mount-once subscription and must use the current config.

**`roleLaunchSettings` (lib/roster) is gone**, folded into `resolveAgentConfig` — it was a second
place answering the same question, and its cases moved to `model-config.test.ts` intact.

**One path deliberately bypasses the resolver: session RESTORE** (`handleRestoreSession`), which
reuses `saved.model`. Resuming a conversation is not a new launch, and swapping a model mid-thread is
a different act from configuring one. Flagging it because it means an existing session keeps its old
model until it is closed and relaunched — "future launches only" is literally true.

## Reconciling the seeded values — the real numbers

Measured against your actual `~/.operator/projects.json`: **19 projects, 78 role entries, 0 custom
lanes.**

| field | cleared to inherit | left pinned |
|---|---|---|
| `model` | **72** | **6** |
| `effort` | **77** | **1** |

The 6 pinned models are `operator → opus` ×5 (operator, Operator-landing, uwazi_app, mantel,
mantel-landing) and `code → fable` ×1 (web27). The one pinned effort is `research → normal`.

**You had already been doing this by hand, five times.** That is the feature's justification, and
those five stay pinned — correctly, since they were deliberate. After setting the global they become
redundant; "Reset all lanes to inherit" is how you retire them.

The migration is content-sniffing, runs on hydrate, is **idempotent by construction** (it returns the
same object reference when there's nothing to do, so the second run is free), and **backs up
`projects.json` first — a failed backup aborts the rewrite** rather than proceeding. It is a no-op
today by design: clearing a field equal to its preset leaves the cascade landing on the same value.
There is a test that asserts exactly that, for all six presets.

## The tab

`AgentsHubView` → **Fleet · Defaults · Subagent library**. One row per role: name, **model**,
**effort**, **worktree** — model and effort at equal weight, neither behind a disclosure, because
effort is the other spend dial and the one people forget. Options carry a capability word
(`fast coordination`, `hardest work`, `breadth, volume`, `quick, cheap turns`) in title text.

**No cost figure anywhere** — not in a tooltip, not a $/Mtok hint, not a projection.

Clicking your own choice again clears it back to the built-in preset. The same gesture clears a pin
on a roster card, so it's learned once.

**Worktree defaults I seeded** (judgement call, per the brief — visible and overridable in one
place): `code` and `design` **on**; `operator`, `research`, `review`, `qa` **off**. Worktrees earn
their cost for lanes that write and get in the way for lanes that read and coordinate. Model and
effort are deliberately **not** seeded: `rolePresets()` is already a considered tiering, and copying
it into your file would turn every preset into a pin — the exact mistake the migration exists to undo.

## Showing what's inherited

Roster cards draw three distinct states, verified by measurement rather than by eye:

- **off** — `CONTROL_OFF`, no wash
- **inherited** — full `--fg`, no wash (selected, but you didn't choose it)
- **pinned** — lane accent + faint wash

My first pass had inherited-active in `--fg-muted`, which is `CONTROL_OFF` — **identical to
unselected**, so no value looked selected at all on an inherited lane. Caught by looking at it; fixed
before the theme pass ran.

## Two bugs found while building, both now fixed

1. **A pre-existing contrast collapse.** The worktree toggle and the model/effort segments drew their
   pinned state in the **raw** lane accent at 9.5px: **1.07–1.22:1** on the three light palettes.
   Now `laneTextColor` (which folds in each theme's `--lane-ink-blend`) → **5.21–6.87**. It predates
   this work; making worktrees a default is what put it in front of me.
2. **An unguarded worktree result aborted the launch.** `if ('error' in result)` **throws** when
   `result` is undefined, taking the whole session with it instead of falling back — and
   `worktreeRemove`'s `result.ok` did the same as an unhandled rejection on close. Both now degrade
   like a reported error. This was invisible until worktrees became the norm, which is the brief's
   own §0 warning arriving early.

## Filed, not fixed (per §0)

**`worktreeCreate` failing still launches in the project root anyway**, with only a `console.warn`. A
lane you believe is isolated silently is not — and with worktrees now a global default for `code` and
`design`, this path runs constantly. It deserves its own brief: at minimum a toast, and a decision on
whether an isolated-lane launch should fail loudly rather than quietly share the root.

## Verification

- `npm test` — **394 passed / 41 files** (was 362/39). `cargo test` — 102. `npm run build` — clean.
- **`model-config.test.ts`, 34 tests**: the cascade and its per-field independence; `''` and
  `undefined` both not-set; never `undefined` for a required field; the project-defaults
  permission-prompt regression; **the tri-state, including explicit-`false`-beats-global-`true`**;
  the migration's no-op-today property across all six presets, its idempotence *by reference*, that
  it never touches a custom lane or `useWorktree`; the explicit reset and its counts; store pruning
  that keeps a `false` worktree; the seed's shape and round-trip.
- **The user's story as a test**: global `operator → opus` → every project resolves to opus,
  *including* one whose stored role still says `fable` (asserted before **and** after the migration,
  so the test shows the crux rather than assuming it) — and a project that pinned `sonnet` keeps it.
- **`drive-roster.mjs` group 9 — end to end, all green:**

```
9 stored roster model after the seeded-field migration: [["operator",null],["research",null],["code",null],["design",null]]
9 the Defaults tab lists every lane: operator, research, code, review, design, qa
9 operator → Opus is now MY default: chosen
9 …persisted: {"code":{"useWorktree":true},"design":{"model":"haiku","useWorktree":true},"operator":{"model":"opus",…}}
9 the card names the RESOLVED model, never "(undefined)"
9 an inherited value is drawn differently from a pinned one: {"pinned":0,"inherited":8}
9 worktree shows THREE states, not two: ['inherit','inherit','on','inherit']
9 THE SPAWN CARRIES IT: ["haiku"]   ← the preset is opus and the roster pins nothing
```

  The last line is the whole feature: a global set from the rail **before any project was scoped**
  reaching `terminalSpawn`'s options for a lane in a project.
- **`drive-theme-pass` — 6 palettes, 0 below floor.** Defaults tab 3.73–15.13; roster inherited
  10.64–13.09, pinned 3.82–5.68, worktree 5.21–6.87. One probe of mine was wrong before it was
  right: it measured the 9px colour **swatch**, which has no text, and reported 1.00 as a defect.
- `drive-sidebar`, `drive-navigation`, `drive-project-rail`, `drive-dispatch-authority` — green.
- `drive-dashboard.mjs` fails, and **did before this work**: it is hardcoded to port 1429 and expects
  a pre-v0.10 UI ("Active sessions" title button). Stale driver, not a regression — worth deleting or
  rewriting in its own pass.

## Fixture changes

`dev/mock-bridge.ts` gained `worktreeCreate` and `worktreeRemove`, shape-exact with the real success
branches. They used to fall through the Proxy to `undefined`, which is what surfaced bug 2 — and the
moment worktrees became a global default, **every launch in the harness aborted**. Fixtures that are
merely absent are as misleading as fixtures that are too generous.
