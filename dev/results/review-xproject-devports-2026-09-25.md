# Review: `operator/d91080-xproject` and `operator/d91080-dev-ports` (2026-09-25)

Both branches were cut from `operator/d91080` at `58c402a`. Line numbers are on each branch's tip:
`4b14707` (xproject) and `4c3cb98` (dev-ports). Nothing in the main checkout was changed.

## Checks run

Everything below was run in scratch `git archive` exports and a scratch clone, with the main checkout's
`node_modules` symlinked in.

| Tree | Root `tsc` | electron typecheck | Electron suite | Renderer suite |
|---|---|---|---|---|
| `d91080-xproject` | exit 0 | exit 0 | 42 files, 770 passed | 97 files, 1437 passed |
| `d91080-dev-ports` | exit 0 | exit 0 | 44 files, 775 passed | 96 files, 1420 passed |
| `d91080` + `57440` + `xproject` + `dev-ports`, merged in that order | exit 0 | exit 0 | 44 files, **783 passed** | 99 files, **1452 passed** |

**The three merges are clean.** Only `DashboardView.tsx` and `terminal-options.ts` needed an
automatic merge.

---

## A. `operator/d91080-xproject` (X1–X6)

### A1. Medium — the bus-name prefix rule still reaches sibling projects on this machine

- **Where:**
  - `src/renderer/lib/bus-name.ts`: `projectSlug`, `laneBusName`;
  - `src/renderer/lib/roster.ts`: `busNote`, which says "a name from ListAgents that starts with
    `${prefix}-`".
- **What:**
  - A lane name is `<slug>-<role>`, and `-` is also the character `slugify` puts between words.
  - `projectSlug` adds a hash only when two slugs are *equal*. It does not add one when one slug is a
    prefix of another followed by `-`.
  - The projects on this machine (`~/.operator/projects.json`) include three such pairs:
    - `mantel` and `mantel-landing`;
    - `operator` and `Operator-landing` (slug `operator-landing`);
    - `fastrack` and `Fastrack-landing`.
  - So `mantel-landing-code` starts with `mantel-`. A mantel lane that follows its own note ("send only
    to a name that starts with `mantel-`") is told that mantel-landing's lanes are its own project.
    That is the X1 hole this branch closes, left open for exactly these projects.
- **Failure scenario:** a mantel Code lane wants Design. `ListAgents` shows `mantel-design` and
  `mantel-landing-design`. Both pass the rule as written, and the lane picks either.
- **Fix:** use a separator no slug can contain. `slugify` collapses every run of non-alphanumerics into a
  single `-`, so `--` never occurs inside a slug. `mantel--code` against `mantel-landing--code` is then
  unambiguous, and the note can say "starts with `mantel--`". Alternatively, drop the prefix rule and
  put the exact sibling names in the note, which Operator knows from the roster.

### A2. Low–medium — a project's slug changes when another project's name starts or stops clashing with it

- **Where:** `bus-name.ts` `projectSlug`.
- **What:** the hash is added when *another* project slugs the same, and removed when that project goes
  away.
- **Failure scenario:**
  1. The user adds a second project named "Mantel".
  2. Lanes of the existing `mantel` project launched from then on are named `mantel-1a2b-*`, while
     running lanes keep `mantel-*` and a note that says `mantel-`.
  3. The new project's lanes are `mantel-3c4d-*`, which also start with `mantel-`.

  So the old note admits the new project's lanes.
- **Fix:** always include the short hash, or record a project's slug once, at first use, and never change it.

### A3. Low — duplicate bus names for a fan-out's extra sessions

- **What:**
  - The launch path numbers instances (`count > 1 ? i + 1 : 1`).
  - The restore path (`DashboardView`, `laneBusName(namedProject, saved.roleId, …)`) and the CLI-update
    restart (`sessionName: laneBusName(project, tab.roleId, …)`) always use instance 1.
  - A restored or restarted second session of a lane is therefore named like the first.
  - `ListAgents` shows duplicates with a `[ref]`, so nothing is misdelivered, but "send exactly as
    listed" becomes ambiguous.
- **Not verified:** whether `--name` given together with `--resume` replaces the name a resumed session
  already has. The installed 2.1.283 help only says "Set a display name for this session (shown in the
  prompt box, /resume picker, and terminal title)".

