# Result — QA of `operator/plan-bar` (983e44f) and `operator/dispatch-bus` (0554ffa)

Brief: `dev/briefs/qa-plan-bar-and-bus.md`. Two isolated worktrees (not the shared one QA passes
1–2 used, to avoid another cross-lane file sweep): `plan-bar` in this session's own scratchpad,
`dispatch-bus` at the already-existing `/Users/juanmnl/.operator/worktrees/operator-e78fc0`
(reused as-is, at the right commit, untouched by anyone else during this run). Explicit-path
commits only; no real transcript ever copied in — every jsonl fixture below was authored by hand.

## Summary

| # | Branch / item | Verdict |
|---|---|---|
| 1 | Suite + harness counts, both branches | **PASS** |
| 2 | `plan-bar`: bottom-bar cells via qa-real bridge | **PASS** — 36/36 checks, no defects |
| 3a | `dispatch-bus`: SQLite round trip of request/verdict | **1 real bug found** — the `to`/`address` field-name mismatch |
| 3b | `dispatch-bus`: tailer mapping, synthetic jsonl | **PASS**, but surfaces that the mapping has **no production caller** |
| 3c | `dispatch-bus`: live two-lane end-to-end | **Not attempted** — see "What stays unproven" |

---

## 1. Suites and harnesses

**`operator/plan-bar` @ 983e44f:**

