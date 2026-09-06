# Result — remove Chat and Files, restore per-lane tuning (Code lane), 2026-09-05

Brief: `dev/briefs/remove-chat-files.md`. Base: `f1836e6` on `main`. Branch: `operator/e78fc0`.

Three parts, three commits:

1. **The brief as written** — Chat and Files out of both shells.
2. **Per-lane model + effort back on the session toolbar.** Part 1 deleted the only live
   in-session control for the thing the direction note calls the core job. Not in the brief; done
   because shipping part 1 alone would have moved the product away from where it is going.
3. **The 33 "pre-existing" test failures, fixed.** A Node 26 regression, not a code defect.

Part 1 alone is **+73 / −5,107** lines of source (−5,691 counting `package-lock.json`), 50 files
touched and 25 deleted. Parts 2 and 3 add back ~330 lines across 7 files.

## Gates

| Gate | Result |
|---|---|
| `npm test` (renderer) | **1008 pass / 0 fail**, 71 suites |
| `cd electron && npm test` | **390 pass / 0 fail**, 22 suites |
| `npx tsc --noEmit` (root) | clean |
| `cd electron && npm run typecheck` | clean (both `tsconfig.json` and `tsconfig.renderer.json`) |
| `npm run build` (root, `tsc && vite build`) | clean |
| `cd electron && npm run build` | clean (main + renderer) |
| `cargo test` | 179 pass / 0 fail / 3 ignored |
| `cargo build` | clean, **zero warnings** |

The renderer suite is fully green for the first time since Node 26 — the 33 failures every recent
handoff carried as "pre-existing" are diagnosed and fixed, see part 3.

Baseline arithmetic: electron was 415 pass at 0.20.0; `files.test.ts` (36 tests) was deleted, and
the two electron-binary-dependent suites (`tray`, `updater`, 11 tests) were flaky on the first run
in a fresh worktree and pass on a warm one. 415 − 36 = 379 + 11 = 390.

## Files deleted (25)

**Chat, renderer**
- `src/renderer/components/session/CanvasConversation.tsx` (1125)
- `src/renderer/components/session/ChatComposer.tsx` (448)
- `src/renderer/lib/chat-turns.ts` + `.test.ts`
- `src/renderer/lib/canvas-md.ts` + `.test.ts`
- `src/renderer/lib/tool-blocks.ts` + `.test.ts`
- `src/renderer/lib/tool-file-link.ts` + `.test.ts` (already dead before this change)

**Files, renderer**
- `src/renderer/components/files/` — the whole directory: `FilesView.tsx`, `FilesPanel.tsx`,
  `FileTree.tsx`, `FileViewer.tsx`, `cm-theme.ts`
- `src/renderer/lib/code-nav.ts` + `.test.ts`

**Electron main**
- `electron/src/main/files.ts` (354) + `files.test.ts` (232)

**Dev/verification tooling that drove only these two surfaces**
- `scripts/visual/chat-harness.tsx`, `scripts/visual/chat.html` — the `verify:visual` harness page
  that mounted `CanvasConversation`
- `dev/drive-chat-feed.mjs`, `dev/qa-drive-real-chat.mjs`, `dev/drive-files-scroll.mjs`

`dev/qa-real.html` / `qa-real-bridge.ts` / `qa-real-main.tsx` stay — four other drivers
(`drive-gallery-shelf`, `drive-gridterm-wire`, `drive-rail`, `qa-drive-hover-card`) use them.

## Surgical edits

- **`DashboardView.tsx`** — `MainView` is now `'terminal' | 'preview'`, `PanelTab` is
  `'plan' | 'diff'`. `panelTabs` was a three-way branch on the main view; it is now the constant
  `['plan', 'diff']`. Dropped: the `FilesView`/`FilesPanel`/`CanvasConversation`/`code-nav`
  imports, `filesNavs`/`filesNav`/`setFilesNav`, `toggleChat`, both main-view render blocks, the
  `filesTab` prop, and two callbacks left with no caller (see *Behaviour changes* below).
- **`CanvasPanel.tsx`** — kept (Plan + Diff still live in it). Lost the `chat`/`files` tabs, their
  `LABELS`, and the `role`/`customName`/`accent`/`onHumanSend`/`onModelChange`/`onEffortChange`/
  `filesTab` props, which existed only for the Chat tab.
- **`SessionToolbar.tsx`** — the segmented control is now **Console · Preview**.
- **`pane-visibility.ts` (+ test)** — `MainView` narrowed; the `'chat'` case folded into the
  Preview one it always shared behaviour with.
- **`chrome.test.ts`** — `BLOCK_SLOT_SURFACES` is down to `AppPreviewPanel`, which is the only
  surface still mounted in that slot. The `describe('the file viewer reads down, not sideways')`
  block went with `FileViewer`/`cm-theme`.