### A4. Low (latent) — reports addressed `to_role = 'operator'` never reach a coordinator whose id is `orchestrator`

- **Where:** `electron/src/main/mcp-serve.ts` (the report tool), `chat-store.ts` `undeliveredFor`.
- **What:** every non-coordinator report is now stored with `to_role 'operator'`. The queue query matches
  `to_role = <coordinator's role> OR to_role IS NULL`, and the announce loop passes the tab's own role.
  `COORDINATOR_ROLE_IDS` still includes `'orchestrator'`, and a coordinator tab with that id would never
  be told of its project's reports, which is a legitimate same-project message dropped.
- **On this machine:** there are none (0 in `projects.json` rosters, 0 in `sessions.json`), so it is latent.
- **Fix:** leave `to_role` null, or query with every coordinator id.

### A5. Low — routing compares directories as strings

- **Where:** `src/renderer/lib/dispatch.ts` `tabRunsIn` / `within`.
- **What:**
  - A tab counts as the project's lane only if its `cwd` or `sourceCwd` is lexically inside
    `project.path`.
  - Tabs launched in this run use the same string (`sourceCwd: cwd` at launch), so the normal case works.
  - If the project's path is edited or moved while its lanes run, or differs by case or a symlink, those
    lanes stop matching. A dispatch is then queued instead of sent, and `handleLaunchRole`'s reuse check
    (`pickLaneTab`) misses the running lane and launches a second one.
- **Fix:** compare `realpath` forms, or fall back to the project label when the path is unknown or
  moved. Worth a test with a moved path.

### A6. Low — lanes from older builds now file unstamped reports and dispatches

- **Where:** `electron/src/main/mcp-serve.ts` `callerFromSessions`.
- **What:** a row now counts only if it is corroborated by `CLAUDE_CODE_SESSION_ID` or by the directory.
  This matters only for lanes whose environment lacks `OPERATOR_PROJECT_ID`/`OPERATOR_ROLE_ID`, that is,
  lanes launched by an older build. If neither corroborates:
  - their reports go in unstamped (still visible, since `project_id IS NULL` rows are announced);
  - their bus dispatches are refused with "no project".

  That is the intended trade-off: a missing stamp is better than a wrong one.
- **Not verified:** I did not check that Claude Code exports `CLAUDE_CODE_SESSION_ID` to its MCP
  server's environment. The directory fallback covers most lanes.

### A7. Nit — the X2 change has no effect

`laneKey(projectId, roleId, ownId)` builds the new unscoped key only in the human-submit reset
(`DashboardView.tsx`, `onHumanSubmit`). Every *counting* call passes a project: `dispatch-bus.ts:174-175`,
and `DashboardView.tsx` at the reply path and launch resets. So no unscoped budget is ever charged or
reset. It is harmless. It also means the problem X2 describes, several unstamped tabs sharing one budget,
does not happen on the send side today.

### Checked and clean

- **X3.** `undeliveredFor` and `expireUndelivered` return nothing without a project (`chat-store.ts`).
  The IPC logs that once per role, and `project_id IS NULL` rows are still announced to every project,
  so an unstamped report is not lost.
- **X5.** `dispatchSender` takes project and role from the request, and the tab only fills gaps when it
  does not contradict them. `deliverDispatchRef`'s `srcTab` is dropped when it is stamped with another
  project.
- **X6.** `pickLaneTab(…, projectPath)` covers both lane kinds:
  - worktree lanes match through `sourceCwd`, which is the launch cwd, that is the project path;
  - main-checkout lanes match through `cwd`;
  - a tab with neither keeps today's behaviour.
