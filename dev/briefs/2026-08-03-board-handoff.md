# Handoff — v0.13.0, "the work, not the org chart"

**Written 2026-08-03. Read this before touching the board, the roster, or dispatch.**

---

## What shipped

**v0.13.0** — tag `abb4da0`, live on `operator-releases`, signed + notarized, auto-update
published. `main` is in sync. Build clean, **515 tests / 46 files**, 8 drivers green.

Net **−493 lines** across 66 files.

The change in one sentence: **Operator's primary object was the agent; it is now the work.**

| Move | What |
|---|---|
| 01 | Launching an agent takes a brief — one field, carried in as its opening message |
| 02 | The board is project home — `Backlog · Running · Waiting · Done`, card = task, agent = chip. Roster demoted to a **Team** tab |
| 03 | The project channel is deleted (~2,085 lines) |
| 04 | One diff renderer instead of three; `--add-fg`/`--del-fg` promoted to per-theme |
| 05 | Model/effort/worktree resolve at one altitude instead of three |

The six lanes (Operator · Research · Code · Review · Design · QA) kept their names, charters,
models and worktree posture throughout. We removed paperwork, not cast.

Origin: the four references on this project's moodboard
(`~/.operator/projects/operator-3cfdffb0/moodboard/`) all make the primary object a work item —
a task card, a thread, a task row, a PR — with the agent as a chip. Operator did the opposite.
Proposal: https://claude.ai/code/artifact/f519d1b9-cace-47f5-98da-70638d30a4a7

---

## Traps — the expensive things we learned. Do not re-derive these.

### 1. `OPERATOR-REPLY` is the delivery wire, not channel content
`onOrchestratorReply` in `DashboardView.tsx` is the **only** call site invoking `evaluateDelivery`
and `submitQueue.submit` for the agent→agent path. It pattern-matches as channel code. Deleting it
kills agent-to-agent delivery **silently** — no compile error, no failing test, just lanes that
stop hearing each other, with `chatterPaused`/hop-limit/pair-brake all becoming unreachable.

### 2. `resetChainFor` had exactly one caller
It was `sendChannelMessage`. A lane at `HOP_LIMIT` is barred from **sending as well as receiving**,
and `exhausted` has no timer — it clears only on a delivery that passed the budget check (which a
barred lane cannot produce) or a human message. Deleting the channel would have latched the brakes
**forever**: one runaway chain and that lane is mute until restart. It surfaced only as a
`declared but never read` warning — the kind you silence by deleting the import.

Now called from `dispatchToRole` and `sendProjectTask`'s idle-lane branch. **Any new human→lane
entry point must call it, and no test will notice if you forget.**

### 3. A typecheck is not a render
`landingFor()` returned `{kind:'channel'}` for any roster with 2+ lanes, so **the board was
unreachable from the app the whole time it "worked"**. Only driving the running app found it.
Now two variants: exactly one live lane → that session, everything else → the board.

### 4. Type-correct is not reality-correct
QA came back all-green twice; Review found real defects both times. QA verified fixtures matched
the **types**, Review verified they matched the **invariants**. A `DispatchRecord` with
`outcome: 'paused'` and no `replyId` typechecks and **cannot exist** — the delivery path writes
that outcome in one literal that always sets `replyId`. Three of the Waiting column's five
advertised outcomes were unreachable because of it.

**Corollary:** when a harness passes, ask what it would have to be fed to fail.

### 5. Drivers that only `console.log` are decoration
`drive-chatter-brakes.mjs` — the sole proof that delivery survived the deletion — printed `false`
and exited `0`. Three of eight drivers were broken by move 03 and nobody noticed for two moves,
**including one that was armed and would have said so**. Run the drivers after any move that
changes navigation.

### 6. A one-shot migration must stamp only after the durable write
`migrateGlobalsToLanePins` originally wrote its "done" stamp before the pins persisted. A crash in
that window would have left the stamp set, the pins unwritten, and every lane silently falling to
preset/fallback — **56 pins across 41 lanes** on the real store. The stamp now lands in the persist
effect after `localStorage.setItem`, and a failed read is left **unstamped** so it retries.

### 7. `permissionMode` belongs to the project, never to a preset
It is a trust decision about a repository and a moment, not a property of what kind of work a lane
does. Shipping `code: { permissionMode: 'auto' }` would auto-approve tool use for everyone who adds
a Code lane. Resolves `pin → project.defaults.permissionMode → HARD_FALLBACK`.

---

## Behaviour changes worth knowing