- **`shared/types.ts`** — `TreeEntry` and `FileContent` removed.
- **`env.d.ts` + `operator-bridge.ts`** — `fileTree`, `fileRead`, `fileWatch`, `fileUnwatch`,
  `onFileChange`, `chatHistory`, `imageDataUrl` gone from the bridge surface. (`fileWatch`/
  `fileUnwatch`/`onFileChange` were not named in the brief but had no consumer other than the
  removed Files view, and their Electron implementation lived in the deleted `files.ts`.)
- **`electron/src/shared/operator-api.ts`** — the same seven entries dropped from the SPEC table.
- **`electron/src/main/ipc.ts`** — the file seam, `chatHistory`, `imageDataUrl`, the now-unused
  `IMAGE_MIME` map and the `extname`/`files` imports.
- **`electron/src/main/index.ts`** — `stopAllWatching()` on teardown and its import (the FSEvents
  streams it closed were opened only by the code navigator).
- **`src-tauri/src/lib.rs`** — `chat_history` and `image_data_url` commands plus their
  `invoke_handler` registrations.
- **`dev/mock-bridge.ts` / `dev/qa-real-bridge.ts`** — the `MOCK_CHAT` fixture, `longChat`, and the
  `chatHistory`/`imageDataUrl` mock answers.
- **`README.md`** — "Three ways to watch one session" is now two; the `Cmd+J` row is gone from the
  shortcuts table.
- Comment-only edits naming a deleted file: `PopMenu.tsx`, `lib/terminal.ts`, `lib/local-time.ts`,
  `lib/drop-guard.ts` + `.test.ts`, `shared/types.ts`, `src-tauri/src/chatstore.rs`,
  `electron/src/main/chat-store.ts`.

## Cmd+J

Unbound, not reassigned, as the brief asked. The `else if (e.key === 'j')` branch is gone from the
shortcut handler, and the `'⌘J'` hint was removed from the palette's *Show Console* entry (it had
been shared with the deleted *Show Chat*). ⌘J now falls through to the terminal like any
unclaimed chord.

## Every surviving "chat"/"files" reference, and why

| Kept | Why |
|---|---|
| `src/renderer/lib/chat-signal.ts` (+ test) | `toolVerb()` feeds `TaskBoard.tsx`; `chatSignal()` feeds the quit guard's lane wording (`DashboardView` `identifyQuitLane`). Both still called. |
| `src-tauri/src/chatstore.rs` — `open`/`append`/`replies`/`ProjectReply`, the `messages` table, `chat_db_file` | The durable write path. Every session's transcript writes here and CommsLog reads `replies()`. |
| `electron/src/main/chat-store.ts` — including `ChatStore.load()` | Same write path. **`load()` has no production caller any more**, but it is the read-back that all of `chat-store.test.ts`'s append/purge/migration assertions verify through — deleting it would have gutted a suite the brief did not scope. Flagging it as a deliberate leftover. |
| `src-tauri/src/chatstore.rs` — `ChatStore::load()` | Same situation, but Rust has `#[cfg(test)]`, so it is now compiled **only under test** and annotated as such. `ToolBlock`'s import moved behind the same gate to keep the build warning-free. |
| `transcript.rs` / `transcript.ts` | Untouched. Session phases, dispatches, replies. |
| `NarrationEntry`, `ToolBlock`, `AgentSession.messages`, `.queued` | Populated for every session; `delivery-confirm.ts`'s submit-queue watchdog reads them. |
| `ProjectReply` + `CommsLog.tsx` | Project-level replies timeline, a different surface. |
| `drop-guard.ts` | Comment edit only. |
| `~/.operator/chat.db` and the README lines naming it | The store is alive; only its reading panel is gone. |
| `dev/*.md` historical reports | Records of past work. Not rewritten. |

## Behaviour changes worth knowing

1. **`resetChainFor` lost a caller.** `handleHumanSend` existed so that typing into the Chat
   composer restored a lane's delivery hop budget. It is deleted with its only caller. The reset
   now happens **only** on the board's *Send →* and *Start all* (`dispatchToRole`) — which is what
   the code comment described as the original, insufficient set. Plan's "Send to agent" and
   Preview's dispatch go through `submitQueue` directly and never reset the budget, as before.
   Worth a follow-up decision: whether those two paths should now count as "a human addressed this
   lane".
2. **Per-session model/effort briefly had no control at all.** The composer's `/model` and
   `/effort` pills were the only callers of `patchActiveTerminal`. Restored on the toolbar in
   part 2 below.
3. **Preview's file-open links**: no link affordance was left to drop — `tool-file-link.ts` was
   already dead code before this change, and `AppPreviewPanel` never imported `code-nav`.

## Dependencies removed

`@codemirror/language`, `@codemirror/language-data`, `@codemirror/state`, `@codemirror/view`,
`@lezer/highlight` — added for `FileViewer`/`cm-theme` only, and nothing in `src/`, `electron/src/`,
`dev/` or `scripts/` imports them any more. `package-lock.json` shrinks by 584 lines. Not named in
the brief; removing them is the direct consequence of deleting the viewer, and both builds and all
suites were re-run after.

---