- **Odd characters.** `slugify` applies NFKD and keeps `[a-z0-9]` runs. A name made only of non-Latin
  characters becomes `project`, and two such projects get hashes.
- **`--name` exists on the installed CLI** (2.1.283 help: `-n, --name <name>  Set a display name for this
  session`). It takes a required value, so it cannot swallow the prompt.

**Verdict A: not merge-ready as the X1 fix, because of A1.** On this machine it leaves three project
pairs open to exactly the cross-project send it closes, and the lane note points agents at the ambiguous
rule. The fix is small: a `--` separator, or exact sibling names in the note. The rest is Low and can
follow.

---

## B. `operator/d91080-dev-ports`

**The installed app's windows are unchanged.**
- `INSTALLED_RANGES` is dev servers 1420–1520 and CDP 9340–9440 (`port-ranges.ts:24`).
- `PORT_BASE`/`PORT_MAX` (`port-alloc.ts:35-36`) and `CDP_PORT_BASE`/`CDP_PORT_MAX`
  (`preview-cdp-port.ts:17-18`) are derived from it.
- The installed app gets them only when packaged **and** on the default `~/.operator` (`isDevInstance`).
  The test asserts all three cases. It deletes `OPERATOR_DIR` only for a read, and nothing is written.

**Nothing hardcoded remains.** `git grep` for 1420, 1520, 9340, 9440 and 1450 across `electron/src`,
`src` and `electron/scripts`, excluding tests and `port-ranges.ts`, finds nothing. Every allocator reads
`activePortRanges()` at allocation time: the lane-port scan and its empty-scan retry (`deps.range`), and
the CDP allocator (`allocateCdpPort(…, cdp.base, cdp.max)`). The app's own CDP opt-in (`index.ts:400`)
still reads `OPERATOR_CDP_PORT` from its parent, which is correct: the parent allocated it.

**The bind-test race is not made worse.**
- The bind probe is still check-then-release. The port is not held until the lane's server binds.
- Within one instance, `allocGate` serialises allocations. The lease file and `portsByCwd` cover ports
  handed out but not yet bound.
- The race the result file describes, a dev instance handing out :1422 while the installed app held a
  lease on it, is gone: the windows no longer overlap (`rangesOverlap` is tested). A dev instance cannot
  pick a number the installed app might have leased, whatever the lease files say.
- Unrelated processes can still take a port between the probe and the bind. That is unchanged and
  outside Operator's reach.

### B1. Low — `npm run dev` ignores the lane's reserved port and always defaults to 1610

- **Where:** `electron/scripts/dev.mjs`, `electron/vite.config.ts` (`strictPort: true`).
- **What:** the renderer port is `OPERATOR_ELECTRON_PORT || 1610`. A lane running `npm run dev` has
  `OPERATOR_DEV_PORT` set to a leased port, but this does not use it. It also does not probe 1610.
- **Failure scenario:** Code and QA each start a dev instance. The second one fails, because 1610 is
  taken and `strictPort` is set.
- **Fix:** use `OPERATOR_ELECTRON_PORT`, then `OPERATOR_DEV_PORT`, then 1610.

**Verdict B: merge-ready.** B1 can follow.

---

## One line each

- **xproject:** not merge-ready; A1's `<slug>-<role>` prefix rule admits `mantel-landing-*` as "mantel"
  (and the same for operator/Operator-landing and fastrack/Fastrack-landing on this machine). Use a `--`
  separator or exact sibling names. Everything else is Low. Tests 770 + 1437 pass.
- **dev-ports:** merge-ready; installed windows unchanged, nothing hardcoded left, no new race. Tests
  775 + 1420 pass.
- **Together with 57440:** merges cleanly; 783 + 1452 pass.

---

## Re-check of `operator/d91080-xproject` after fixes (4489e61, 5b93b93, b6c7ae6; result d6e35f3), 2026-09-25

**Checks.** On a scratch `git archive` export of `d6e35f3`:
- root `tsc` exit 0, electron typecheck exit 0;
- electron 42 files, **771 passed**; renderer 97 files, **1443 passed**.

