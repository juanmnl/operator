# Handoff — 2026-07-28

## ▶ STATE: v0.10.0 IS PUBLISHED — 0.10.1 is a known fast-follow

**v0.10.0 shipped 2026-07-29.** Tag `v0.10.0` at `2826f48`, `main` fast-forwarded, CI signed and
notarized, published to `operator-releases` with `latest.json`, `Operator.app.tar.gz` and
`Operator_0.10.0_aarch64.dmg`. Release notes applied (including a Known Issues section).

### ⚠ 0.10.1 — the reason it exists

**The ✕ on a lane card deletes the lane, not the session.** Reported by the user against the shipped
build and confirmed in `~/.operator/projects.json` (the `operator` project lost its `research` lane).
One click, no confirm, no undo: it wipes the lane's model/effort/accent/charter, unassigns its tasks,
and **leaves a running session orphaned**. Meanwhile *closing a session* has a click-again-to-confirm
guard — the more destructive control has the weaker one.

Compounded by a second defect: the only place to re-add a lane is the roster board on Project Home,
which is the navigation dead-end in `dev/briefs/back-to-project-view.md`. Together they read as
"gone forever". **Fixing either alone leaves a bad experience.**

Briefs: `dev/briefs/lane-delete-is-destructive.md`, `dev/briefs/back-to-project-view.md`.
User decision: *let 0.10.0 publish, fix in 0.10.1.* Documented in the shipped release notes so users
can avoid it meanwhile.

### Also for 0.10.1 / soon

- **Sidebar empty state** for a project with no lanes (roster-on-demand shipped; the empty state did
  not). Existing projects were deliberately NOT migrated, so they still show six seeded lanes.
- **Typewriter feed** — smooth upward scroll, in-flight, uncommitted.
  `dev/briefs/chat-typewriter-feed.md`. The real work is the stick-threshold race, not the animation.
- **The theme pass still has never completed** — see below. It shipped unverified.

---

## Historical: the pre-release state

- **Branch: `release/v0.10.0`** — **not `main`**. 9 commits, **unpushed**. `main` does not have them.
- **No `v0.10.0` tag exists.** CI has not run. Nothing is signed, notarized or published.
- Version bump is **complete and verified** across all five locations: `package.json`,
  `package-lock.json` (×2), `tauri.conf.json`, `Cargo.toml`, and the `operator` block in `Cargo.lock`.
- Gates: `tsc --noEmit` clean, **242 tests passing** (was 200 at session start).

### The decision waiting for you

The user said "go ahead" to tag+push while believing we were on `main` — because that is what I told
them, from the session-start snapshot, without re-checking. **Do not tag before settling this:**
merge `release/v0.10.0` → `main` and tag there, or tag the release branch deliberately. Ask.

### The other gate, unmet

**The theme pass has never completed.** "0 below floor across six palettes" is a stated gate
condition. `dev/drive-theme-pass.mjs` OOM-crashed WebKit on every attempt — 2 of 6 themes clean, then
crashes, eventually on theme 1 alone. Cause is environmental and measured: **~30 concurrent Claude
Code processes** on this host, 1.1–1.7GB free. Not a product defect (`tsc` clean, files quiet, fails
on the first theme). **Re-run it on a quiet host before tagging.** Two clean themes is weak positive
evidence, not the gate.

## The commit chain (bisectable — keep it that way)

```
2826f48  Release v0.10.0
86cc39e  Roster on demand (in-flight, another lane's work)
71cf17e  Gallery: reveal a project in Finder
07dff2d  Chat: liveness, interrupt, and tool calls as transcript blocks
f660dda  Toolbar and composer: fit the row, custom-model escape hatch
9525a28  PageShell: one page template + a guard for the muted-opacity rule
799ab47  Project-first navigation: a gallery, sidebar scoped to one project
f4da45e  Task lifecycle: stop `running` outliving the run that set it
6a345d6  Dispatch delivery: scale the watchdog nudge, let stop cancel it
```

`86cc39e` is another lane's in-flight work, committed only because `DashboardView` already imports
`presetFor` and handles a `create` dispatch kind, so it was not separable at file granularity. It was
isolated into its own commit and labelled rather than folded in silently. If the release regresses,
that is the first commit to look at.

