# Result — settings prune + the `compacting` phase (Code lane), 2026-09-05

Brief: `dev/briefs/settings-prune.md`. Branch: `operator/e78fc0`, rebased onto `9cb92f6`.

## Gates

| Gate | Result |
|---|---|
| `npm test` (renderer) | **1008 pass / 0 fail** |
| `cd electron && npm test` | **412 pass / 0 fail** (was 404; +8) |
| `cargo test` | **183 pass / 0 fail**, 3 ignored (was 179; +4) |
| root `tsc` + `npm run build` | clean |
| electron `typecheck` + `build` | clean |
| `cargo build` | clean, zero warnings |

---

## 1. The per-project Effort Level field is gone

Removed from `GeneralSection.tsx`: the label, the four-button segmented control, and the
`SETTINGS_EFFORT_LEVELS`/`settingsEffort` import. A comment stays in its place saying why there is
no effort control on that screen, because the next person to look will otherwise wonder — it wrote
`settings.json`'s `effortLevel`, which governs only Claude Code sessions started **outside**
Operator, while a lane launched from the app takes its effort from the `--effort` flag and never
reads that file.

**`settingsEffort` and `SETTINGS_EFFORT_LEVELS` both stay**, and the brief's condition ("if nothing
else uses them") is why:

- `settingsEffort` has a second live caller at `DashboardView.tsx:2273` — the one-way `normal` →
  `medium` migration that repairs the legacy value Operator used to write and Claude Code always
  discarded. Deleting the helper would have silently deleted that repair.
- `SETTINGS_EFFORT_LEVELS` is the only written-down copy of the file's own four-value enum, and
  `effort.test.ts` uses it as the oracle for the clamp being total (`for (const level of
  EFFORT_LEVELS) expect(SETTINGS_EFFORT_LEVELS).toContain(settingsEffort(level))`). Removing it
  would mean inlining the enum into the test, i.e. a second copy of exactly the thing `lib/effort`
  exists to state once.

**No test was removed**: nothing in `effort.test.ts` covered the field itself, only the helpers,
which are still live. The roster's per-role picker and the `--effort` launch path were not touched,
as instructed.

Two controls for a lane's effort remain, both real: the roster pin (launch time) and the session
toolbar chip (live, `/effort` to the pty).

---

## 2. `compacting` is now emitted — and it took two fixes, not one

The audit was right that `derive_phase()` could only ever return `running` or `waiting`. It was
right about the cause and short by one step about the cure: deriving the phase correctly is not
enough to make it visible.

**The record.** Shape confirmed against a real transcript rather than assumed —
`~/.claude/projects/-Users-juanmnl--operator-worktrees-el-encanto-2c73c0/981a9e3b….jsonl`:

```json
{"type":"system","subtype":"compact_boundary","content":"Conversation compacted","level":"info",
 "compactMetadata":{"trigger":"auto","preTokens":998698,"postTokens":21681,"durationMs":133798, …}}
```

**What that shape tells you, and it matters for reading the code:** the record carries
`durationMs`, `preTokens` and `postTokens`, so it is written when the compaction has already
**finished** — it closes the compaction, it does not open it. In that same file the record
immediately after it is a `user` re-prime, then attachments, then the assistant. So the window
`compacting` covers is *the model coming back with a rebuilt context*, which is the part the user
actually sits through (`durationMs` there is 134 seconds, and the regeneration after it is not
instant either).

**Fix 1 — derive it.** Both tailers gained a `compacting` flag, set on a
`type:"system", subtype:"compact_boundary"` record and cleared on the next assistant record.
`derive_phase` / `derivePhase` take it as a fourth argument and check it **first**:

- Ahead of the user-prompt rule, because a `user` record is literally the next thing in the file —
  without this precedence the phase would last one record and read `running`, which is what
  shipped.
- Ahead of the open-tool check, because a tool still open across a boundary is a tool whose result
  compaction has already dropped. Reporting `running` off it is reporting a signal that has
  stopped being true — the same judgment the existing code already applies to `last_tool_name`,
  which is cleared rather than left stale.
- Cleared only on a **non-sidechain** assistant record: a subagent talking says nothing about the
  main thread, the same rule that stops a subagent relabelling the session's model.