- **`resolveAgentConfig(role, projectDefaults?)`** takes a second argument again, for
  `permissionMode` only. Omitting it yields `'default'` — safe, not always right.
- **Deleting a lane no longer clears its tasks' `roleId`.** Anything assuming a task's `roleId`
  resolves against the current roster needs the `lost` branch. `TaskBoard` and `AssigneePicker`
  have it.
- **Broadcast replies are gone.** `REPLY_PROTOCOL` in `lib/roster.ts` now requires a specific lane
  id. `OPERATOR-REPLY [project]` was never delivered but *was* persisted, and the channel was its
  only reader — after the deletion it would write to storage and display nowhere. The early-return
  stays as a backstop for lanes running an older system prompt.
- **`DispatchLog` was kept, on Team.** The board excludes `replyId` records, so `DispatchLog` is
  now the **only** surface where a `hop-limit` or `pair-brake` is visible. Do not delete it without
  rehoming that.
- **`TaskQueue` was deleted.** Two writable surfaces over `project.tasks` can disagree.
- **`Send →` no longer navigates.** It shares `dispatchToRole` with `Start all`; both are board
  verbs, neither is a navigation. The agent chip still navigates — that is a different path
  (`onOpenLane` → `focusTerminal`).

---

## Open — nothing here is a blocker

1. **Nobody has used this build as a person.** Verified by build, tests and drivers only. The first
   real use is the owner's. Highest-value next action.
2. **`exhausted` survives a lane close+relaunch** (Review F2, knowingly not fixed). Typing directly
   into the pty also does not reset it. Neither has a natural hook: a *delivered agent message*
   lands as a `user` turn in the transcript too, so keying off that would disable the brake it
   exists to enforce.
3. **`--accent` as small text is under 4.5:1 on the light palettes** (2.1:1 on 1984-light) —
   `.actions-footer-btn.is-active` and others. `TaskBoard` routes accent ink through
   `laneTextColor` locally; a global fix should remove that local correction, the way move 04 did
   for the diff tokens.
4. **Two more `opacity`-on-`--fg-muted` stacks** at `styles.css:491` (`.imsg-time`, ×0.6) and
   `:577` (×0.8). Same defect class as the disabled-button fix, same shape.
5. **Requeue leaves `reconciledAt` set** — an abandoned task sent back to Backlog and completed for
   real is permanently stamped `⋯`/unconfirmed. Pre-existing; belongs to task lifecycle. The board
   promotes the wrong label from a collapsed section to project home, which is where it will
   finally get noticed.
6. **`Project.contextNotes` lost its in-project reading surface** (`ChannelPanel`'s About tab). The
   gallery card still shows it.
7. **`dev/drive-roster.mjs`** — the step-9 deletion was honest, but QA found it broken elsewhere.
   Fix or delete; a permanently red driver trains everyone to ignore the signal.

## Loose ends in git — need cleanup, I lacked permission

- Worktrees: `/tmp/op-merge-check`, `/tmp/op-integration`
- Branches: `tmp/merge-check`, `integration/simplify`, and the merged lane branches
  (`operator/bdd5c8`, `operator/ded278`, `operator/ded278-send`)

Also: several `claude` processes from older sessions were still alive during this work, holding
worktrees. Worth an audit. **Never pattern-kill them.**

---

## How this was run, and what to repeat

Five lanes, three waves, every brief naming an output file.

- **Briefs must live outside every worktree.** Idle lanes get a *fresh* worktree on launch, so a
  brief committed to a branch is invisible to all of them. These lived at
  `~/.operator/briefs/2026-08-01-simplify/` and were referenced by absolute path.
- **There is no return path from a lane.** Chat replies are invisible; only files are seen. Every
  brief named an output path and every lane wrote one.
- **Do not use per-pid `lsof` to map lanes to worktrees** — it fires a macOS TCC prompt per
  process. Read `sessions.json` for `roleId` → `cwd`, one `ps` for liveness.
- **Lanes must not push.** All worktrees share one `.git`; `main` reached GitHub two minutes after
  a local merge, before the owner had seen it. That is now a standing constraint in the shared
  context file.
- **Run Review and QA as separate lanes.** Merging them would have shipped a Waiting column that
  could render one card out of the five outcomes it advertised.
- **A reasoned "no" from a lane is worth more than compliance.** Design refused an instruction to
  put `unassigned` dispatches in Waiting, having checked that the handler already files the work as
  a Backlog task — the Waiting card would have been a duplicate with no affordance. They were right.

Every brief and every lane's RESULT file: `~/.operator/briefs/2026-08-01-simplify/`.
