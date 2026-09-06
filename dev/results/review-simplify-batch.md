# Review — `operator/e78fc0` (7 commits, `ae8e44c`..`03c41a8`)

Reviewed 2026-09-05 against `main` = `b229181`. Merge base is `24283de`; `main` has moved two
commits since (`3e7ccf7`, `b229181`), and a test merge of `main` into the branch is **clean** —
the eight `dev/briefs` and `dev/results` files that show as deletions in `git diff main..03c41a8`
are files added on `main` after the fork, not deletions the branch makes. They survive the merge.

Verified in a detached worktree at `03c41a8`:

- `npx tsc --noEmit` — clean.
- renderer suite — **1018 pass / 0 fail** (71 files). The Node 26 `localStorage` fix works; the
  33 "pre-existing" failures are gone and the suite is a real signal again.
- electron suite — **450 pass / 0 fail** (24 files).
- `cargo test` NOT run (a cold `target/` build in a scratch worktree); the Rust change is a
  mechanical mirror of the TypeScript one plus four new unit tests, but it is unverified here.

Line numbers are against `03c41a8`.

---

## 1 — HIGH · `sharedHolderIsOurs` does not prove what it claims, and the shared-cwd path re-creates the exact bug this branch exists to fix

`electron/src/main/terminals.ts:160-176`

```ts
const claimants = claimantsByPort(tagged).get(port) ?? []
...
const deep = ownDeepPids(ps, sibling.pty?.pid)
if (claimants.some((c) => deep.has(c.pid))) return true
```

`claimantsByPort` (`port-attribution.ts:116`) indexes **every tagged process carrying
`OPERATOR_DEV_PORT=<port>`** — not processes observed holding the port. Every descendant of a
lane's pty inherits that variable (`terminals.ts:284`), so the claimant list for a lane's
reserved port is that lane's whole subtree. `ownDeepPids` removes only the shell and the shell's
direct children. The `--mcp-serve` helper, every subagent, and every process a Bash tool call
starts sit at depth ≥ 2 and are therefore both claimants and members of `deep`.

So the predicate reduces to *"does the sibling lane currently have any grandchild process"*. It
never inspects the port.