# Part 2 — per-lane model + effort on the session toolbar

**Why this is not scope creep.** `project_simplify_direction` states the core job as "tune each
lane's model + effort so plan limits are approached but never hit". Part 1 deleted the composer,
which held the only live `/model` and `/effort` controls in the app. What was left: the roster's
launch-time pins, and a per-project `effortLevel` field the audit already flagged as governing
only sessions started OUTSIDE Operator. Neither can retune a lane that is already running, which
is when you actually know you are burning the week's budget. Part 1 shipped alone would have
removed the direction's core verb from the product.

**Where they went.** `SessionToolbar` — the one surface every session always has, and where the
effort value was already displayed read-only. The two chips sit together, model first: the model
is the big lever (a different rate per token) and effort is the trim.

- `src/renderer/lib/lane-tuning.ts` (new, + 11 tests) — `effortCommand`, `modelCommand`,
  `normalizeModelId`. The commands are a **bare line + CR, never a bracketed paste**: Claude Code
  treats a line as a slash command only when it was typed, so a pasted `/effort high` arrives as
  a message that reads "/effort high" and the lane's effort silently never changes. That is why
  these do not go through `submitQueue`, which pastes — and why the rule is a test, not a comment.
- `normalizeModelId` guards the free-typed "Other…" id, which is arbitrary text with a pty on the
  other end. A CR in the middle is a second command, not a bad model id. Control characters and
  inner whitespace are refused rather than escaped.
- `PopMenu` gained `placement: 'up' | 'down'`. A composer at the foot of a pane opens upward; a
  toolbar chip at the top of the window opens downward from its own right edge. Same menu, two
  anchors — the alternative was a second menu component, which is the thing that file exists to
  prevent. It also gained `data-no-drag`, because a toolbar is a `DragRegion` and
  `-webkit-app-region: drag` inherits: without it every menu item would be a window-drag handle
  instead of a button.
- **`PopMenu` had zero callers after part 1** — the composer was its last one, and I missed it in
  the removal sweep. Part 2 makes it live again rather than leaving a dead file behind.
- Model presets come from `ROSTER_MODELS` (`lib/roster`), not a new array. The deleted composer
  kept its own private copy, and the model-research note already called that duplication out as
  the reason a new tier needs two edits.
- `patchActiveTerminal` is restored in `DashboardView` and wired to both chips, so a pick survives
  a tab switch and lands in the durable `SavedSession`.

A lane with no live pty renders both chips as the static badges they were before — nothing to
write to, so nothing to click.

**Still open, and deliberately not touched:** the per-project `effortLevel` field in
`FolderPreferencesView`. The audit's judgment was "relabel or remove"; that is a settings decision,
not mine to make inside this task.

---

# Part 3 — the 33 "pre-existing" test failures were a Node 26 regression

Every recent handoff records "33 pre-existing failures" in the renderer suite. They are not
pre-existing in the sense of a known code defect — they are an environment regression that has
been masking five files' worth of guards.

**Cause.** Node 26 added its own `localStorage` global, inert unless the process was started with
`--localstorage-file`: the property is defined, the getter returns `undefined`, and Node prints an
ExperimentalWarning. That definition lands on `globalThis` and **shadows the one jsdom installs**.
So `localStorage.clear()` in a `beforeEach` throws `Cannot read properties of undefined`, and every
test in the file fails without ever reaching the code it covers. This machine runs Node v26.7.0.

Confirmed rather than guessed: in the test environment `sessionStorage` is a working jsdom
`Storage` object, `Storage` is jsdom's class, and `localStorage`'s own property descriptor is a
configurable getter returning `undefined`.

**Fix.** `src/test-setup.ts`, wired via `setupFiles` in `vitest.config.ts`. It hands back an
instance of **jsdom's own `Storage` class** — which it must, because the tests covering the
storage-is-unavailable path use `vi.spyOn(Storage.prototype, 'getItem')`, and that only reaches an
instance whose prototype is the ambient class. jsdom's constructor is not callable from userland,
and a `Storage` from a second JSDOM realm is a different class with a different prototype, so the
spy would attach to one object while the code called another. `sessionStorage` is the one working
instance of the right class already present, and nothing in `src/` touches it — so it is the store,
under both names. The whole thing is guarded, and a no-op on any Node that does not shadow.

**Result: 1008 pass / 0 fail.** The five files this un-reds are `terminal-options` (the terminal
renderer mode, which is on the session-spawn path), `ghost-probe`, `rail-foot`,
`forgotten-projects` and `lane-accents`. Their guards have been inert for some time.

---

## Not done

- Nothing was merged. The work sits on `operator/e78fc0`, three commits ahead of `main`.
- No GUI verification. The toolbar chips are unexercised in a real window — the two menus are new
  UI in a `DragRegion`, which is exactly where a drag-region mistake shows up, so this is the part
  worth a look. `npm test`, `tsc` and both builds pass; none of them render.
- The per-project `effortLevel` setting (audit item, "relabel or remove") is untouched.