## Uncommitted (none of it is in the release chain)

Documentation and harnesses — `dev/*.md`, `dev/briefs/` (21 briefs), QA rigs (`dev/qa-*`),
`scripts/visual/` — plus **in-flight typewriter-feed work** in `CanvasConversation.tsx`,
`dev/mock-bridge.ts` and `dev/drive-chat-feed.mjs`. Brief:
`dev/briefs/chat-typewriter-feed.md`. Not a release blocker.

## What shipped in this release

Project-first navigation (gallery → scoped sidebar), the `PageShell` settings template,
a substantially rebuilt chat view (measure cap, orb send/stop, liveness signal, interrupt,
tool calls as transcript blocks), task-lifecycle reconciliation, dispatch-delivery hardening,
roster-on-demand, and nine release blockers fixed.

## Still open — nothing here blocks the release

- **Structured-transcript UI** — parser and kinds landed; the block rendering is not built out.
  Brief: `dev/briefs/structured-transcript-build.md`. Open question inside it, unanswered: *where the
  boundary sits between the transcript and the Diff/Plan panels* if an edit block expands to show its
  own diff. Settle before building the edit block.
- **Renderer decision — text selection.** Research recommends **approach (a)**: a transparent DOM
  text layer positioned from the layout ops that already exist (the PDF.js pattern), scoped to prose
  only so the 80KB-table case is untouched. Costed as *medium, not a rewrite*. The real scope is
  **pointer-events arbitration**, not positioning: today the canvas is `pointer-events: none` and
  `scrollRef` is the sole hit-test target. Selection, per-message actions and code-block copy are
  **one decision with three consumers**. Full analysis: `dev/research-chat-pipeline-audit.md`.
  Note Design's honest caveat: a canvas transcript cannot be selected, found-in-page, or read by
  assistive tech — that is an accessibility floor, not a preference.
- **Per-project env vars.** `dev/project-env-design.md` + `dev/briefs/project-env-vars.md`. The
  injection point already exists (`src-tauri/src/lib.rs:748-758`). **Config and secrets must not share
  a storage rule** — a token in a pty is visible to everything the agent runs and can reach `chat.db`
  via the transcript. Keychain for secrets; `~/.operator/projects.json` and `.claude/settings.json`
  are both wrong homes.
- **Deferred with a trigger** — see the table at the top of `dev/briefs/COORDINATION.md`: verify the
  2000-char tool-output cap against real data once tool rows exist in `chat.db`. Check with
  `sqlite3 ~/.operator/chat.db "SELECT COUNT(*) FROM messages WHERE kind LIKE 'tool%';"`.
- Review's P2/P3 list in `dev/review-todays-landings.md` (`completeTerminalTasks` mis-attribution,
  `signal.interruptible` declared and never read, small items).

## Hard-won lessons from this session

1. **The dispatch loop is lossy in BOTH directions.** Outbound: long `OPERATOR-DISPATCH` lines get
   split — prefix submits, tail strands in the composer. Inbound: **a lane's chat answer is invisible
   to the coordinator; only files it writes are seen.** Research completed a full audit and a spike
   that went unnoticed for 40 minutes and was nearly relaunched over. **Every brief must name an
   output file, and dispatch lines stay short with the brief in `dev/briefs/*.md`.**
2. **Read the durable state, not the UI.** The roster claimed "28 QUEUED" when the store held 23
   `running` + 7 `done`. `~/.operator/projects.json` is the truth.
3. **Fixtures must match reality.** A mock with invented `thinking` prose validated a disclosure
   control whose body can never open — `thinking` is empty in 100% of real transcripts. The same
   failure then repeated one day later on the tool-result pipeline.
4. **A fix that moves upstream of a persistence boundary leaves the old data behind** — and that is
   usually what the user is looking at. The injected-turn filter was correct in the parser and still
   wrong on 188 rows already in `chat.db`.
5. **Check a lane's transcript before concluding it is stuck.** `~/.claude/projects/<slug>/*.jsonl`.
6. **Three of the nine release blockers came from the user clicking around**, not from Review, QA or
   code reading — stuck tooltips, a dead stop button, an 84px header offset, a navigation dead-end.
   That channel finds what the automated ones structurally cannot. Budget a deliberate human pass
   before any release.