| Command | Result |
|---|---|
| `npm test -- --run` (renderer) | **1095 pass / 0 fail**, 74 suites |
| `cd electron && npm test -- --run` | **501 pass / 0 fail**, 25 suites (2 files failed on the very first cold run — `tray-anim.test.ts`/`tray.test.ts`, "Electron failed to install correctly"; re-ran warm and all 3 electron-binary tests passed. This is the same fresh-worktree flake pass 1's result doc already recorded, not a regression.) |
| `cargo test` | **192 pass / 0 fail**, 3 ignored |
| `verify:visual`, `verify:input` | PASS, PASS (6/6) |
| `verify:width`, `verify:resize-guard` | PASS |
| `verify:dom`, `verify:ghost` | PASS, PASS (0 mismatches / 9×2 fixtures) |

**`operator/dispatch-bus` @ 0554ffa:**

| Command | Result |
|---|---|
| `npm test -- --run` (renderer) | **1089 pass / 0 fail**, 74 suites |
| `cd electron && npm test -- --run` | **508 pass / 0 fail**, 26 suites |
| `cargo test` | **188 pass / 0 fail**, 3 ignored |
| `verify:visual`, `verify:input` | PASS, PASS (6/6) |
| `verify:width`, `verify:resize-guard` | PASS |
| `verify:dom`, `verify:ghost` | PASS, PASS (0 mismatches / 9×2 fixtures) |

Both branches match their own result docs' gate numbers exactly.

---

## 2. `plan-bar` — bottom-bar cells via the qa-real bridge

New: `dev/qa-planbar-main.tsx` + `qa-planbar.html` (reuses `dev/qa-real-bridge.ts`'s real
project/roster fixture, layers a controllable `planLimits` on top via `?limits=<case>`) and
`dev/drive-plan-bar.mjs`, driving the real session's `contextTokens`/`model`/`effort`/`phase`/
`compactions` through the bridge's `__mockPhase` hook. **36/36 checks pass, no defects.**

**Context cell:**
- 12k/200k renders `"12k / 200k"`, bar in the **normal** tone (`--accent`).
- 184k/200k (92%) renders `"184k / 200k"`, bar in the **danger** tone (`--color-error`) — the same
  `toneFor`/`TONE_FILL` thresholds the plan bars use, confirmed by resolving the CSS var and
  comparing, not by eyeballing a screenshot.
- A `[1m]` model id (`claude-sonnet-5[1m]`) at 400k renders against a **1.0M** window
  (`"400k / 1.0M"`, 40%, normal tone) — not the 200k default, which would have shown 200% over a
  full-looking red bar.
- **Compacting** swaps the numbers for the literal text `"compacting…"` — confirmed it is a text
  swap (no animation classes/keyframes involved) — and the `↺` compaction count still renders
  beside it.
- `↺` is **absent entirely** at `compactions: 0` (presence is the signal, not a `↺0`).
- **Absent is not zero**: `contextTokens: 0` (nothing measured yet) renders `"— / 200k"`, never
  `"0k / 200k"`.

**Plan cell, each limit binding in turn** (session/week/model fixtures where the OTHER two are
present but lower, so `bindingLimit` has to actually compare):
- Session-binding (92%), week-binding (88%), model-binding (95% "Current week (Opus)") — in every
  case, **only** the binding row's number resolves to `--fg` ink and only its 1px rule is painted
  (not transparent); the other two rows resolve to `--fg-muted` with a transparent rule. Verified
  by resolving both CSS custom properties through a probe element and comparing computed colors,
  not by string-matching a hex code that could drift.
- Only the binding row's title carries the reset clause (`"… — 92% used, resets in 45 min"`); the
  other two omit it (`"… — 30% used"`).

**Absent / stale → "no reading":**
- `planLimits()` returning `{}` → the plan cell reads exactly `"no reading"`, no `%` anywhere.
- A reading fetched 65 minutes ago (past `STALE_MS`) with its reset clause still resolving to a
  future instant (so this exercises `isStale`, not the separate `windowEnded` path) → also
  `"no reading"`. (My first attempt at this fixture accidentally described an already-*ended*
  session window and got the app's distinct `"window closed"` chip instead — that is a different,
  also-correct state the same module renders; the fixture was corrected to isolate plain
  staleness, which is what the brief asks for.)

**Click opens Tuning:** confirmed for both the populated plan cell and the "no reading" state
(both are real `<button onClick={onOpenTuning}>`s) — each lands on `[data-page-title]` reading
`"Tuning"`.

**Rail foot, both widths:** at the default (expanded) width and after `⌘B` (collapsed), there is
no `[data-rail-usage]` element and no ring-shaped SVG (`stroke-dasharray`) anywhere in the rail —
`PlanMeter.tsx` really is gone, not just hidden — and `[data-rail-tuning]` is present in the
resting slot at both widths, matching `RESTING_FOOT_ITEMS = ['agents', 'tuning', 'gallery',
'open-folder']`.

**Noticed, not a functional bug:** six comments across five files (`ProjectRail.tsx:133`,
`foot-cell.ts:1,11-12`, `TuningView.tsx:277`, `FooterReading.tsx:96`, `plan-limits.ts:316`) still
name `PlanMeter` by identifier, even though `PlanMeter.tsx` no longer exists in the tree. Harmless
— nothing imports it — but worth a pass before someone chases a component that isn't there.

---

## 3. `dispatch-bus` — request/verdict protocol

### 3a. Real temp-SQLite round trip — **1 real bug found**

The result doc says plainly: *"Nothing has run end to end… what is not [proven] is the round trip
through SQLite."* This closes that gap using the **real** `ArtifactStore` (`chat-store.ts`) and
the **real** exported `handle()` (`mcp-serve.ts`) — not reimplementations — racing a genuinely
separate OS process (a small `.cjs` helper using `better-sqlite3` directly, so no TS-module
resolution was needed for the second process) against the real blocking `Atomics.wait` in
`awaitVerdict`. 7/7 checks pass, but one of them **proves a real contract bug**:

> **The `dispatch`/`reply` tools' own description promises a field that does not exist in their
> actual response.** `mcp-serve.ts`'s `TOOLS` list tells the calling model: *"if the answer says
> `send`, you must then call SendMessage with the `to` and `text` it gives you."* The JSON
> actually returned — `JSON.stringify(verdict)` where `verdict = awaitVerdict(...)`, which is
> `store.dispatchVerdict(id)`'s row verbatim — uses the column name **`address`**, not `to`.
> Confirmed byte-exact: `{"outcome":"send","address":"uds:/tmp/cc-socks/19287.sock","text":"…",
> "taskId":"…"}`. `result.to` is `undefined`.

**Why this survived:** `DashboardView.tsx`'s write side (`answerDispatch(r.id, {..., address:
verdict.to, ...})`) correctly renames the renderer's own `DispatchVerdict.to` field to the `address`
column on the way in — that half is right. Nothing renames it back on the way out. The two ends
were each unit-tested in isolation (`dispatch-bus.test.ts` tests `resolveDispatch` returning
`{to}`; `session-bus.test.ts` tests the registry) and **there is no `mcp-serve.test.ts` at all** —
nothing exercises `callTool`/`handle`/the actual returned JSON shape for any outcome. A model
following the tool's own documented two-step protocol exactly as written would look for `to`,
find nothing, and have no address to send to — this would silently break every `send` outcome for
a real caller, while every existing test stays green.

**The other outcomes and the rest of the protocol are correct:**
- `outcome: 'launching'` and `outcome: 'refused'` are returned verbatim with their `reason`, no
  `address`/`text` — as designed.
- The `reply` tool follows the identical path.
- **A verdict is never applied twice**: `answerDispatch`'s `WHERE id = ? AND answered_at IS NULL`
  makes a second answer to an already-answered row a genuine no-op at the SQL level — proven by
  answering a row once, then answering it again with a *different, contradictory* verdict, and
  confirming `dispatchVerdict` still returns the first one.
- **The timeout path** — accepted the real ~15s wait (`VERDICT_TIMEOUT_MS` is a module-private
  constant, not exported or configurable, and `Atomics.wait` blocks the real thread so fake timers
  cannot shorten it): `handle()` genuinely times out and returns the documented error text
  ("Operator did not answer in time… retry, or use the OPERATOR-DISPATCH sentinel"), and
  separately, `dispatchVerdict` on a never-answered row returns `null` — the exact precondition
  the timeout loop polls on.

**Fix sketch** (not applied — brief scoped changes to fixtures/drivers only): either rename the
`address` key to `to` in the JSON `mcp-serve.ts` returns to the caller (matching the documented
contract and the renderer's own `DispatchVerdict` type), or fix the tool descriptions to say
`address`. Either is a one-line change; leaving them disagreeing is the bug.

### 3b. Tailer mapping, synthetic jsonl — passes, but surfaces a wiring gap

Authored a synthetic jsonl (never a real transcript) with three `SendMessage` tool_use/tool_result
pairs — a **success** (`{success:true,msg_id:"cc-msg-001"}`), a **failure**
(`{success:false,message:"peer not connected"}`), and an **unrelated** `SendMessage` to a
different target entirely — run through the real `Transcript` live tailer (`register`/`tick`) and
then through the real `readDeliveryResult`. All checks pass:
- The tailer produces **three independent tool blocks**, never merged.
- `readDeliveryResult` maps the success to `delivered` with the CLI's own `msg_id`, the failure to
  `failed` with the CLI's own sentence **unparaphrased** ("peer not connected"), exactly as
  designed.
- The unrelated call also maps cleanly to `delivered` with its own `msg_id` — which is the finding
  worth stating plainly: **`readDeliveryResult` has no way to know it wasn't the dispatch being
  tracked**, because nothing hands it a `tool_use_id` or a target to correlate against.

**The larger fact this test exists to surface:** `readDeliveryResult` is completely unwired.
`grep -rn readDeliveryResult src electron` (repo-wide, not just this branch's new files) matches
only its own definition in `dispatch-bus.ts` and its own test file — **zero production callers**.
Nothing in `DashboardView.tsx` (or anywhere else) reads a lane's `SendMessage` tool_result off the
tailer and calls this function. The practical consequence: once a bus dispatch reaches `outcome:
'send'` and the task/board entry is created, **nothing ever updates that task to reflect whether
the lane's own `SendMessage` actually succeeded or failed** — the confirmation half of "dispatch
and reply over the session bus" is proven correct in isolation and unreachable in the running app.
This is consistent with — and now more precise than — the result doc's own "nothing has run end
to end" caveat: it is not merely unproven, the composition does not exist yet.

### 3c. Live two-lane end-to-end — not attempted; what stays unproven

Per the brief's own allowance ("otherwise state exactly what is unproven"): I did not attempt a
packaged build with two real lanes, and did not attempt an Electron dev shell with two fake lanes
either — reaching that would mean fabricating real Unix-domain-socket bus descriptors under
`~/.claude/sessions/`, a listener on the other end able to answer a real `SendMessage`, and either
a packaged binary or a way to run the actual `DashboardView` polling `useEffect` (not my own stand-
in) against it, which is a materially larger undertaking than a QA pass over specific units. What
is proven, precisely: the decision function (`resolveDispatch`, existing tests), the registry read
(`session-bus.ts`, existing tests), the request/verdict protocol through a **real** SQLite file and
a **real** second process (§3a, this pass), and the tailer→outcome mapping (§3b, this pass). What
remains unproven, precisely:
- That `readBusSessions()` correctly parses a **real** Claude Code session descriptor file as
  written by a real `claude` process (only its own unit tests, against hand-shaped JSON, cover
  this).
- That `DashboardView.tsx`'s actual 500ms polling `useEffect` — as opposed to my stand-in answerer
  — reads `openDispatches()`, resolves the route, and writes the verdict correctly when wired to a
  real IPC bridge in a real running renderer.
- That a real `claude` process's `SendMessage` tool actually delivers over a real Unix domain
  socket to a real peer, and that the receiving lane's transcript actually contains the shapes
  this pass's synthetic jsonl assumes.
- The `to`/`address` bug's actual blast radius on a real model — i.e., whether the model, faced
  with a `send` verdict missing the field its own instructions named, falls back to the
  `OPERATOR-DISPATCH` sentinel, hallucinates an address, or simply does nothing. That behavior can
  only be observed against a real Claude Code session.

---

## Commands used (for re-running)

```
# plan-bar
cd <plan-bar worktree>
npm install && (cd electron && npm install)
npm test -- --run; (cd electron && npm test -- --run); cargo test --manifest-path src-tauri/Cargo.toml
npm run verify:visual -- --port <p>; npm run verify:input -- --port <p>
npm run verify:width -- --port <p>; npm run verify:resize-guard -- --port <p>
OPERATOR_DEV_PORT=<p> npm run verify:dom; OPERATOR_DEV_PORT=<p> npm run verify:ghost
node dev/qa-extract-real.mjs   # regenerates the gitignored real fixture; delete after
npx vite --port <p> &
MOCK_PORT=<p> node dev/drive-plan-bar.mjs

# dispatch-bus (shared worktree /Users/juanmnl/.operator/worktrees/operator-e78fc0)
npm test -- --run; (cd electron && npm test -- --run); cargo test --manifest-path src-tauri/Cargo.toml
# items 3a/3b were throwaway files under electron/src/main/_qa-dispatch-*.{ts,cjs},
# run with `npx vitest run <file> --reporter=verbose` from electron/, then deleted.
```

## Not done

- `plan-bar`'s driver/bridge files are committed under `dev/` with explicit paths
  (`git add dev/drive-plan-bar.mjs dev/qa-planbar-main.tsx dev/qa-planbar.html`, commit `b9dc679`).
  `dispatch-bus`'s items were throwaway vitest files (a `.cjs` helper plus two `.test.ts` files),
  deleted after use — same rationale as passes 1–2: they duplicate real-source assertions inline
  rather than adding a reusable fixture.
- The `to`/`address` bug (§3a) and the unwired `readDeliveryResult` (§3b) were not fixed — the
  brief scoped this pass to verification only.
- No GUI verification beyond what the headless drivers exercise.
- §3c is explicitly not attempted, per the brief's own allowance, with the exact unproven surface
  listed above.