Merged onto `operator/d91080` in a scratch clone with `operator/57440`, this branch and
`operator/d91080-dev-ports`, in that order:
- 0 conflicts;
- root `tsc` exit 0, electron typecheck exit 0;
- electron **786/786**, renderer **1458/1458**.

**A1 is closed.** I ran every project in `~/.operator/projects.json` through the branch's `projectSlug`
and `laneBusName` (script run against the exported `bus-name.ts`):
- The 17 projects give 17 distinct slugs, and none contains `--`. For example `mantel-2794`,
  `mantel-landing-92a9`, `operator-78f2`, `operator-landing-3240`, `fastrack-bec5`,
  `fastrack-landing-fc4b`, `fasttrack-f9dc`.
- `sameProject(laneBusName(<-landing project>, 'code'), projectSlug(<base project>))` is **false** for all
  three pairs: mantel/mantel-landing, operator/Operator-landing and fastrack/Fastrack-landing. The same
  call with the project's own lane name is true.
- **`slugify` cannot emit `--`.** Every run of non-`[a-z0-9]` characters becomes one `-`, and leading
  and trailing dashes are trimmed. Checked on `a--b`, `--x--`, `x---y`, `a_-_b`, `日本語` (becomes `x`)
  and `ℌello`.
- **Roles with dashes parse correctly.** `parseBusName('mantel-3f1a--design-review')` gives role
  `design-review`. `…--code--2` gives instance 2. A name with a non-numeric third part, with four parts,
  or a derived `mantel-2b` gives `null`. A bus suffix like `…--code-2` stays in the role, and the slug
  still matches.
- **No prefix matching is left.** `busNote` now says "whose part before the first `--` is exactly
  `<slug>`… Never match a session by prefix". `sameProject` compares for equality, and nothing else
  matches names.
- As before, this rule is **advisory**: nothing in Operator enforces it (`sameProject`/`parseBusName`
  are used only by tests). A lane can still `SendMessage` any name, as the code itself notes.

**A2 is fixed.** The slug is `<name slug>-<4 hex of the project id>` and depends only on that project,
so adding or removing another project no longer renames it. Renaming the project itself still changes
the name part: running lanes keep the old slug in their note until restarted. They then fail to find
new lanes by name rather than finding another project's. Low.

**A3 is partly fixed.**
- The CLI-update restart now keeps the instance (`tab.fanIndex`, `DashboardView.tsx` restart path).
- The **restore** path still names every restored session as instance 1, because `SavedSession` does
  not persist `fanIndex`. A restored fan-out therefore gets duplicate names, which `ListAgents` shows
  with a `[ref]`. Low, and it can follow.

**A4 is fixed.** `undeliveredFor` and `expireUndelivered` accept every coordinator id as the addressee
(`addresseesOf`, `chat-store.ts`). A lane report addressed to `operator` now also reaches a coordinator
keyed `orchestrator`. Non-coordinator roles are unchanged.

**A5 is fixed.** `tabRunsIn` refuses a tab only when its directory, or a worktree lane's source repo,
lies inside **another** project's path and that path is the most specific match. The comparison
ignores case and trailing slashes.
- A tab whose directory matches no project is kept by its label. That covers a project whose path was
  edited or moved while its lanes run, so the reuse check no longer launches a duplicate lane.
- Nested project paths resolve to the innermost project.
- Every call site passes the other projects' paths: bus dispatch, typed dispatch, the approval preview
  and `handleLaunchRole`.

**Anything new:** nothing blocking. Nit: `slugify` turns combining marks into dashes, so `Ünïcødé` gives
`u-ni-c-de`. Stripping marks (`\p{M}`) after NFKD would read better. It is harmless, since it never
produces `--`.

**Verdict: `operator/d91080-xproject` is merge-ready.** It merges cleanly with `d91080-dev-ports` and
`57440`, and the combined tree passes. Left for later: A3 on the restore path, and the slugify nit.