**Fix 2 — let it survive the pty override, without which fix 1 is invisible.** Both tailers had
`let phase = if pty_active { "running" } else { t.phase() }` (`transcript.rs:1126`,
`transcript.ts:591`). Coming back from a compaction is precisely when Claude Code streams hardest,
so `isActive` is true for essentially the whole window and that line would have relabelled every
tick as the generic `running`. The phase would have been derived perfectly and still never seen —
the same outcome the brief was written to end, arrived at one layer further down.

`compacting` is now exempt. The override exists to stop a busy lane reading as **idle**;
`compacting` is not an idle state, it is a more specific busy one, so overriding it buys no
flicker protection and discards the only signal that explains why the wait is long. Every other
phase behaves exactly as before — the existing `pty activity outranks the transcript` test still
passes untouched.

**Tests — 4 Rust, 8 Electron.** Rust: the boundary drives the phase end-to-end through `apply`
(including the `user` re-prime that pins the precedence), a sidechain assistant does not end it,
another `system` subtype does not start it, and the pure function prefers `compacting` over a stale
open tool. Electron: the same four through the real file-and-tick harness, the two `derivePhase`
unit cases, and — the one that makes the feature real — **`survives the pty-activity override`**,
run with `isActive: true`.

**Counting boundaries per session** (the usage-view note in the brief) is not built. It is now a
small follow-on rather than a research problem: the record is recognised in both tailers, so a
counter is a field increment next to the flag.

---

## 3. Unwired controls found while in there — listed, not deleted

I swept every control on both settings surfaces (`PrefsView` and the eight
`preferences/*Section.tsx`), traced each handler to its destination, and verified the findings
below against the source myself rather than trusting the sweep.

**Everything on the app-level `PrefsView` is wired** — all eleven controls (update check, install,
theme pair, identity tiles, dock icon, resume-on-launch, ask-before-quit, keep-warm radiogroup,
chime, ⌥-as-Meta, fullscreen TUI). This matches the audit's part 2 conclusion.

**Every writable per-project control is wired**: Instructions (blur-save), Permissions,
Sandbox, Denied MCP Servers, Plugins, Environment, and the file tab bar / create-file paths.
`HooksSection` and `SkillsSection` are read-only by design and genuinely are — `HooksSection` has
no interactive element at all, and `SkillsSection`'s only two controls are a local filter and an
expand toggle.

**One dead end, and it is shell-specific:**

- **`WorktreesSection.tsx:169` — "Remove them"** (the reap confirmation) is a no-op **in the Tauri
  build**. `runReap` calls `window.operator.worktreeReap(false)`, and the Tauri bridge stubs that
  to throw (`src/operator-bridge.ts:269`, `'The Tauri build has no worktree reaper.'`); the throw
  is caught into the panel's error state, so the button can never remove anything there. In
  Electron the same press is fully wired (`ipc.ts` → `worktree-reap.ts`), which is the shipping
  shell — so this is a documented stub showing through, not a broken feature. **Not deleted**, per
  the brief.

**Two related observations that are not controls**, so not classified as unwired, but worth the
same visibility:

- **The install progress bar never moves in the Tauri build.** `PrefsView` subscribes to
  `onUpdateProgress` / `onUpdateError`, and neither exists in `src/operator-bridge.ts` (confirmed:
  zero occurrences). Optional chaining swallows the absence, so the button's fill sits at 0% until
  the relaunch. The install itself still works. Electron declares both.
- **`SkillsSection`'s retry cannot succeed under Tauri** — `skillsCatalog` is stubbed to an empty
  catalog with a permanent error. The button does change state and the page is read-only, so it is
  not a dead control, just a retry with nothing to retry.

## Not done

- Nothing merged. One commit on `operator/e78fc0`.
- **Noticed, not changed:** Electron's `resetForReread` clears every derived field (I added
  `compacting` to it); Rust's truncation path resets only the byte offset and lets derived state
  persist. That asymmetry predates this change and applies equally to `last_stop_reason` and
  `last_was_user_prompt`, so `compacting` follows each shell's existing convention rather than
  introducing a third.
- No GUI verification. The `compacting` phase is proven through both tailers' test harnesses, but
  no lane was watched through a real compaction in a running app — and since the whole point of
  fix 2 is that the phase only appears under live streaming, that is the observation still worth
  making.