**Failure scenario.** Lane t8 is open in `~/dev/app` with reservation 1425 and has not started a
dev server; it is running a build, so it has grandchildren. A stranger's `vite --port 1425
--strictPort` from an unrelated project takes 1425. Lane t9 launches in the same `~/dev/app`:
`allocatePort` (`port-alloc.ts:74`) sees `portsByCwd` already holds 1425, `isFree(1425)` is false
(the stranger holds it), `sharedHolderIsOurs(1425)` returns **true** on t8's grandchildren, and
t9 is handed 1425. Its system prompt (`terminals.ts:222-232`) now asserts:

> Operator verified the port was free when this session started, and only ever shares one with
> another session in this same directory, so if something is already answering on 1425 it is that
> server — reuse it rather than starting a second. Do not try to identify the process holding a
> port.

That is the 2026-09-05 failure with a stronger instruction attached, and the agent is explicitly
told not to check. This is worse than the pre-branch behaviour, which at least did not assert the
port had been verified.

The mirror image also misfires. `attributePort` guards this case with
`if ((input.reservationHolders ?? 1) > 1) return 'shared'` (`port-attribution.ts:93`) *before* the
`ownDeepPids` check — precisely because a shared reservation cannot distinguish lanes.
`sharedHolderIsOurs` has no equivalent guard.

**Second-order.** `ownDeepPids` walks `ppid`. A dev server that reparented to launchd — the leak
this whole branch is built around (`reap.ts:171-188`) — is *not* a descendant, so a sibling that
genuinely owns the port fails the check and the cwd is displaced onto a fresh port while the
sibling keeps serving. Wasteful rather than dangerous, but it means the predicate is unreliable in
both directions.

**Untested.** `port-alloc.test.ts:12,44,75` stubs `sharedHolderIsOurs` as `async () => true` /
`false`. The pure allocator is well covered; the inference that feeds it has no test at all.

---

## 2 — HIGH · Restoring a session never sets `remoteControl`, so the coordinator is explicitly switched OFF on every relaunch

`src/renderer/views/DashboardView.tsx:2678-2723` (`handleRestoreSession`)

The launch path resolves Remote Control (`DashboardView.tsx:2350-2354`). The **restore** path
builds its own `launchOptions` and never touches `remoteControl` or `remoteControlName`. In
`ipc.ts:133` the default is `o.remoteControl === true` → `false`, and `terminals.ts:202` then
writes `remoteControlAtStartup: false` into the session settings file unconditionally.

`session-settings.ts:73-79` documents that a `--settings` file is `flagSettings`, which outranks
the user's own `~/.claude/settings.json`. So this is not "inherit the default" — it is the
strongest available "off".

**Failure scenario.** The user launches the fleet, the operator lane appears on the phone. They
quit Operator and reopen it, or use "Resume project", or click a dormant session in the rail — all
three go through `handleRestoreSession`. The operator lane comes back with
`remoteControlAtStartup: false` and no `--remote-control <name>`, disappears from the phone, and
cannot be turned back on from `~/.claude/settings.json` because the flag settings win. The feature
works only on a lane's very first launch.

This is the brief's question 4 answered in the affirmative, and in the worse direction than
expected: not merely de-registered, but explicitly pinned off.

Same gap applies to `remoteControlName`, so even if the boolean were fixed, a restored coordinator
would show on the phone under whatever default name Claude Code picks rather than
`<project> · Operator`.

---

## 3 — HIGH · A session can wedge in `compacting` forever

`electron/src/main/transcript.ts:378-391`; `src-tauri/src/transcript.rs:481-495`

`compacting` is set by a `compact_boundary` record and cleared by exactly one thing: a
non-sidechain `assistant` record. Nothing else clears it — not a `user` record, not the end of the
turn, not the pty going quiet, not a timeout, and not the session ending. `clear()`
(`transcript.ts:181`) resets it, but a re-read replays the same file and re-sets it.

The tests only cover the auto-compaction shape (boundary → user re-prime → assistant), where an
assistant record is guaranteed to follow.

**Failure scenario.** The user types `/compact` at the end of a turn and walks away. Claude Code
writes the boundary and waits for the next prompt; no assistant record follows. The lane's phase
is now `compacting` indefinitely, and the pty-active override at `transcript.ts:598` deliberately
no longer replaces it. Consequences, all of which key on phase:

- `comms.ts:227` — `canAnnounceTo` requires `idle` or `waiting`, so the lane silently stops
  receiving dispatches and replies (there is an explicit test, `comms.test.ts:251`, asserting
  `compacting` is refused).
- `lane-lifecycle.ts:60` — `BUSY` includes `compacting`, so closing the lane is treated as
  interrupting work.
- `quit-guard.ts:51,60` — the lane counts as "still working" and the quit dialog blocks on it.
- `task-lifecycle.ts:131` — `finishedTurn` never fires, so an in-flight task never completes.

The `dirty` flag is set once at the boundary, so the phase is emitted and then stays. Recovery
requires the user to send a prompt into the lane, which is the one thing the comms path has just
stopped being able to do.

Suggested shape (not applied): clear `compacting` on any main-thread record that follows the
boundary and is not part of the re-prime, or bound it with a wall-clock ceiling.

---

## 4 — HIGH · The 10-minute sweep kills anything a closed lane started, with none of the boot sweep's corroborating gates

`electron/src/main/terminals.ts:644-672`; `electron/src/main/reap.ts:190-215` (`abandonedLaneRows`);
`electron/src/main/index.ts:197-206`

`staleTaggedRows` is documented as the *first of three gates* (`reap.ts:128-130`):
`reapOrphanedDevServers` additionally requires a stale lease naming the same terminal and port,
and requires that port to still be bound. `abandonedLaneRows` has **one** gate — `appPid` matches
and `terminalId` is not currently open — and `sweepAbandoned` applies no further filter before
`expandStrays` + `reapTree`. There is no command-shape check either: `DEV_SERVER_RE` exists in
`dev-servers.ts:56` for the manual list and is not consulted here.

Every process a lane ever started inherits `OPERATOR_TERMINAL_ID` and `OPERATOR_APP_PID`. So the
sweep's actual rule is: *SIGTERM (then SIGKILL) the process group of anything any closed lane of
this app run ever started, on a timer, with no UI and only a `console.error`.*

**Failure scenario.** An agent in lane t12 starts the app under test (`npm run tauri dev`, a second
Operator build, a `docker compose up`, an `ssh -L` tunnel, a `brew services`-style daemon). The
lane is closed, or its tab is removed after the pty died, or a close path threw. Ten minutes later
the sweep finds those processes carrying t12 + our `appPid`, expands them to their descendants,
and kills their groups. The user sees a background service disappear with no connection to
anything they did.

The specific case `reap.ts:107-118` warns about is reachable here in a new form: a second Operator
instance launched from inside a lane of the first inherits the first's `appPid` and that lane's
terminal id. `abandonedLaneRows` guards only `r.pid === selfPid` and `r.pgid === selfPgid`, neither
of which covers a *different* Operator process. Close that lane and the first instance kills the
second ten minutes later.

`dev-servers.ts:1-12` states the principle correctly — "show the user what is running… and kill
only what they confirm" — but applies it only to rows with no `appPid`. A tagged row gets no such
protection, and the automatic path is now the broader of the two.

Note the doc comment on `abandonedLaneRows` (`reap.ts:196-198`) claims it covers "the app being
force-quit and relaunched with servers still tagged to lane ids this run has never issued". It
does not: a relaunched app has a new pid, so those rows fail `r.appPid !== opts.appPid` and are the
boot sweep's job. Only the same-run case is actually handled.

**Not a defect, checked:** `reapTree(0, ...)` is safe. `descendantsOf` returns an empty set for
`rootPid <= 1` (`reap.ts:75`), `signal(rootPid, …)` is guarded on `rootPid > 1`, and `pgidsFor`
excludes pgid ≤ 1 and our own group. Nothing walks from launchd.

**Not a defect, checked:** `live-lane` is never killable without confirmation. `devServerKill` is
reachable only from `WorktreesSection.tsx`, which requires an explicit selection plus a second
confirm step and names the live-lane count in the confirm text. No timer path reaches it.

---

## 5 — MEDIUM-HIGH · The toolbar's `/model` and `/effort` writes bypass `submitQueue`, and the reasoning for that is inverted

`src/renderer/components/session/SessionToolbar.tsx:147-157`;
`src/renderer/lib/lane-tuning.ts:8-13`

The comment argues the queue must be bypassed because "that queue exists to keep a dispatch and a
human prompt from merging into one turn, and it pastes". Only the second half is a reason. The
queue's own header (`submit-queue.ts:1-16`) says it exists because concurrent writes into one pty
**merge into a single draft** — which is exactly what these writes now risk. What needed avoiding
was the bracketed-paste wrapper, not the serialization.

Three concrete failures:

1. **Interleaving with an in-flight dispatch.** `submitQueue` writes `ESC[200~ <text> ESC[201~ \r`
   and then a follow-up bare CR after a delay (`submit-queue.ts:76-81`). Clicking the effort chip
   during that window injects `/effort high\r` into the middle of the paste or between the paste
   and its CR. Result is one merged turn reading `…do the thing/effort high`, or a dispatch
   submitted early and truncated. The dispatch-splitting class of bug this queue was written for,
   from a new writer.

2. **A bare CR into a permission prompt.** Claude Code's permission dialog is a select list with
   "Yes" highlighted; a CR confirms it. `pickEffort`/`pickModel` write an unconditional `\r` with
   no check of the lane's phase or whether a prompt is up. Clicking Effort while a permission
   prompt is waiting can approve the pending tool call. Worth verifying against the TUI before
   deciding severity, but the write is unguarded either way.

3. **Mid-turn, the command silently does not apply while the UI says it did.** Per
   `project_queued_prompts_no_user_turn`, text typed into a mid-turn lane produces only a
   `queue-operation: enqueue` — it is stored as a queued *message*, not executed as a slash
   command. `pickEffort` nevertheless calls `setEffortLevel` and `onEffortChange`, which persists
   the new level onto the session tab. The chip and the stored session then both claim an effort
   the lane is not running at. This is the same failure shape as
   `project_effort_ladder_drift`: a setting that reports success and is silently dropped.

`normalizeModelId` itself is sound — it rejects control characters (so `sonnet\rrm -rf .` cannot
split) and all whitespace, and there is no shell in the path since this goes to a TUI slash
command. No injection found there.

---

## 6 — MEDIUM · The custom-model field commits a half-typed id to the pty on blur

`src/renderer/components/session/SessionToolbar.tsx:400` (`onBlur={commitCustomModel}`)

`commitCustomModel` sends whenever `normalizeModelId` returns non-null, which is any non-empty
string with no whitespace. There is no way to abandon the field except clearing it first.

**Failure scenario.** The user opens "Other…", types `opu`, then clicks the *Opus* item in the same
menu. The pointer-down is inside the panel so `useDismiss` does not fire, but focus moves to the
button and the input blurs: `commitCustomModel` runs, writes `/model opu\r` to the live pty, and
calls `setMenu(null)` — which unmounts the menu before the item's click handler runs. The user
picked Opus and the lane got `/model opu`, plus `onModelChange('opu')` persists `opu` onto the
session tab. Tab-out has the same effect.

---

## 7 — MEDIUM · The new toolbar chips are missing `data-popmenu-trigger`, so clicking a chip cannot close its own menu

`src/renderer/components/session/SessionToolbar.tsx:368-374, 409-416`

`useDismiss` treats a pointer-down as "outside" unless the target is inside the panel or matches
`[data-popmenu-trigger]` (`use-dismiss.ts:37-40`), and its own doc says the attribute exists "or
the toggle would close on the way down and reopen on the click". Every other trigger in the app
carries it (`ProjectGallery.tsx:497,1022`, `PlanMeter.tsx:110`). The two new chips do not.

**Failure scenario.** The menu is open. Pointer-down on the chip → `onDismiss` → `setMenu(null)`,
flushed synchronously for a discrete event. The subsequent `click` handler reads the fresh `menu`
(`null`) and sets it back to `'model'`. The menu reopens; the chip is a one-way control. Only an
outside click or Escape closes it.

Also missing `aria-expanded`, which `use-dismiss.ts:52` uses as its Escape focus-return fallback,
so Escape from these menus leaves focus on `body`.

---

## 8 — MEDIUM · "Dev servers" lists every process any lane started, not dev servers

`electron/src/main/dev-servers.ts:121-139`

The untagged branch requires `DEV_SERVER_RE`. The tagged branch deliberately does not — only
`NOT_A_SERVER_RE` (`--mcp-serve`, `Operator Helper`, `claude --settings`) is excluded. Every other
descendant of a live lane's pty carries the tag and is listed.

**Failure scenario.** Three lanes are running builds. The user opens Settings → Dev servers to
clear an orphan and sees rows for `node …/vitest`, `esbuild`, `tsc`, `rg`, `git`, each labelled
`live-lane` with the note "A lane is open and using this. Stopping it will break that lane's
preview." The note is wrong for all of them, the orphan is buried, and the checkbox next to a
`git` mid-rebase is a kill button.

The rationale given (a leaked `node server.mjs` matches no dev-server pattern) is real, but it
justifies relaxing the pattern for **abandoned** rows, not for `live-lane` ones.

---

## 9 — MEDIUM · A persisted `mainView` of `'chat'` or `'files'` leaves the main pane blank after upgrade

`src/renderer/views/DashboardView.tsx:146-148` (`loadLayouts`), `:251`

`loadLayouts` `JSON.parse`s `operator.sessionLayouts` with no validation, and `mainView` is read as
`activeLayout?.mainView ?? DEFAULT_LAYOUT.mainView` — a stale `'chat'` is truthy and survives.

**Failure scenario.** Any user who last left a session on Chat or Files upgrades to this build.
`paneVisibility` (`pane-visibility.ts:23`) returns `hidden` for anything but `'terminal'`, and
nothing renders for `'chat'`/`'files'`, so the session opens to an empty main area with neither
segment of the Console/Preview control marked active. Recoverable by clicking Console, but it is
the first thing they see. One line in `loadLayouts` coercing unknown values to the default fixes it.

---

## 10 — LOW-MEDIUM · Port allocation is serialized and expensive, on the launch path

`electron/src/main/terminals.ts:120-176`

`allocPort` serializes every allocation behind `allocGate`, and each one can cost a lease-file read
plus up to 101 × 2 `bind`/`close` pairs (`port-alloc.ts:98-103`), plus — on the shared path —
`snapshotPs()` **and** `sweepTagged()`, the latter being `ps -eww -E`, which dumps every process's
full environment. `port-attribution.ts:138` caches exactly this pair for 3s; `sharedHolderIsOurs`
bypasses that cache and takes fresh sweeps.

"Start all" on a six-lane project therefore runs six of these back to back, each blocking
`terminalSpawn`'s IPC reply, before any lane appears. Reusing `evidenceSnapshot` would remove most
of it.

---

## 11 — LOW-MEDIUM · `isPortFree` requires an `::1` bind, and failing it silently costs every lane its dev port

`electron/src/main/port-probe.ts:47-57`

`canBind('127.0.0.1') && canBind('::1')`. The comment argues IPv6 loopback is always present on
macOS. If it is not — IPv6 disabled on the interface, a restrictive network configuration — every
candidate fails, `scan` returns `undefined`, and `buildCommand`'s `if (devPort)` simply omits the
reservation and the system-prompt note. No error, no log, no UI: lanes just silently stop getting
dev ports and every agent picks its own. The previous Electron `allocPort` did no binding at all,
so this is a new failure mode for this build. A log line when the whole window scans empty would
make it diagnosable.

---

## 12 — LOW · `devServerKill` trusts renderer-supplied pids and re-expands a possibly recycled pid

`electron/src/main/ipc.ts:222-234`

The handler filters to `Number.isInteger(n) && n > 1` and checks the pid is present in a fresh `ps`
— which a recycled pid also is. It then expands to descendants and signals process **groups**. The
comment acknowledges recycling and says it "signals what it is handed", which is accurate but is
not a mitigation. No cross-check against the inventory the user actually saw (owner, command,
start time) is performed, so a pid that exited between listing and confirming can take an unrelated
process group with it. Cross-checking `ageSeconds`/command against the listed row would close it.

---

## 13 — LOW · `reportStillBound` names unrelated processes

`electron/src/main/terminals.ts:496`

``new RegExp(`\\b${port}\\b`).test(r.command)`` over the whole `ps` table matches any command line
containing the number: a pid argument, a timestamp, a numeric filename. The diagnostic will print
"port 1425 still bound after reap — pid N: …" for processes that have nothing to do with the port.
Log-only, but it is the log someone will chase a leak with.

---

## 14 — LOW · The chat store is now write-only

`electron/src/main/ipc.ts` (the `chatHistory` handler is removed); `src-tauri/src/chatstore.rs:200`
(`load` is now `#[cfg(test)]`)

The tailer still persists every narration entry into `~/.operator/chat.db`
(`index.ts:231`), and nothing in the app reads a session's history back any more. The file will
grow for the life of the install with no consumer. Not urgent; worth a purge policy or a decision
to stop writing.

---

## 15 — LOW · Two cosmetic inaccuracies on the kill list

`electron/src/main/dev-servers.ts:66-69, 74-87`

- `stripEnvDump` cuts at the first ` KEY=` token, so `node build.js --define PROD=1` displays as
  `node build.js --define`. On a list whose purpose is deciding what to kill, a truncated command
  is the wrong kind of missing.
- `projectPathOf` returns the bare `root` whenever the remainder contains no `/node_modules`, so
  several worktree rows can collapse to the same `~/.operator/worktrees` string and become
  indistinguishable in the `cwd` column.

---

## 16 — NIT · `launch-args.ts` comment contradicts the code beneath it

`src/renderer/lib/launch-args.ts:48-55`

"it must never be the last flag before the positional prompt below" — it *is* the last flag before
the positional prompt. The behaviour is fine (a name is always supplied, so the prompt stays a
separate token), but the sentence states the opposite of what the code does and will mislead the
next editor into "fixing" the placement.

---

## Areas checked and found clean

So silence here is not ambiguous:

- **Removal completeness.** No surviving references to Chat or Files in `src/renderer`,
  `src/shared`, `src/operator-bridge.ts` or `electron/src` outside historical `dev/briefs`
  documents. `SPEC` (`operator-api.ts`) drops `imageDataUrl`, `chatHistory`, `fileTree`,
  `fileRead`, `fileWatch`, `fileUnwatch`, `onFileChange` and adds the two dev-server methods; the
  Tauri bridge stubs match; the Rust commands (`image_data_url`, `chat_history`) are removed from
  the `invoke_handler` list. `MainView` and `PanelTab` unions are narrowed consistently, the ⌘J
  binding and both palette entries for Chat are gone, and the `@codemirror/*` + `@lezer/highlight`
  dependencies are dropped from `package.json`. The only leftover is item 9 (persisted state).
- **`reapTree(0, …)`.** Cannot walk from launchd; see the note under item 4.
- **`refuseStray` losing the `devPort` check.** The reasoning holds. `terminalId` + `appPid` do
  identify a lane uniquely within one app run (`nextId` is a monotonic per-run counter,
  `terminals.ts:106`), and `OPERATOR_DEV_PORT` is inherited from the pty rather than observed, so
  the check separated nothing it was written to separate. The residual risk is pid recycling giving
  a new Operator run the same `appPid` as a dead one; the old check would not have caught that
  either, since a stale row carries the same reservation.
- **`shouldReleaseCwdPort`.** Correct for every combination I traced, including displacement: the
  closing lane is already out of `this.terminals` at the call site (`terminals.ts:455-462`), a
  sibling on the same `(cwd, port)` holds the reservation, and a displaced cwd releases the fresh
  port and never the stale one. No leak of the reservation map.
- **The `allocGate` promise chain.** The class-field initializer runs before any method call, the
  `catch` prevents a failed allocation from wedging later launches, and the reservation is written
  inside the gate before the next scan reads `portsByCwd`. Two same-cwd launches correctly share.
  The remaining race is cross-instance: a second Operator can scan between our bind check and our
  lease claim. Narrow, and the shared lease file makes it self-correcting; not raised as a finding.
- **`normalizeModelId`.** Rejects `\x00-\x1f`, `\x7f` and all whitespace. No CR/LF can reach the
  pty from the free-typed field.
- **`buildSessionSettings`.** `remoteControlAtStartup` is the only key written when falsy, via an
  explicit `!== undefined` check, and the tests assert it survives a JSON round trip. Correct for
  the stated goal; the defect is upstream (item 2).
- **`devServerKill` confirmation.** No timer or automatic path reaches it (item 4's note).
- **Test-setup shim.** Guarded on `typeof globalThis.localStorage === 'undefined'`, aliases jsdom's
  own `Storage` instance so `vi.spyOn(Storage.prototype, …)` still lands, and the suite proves it:
  1018/1018 with the previously failing five files green. `sessionStorage` is genuinely unread by
  `src/`, so the aliasing is safe.

---

## Merge verdict

**Do not merge as-is.** The branch is well built — clean typecheck, 1468 green tests across two
suites, a genuine fix for the 33-failure blind spot, and a real orphan-reaper gap closed — but four
findings are behaviour regressions serious enough to block:

- **Item 2 (Remote Control off on every restore)** makes the headline feature of commit `03c41a8`
  work only on a lane's first launch. Smallest fix of the four: resolve `remoteControl` /
  `remoteControlName` in `handleRestoreSession` the same way the launch path does.
- **Item 1 (`sharedHolderIsOurs`)** ships a system-prompt assertion the code cannot back, and the
  outcome when it is wrong is the exact incident that motivated the change. Either make the
  predicate mean what it says or drop the assertion from the prompt and keep the old hedged
  wording.
- **Item 3 (stuck `compacting`)** converts a common user action (`/compact` at the end of a turn)
  into a lane that cannot be dispatched to, closed cleanly, or quit past.
- **Item 4 (unfiltered 10-minute sweep)** is the one with irreversible consequences. It needs
  either the boot sweep's corroborating gates, a command-shape filter, or demotion to the manual
  list `dev-servers.ts` was built for.

Items 5–7 are worth fixing in the same pass — they are all in code added by this branch, all
small, and item 5 puts unsequenced writes into a live pty. Items 8–16 can follow.

Commits `3f0caa9` (Node 26 test fix) and `ae8e44c` (Chat/Files removal) are independently sound and
could land on their own if the batch needs splitting.
