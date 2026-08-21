# Result — S1: the transcript tailer, session model and chat store, in Node

**Accepted.** All four acceptance criteria met, and the parity check found five real divergences
that unit tests had not — the port is measurably closer to the Rust than it was this morning.

Nothing under `src/renderer`, `src/shared` or `src-tauri/` changed. (The S1 brief expected none,
and there were none.)

## Acceptance

### 1. Chat parity with Tauri, on the same jsonl

The Tauri app cannot be driven from here, so the comparison uses the closest thing to its own
output that exists: **the rows the Tauri build already wrote to `chat.db`** for a session. Those
rows *are* the Rust tailer's answer for that exact transcript. `probes/s1-tailer-parity.mjs` runs
the Node tailer over the same file and diffs the two.

| Session | jsonl | Tauri rows | Node rows | seq | kind | text | tool |
|---|---:|---:|---:|:--:|:--:|:--:|:--:|
| `0ec13b57…` | 16.4 MB | 2038 | 2038 | ✅ | ✅ | ✅ | ✅ |
| `5c943d9c…` | 18.1 MB | 2013 | 2013 | ✅ | ✅ | ✅ | ✅ |
| `bbc2ed22…` | 42.6 MB | 1948 | 1948 | ✅ | ✅ | ✅ | ✅ |
| `3afe56ac…` | 24.4 MB | 1774 | 1774 | ✅ | ✅ | ✅ | ✅ |
| `90756a9b…` | 21.4 MB | 1440 | 1440 | ✅ | ✅ | ✅ | ✅ |

**9,213 rows across 5 real sessions, zero differences** in seq, kind, text or tool-block name.
Derived state also lands: summary, model, phase, usage totals, an 80-capped live tail.

One note on method: the Node tailer *pushes* 2,129 entries for the first session but produces
2,038 **rows**, because a tool row is pushed twice — once for the call, once when its result
arrives — on the same seq. The store folds those; the probe folds them the same way. Comparing
raw pushes to rows would have read as a 91-row discrepancy that isn't one.

### 2. Sentinel round-trip to the renderer

`probes/s1-sentinel-roundtrip.cjs` runs under Electron and exercises the whole path — jsonl on
disk → `Transcript.tick` → main `broadcast` → `ipcRenderer.on` in the **real preload** → the
callback a renderer registered. Not the tailer in isolation.

```
ok  the dispatch reached the renderer — "verify the drop guard"
ok    with the right role — qa
ok    and the lane it came from
ok    and a stable id — e973246a3f7b23fb
ok  the QUOTED dispatch did NOT fire — 1 dispatch(es) total
ok  the reply reached the renderer — "tailer parity confirmed"
ok    stamped with the project id — proj-42
ok  session:update also reached the renderer
ok  a second tick re-fires nothing
```

The quoted-directive case is in there deliberately: a dispatch is delivered into another lane's
pty, so a sentinel a lane merely *read* must not commission work.

### 3. `chat_history` on a Tauri-written `chat.db`

`probes/s1-chat-parity.mjs`, against a **copy** of the real 75 MB store (88k messages, 399
sessions, 457 replies) — never the live file, because opening the store runs the one destructive
statement in the app.

```
ok  row count matches SQL — 2038 vs 2038
ok  order preserved (by seq)          ok  timestamps preserved
ok  tool blocks parse back to objects — Bash
ok  replies match SQL for a real project — 126 vs 126 in operator-3cfdffb0
ok  opening the store did NOT modify the file — sha256 b7dc104f91aa…
ok  no purge backup was written (user_version was already current)
ok  no rows were deleted — 87723 messages
```

The byte-identical check is the brief's "must open an existing chat.db unmodified", made literal.

### 4. Ported scenarios

**119 tests** in `electron/`, up from 84. New this stage: **25** transcript scenarios and **10**
chatstore scenarios, ported from the Rust test modules' situations rather than their shapes —
they drive a real file through a real tick, so they test behaviour, not structure.

`npm test` green (119), `npm run typecheck` clean. Root unchanged: 786 tests, `tsc` clean.

## What the parity check found that the unit tests did not

Five divergences, all fixed. Every one of them would have shipped.

1. **`seq` was assigned by the flush, not by the track.** A tool row is written when the call is
   seen and rewritten when its result lands; they must share a seq or the store gets two rows for
   one call. Ported `narration_seq` + `tool_seqs` properly.
2. **The narration cap evicted the wrong things.** The Rust drops **tool blocks first** and only
   falls back to prose — a tool-heavy turn produces dozens, enough to push out the answers the
   user is reading. Mine dropped oldest-first regardless.
3. **A tool entry's `text` was empty.** The Rust writes `"{name} {target}"` as a plain-text
   fallback so a surface that doesn't know `kind: 'tool'` still reads sensibly and a text search
   finds the call. This alone accounted for 691 differing rows.
4. **`caller` was read from the wrong place** — the envelope's `userType` instead of the block's
   `caller`. That field is what makes a subagent's call attributable.
5. **`first_line` differed twice**: the Rust trims the line, and on overflow takes `max - 1` so
   the result is exactly `max`, not `max + 1`.

Plus two found while porting rather than by the probe: the missing `PRAGMA user_version` purge
migration (with its backup-before-delete rule), and `bash_severity`, which I had written as
regexes that did not agree with the Rust's substrings.

And one hardening the probe motivated: entries are **snapshotted** into the persistence queue
rather than shared by reference. The queue crosses an event boundary to main and is written
asynchronously, so a later mutation could rewrite a row already handed over. The Rust clones for
the same reason.

## Rust behaviour I could NOT reproduce

- **`compacting` phase.** `derive_phase` in Rust returns only `idle`/`running`/`waiting`; the
  `compacting` value in `SessionPhase` is set elsewhere (not in the tailer), so there is nothing
  in `transcript.rs` to port. Flagged rather than invented — if a lane should ever show
  `compacting`, that logic is not in this module and S1 does not add it.
- **The tray menu.** `refresh_tray_menu` (L1160) rebuilds a macOS tray listing live sessions.
  Out of scope for S1 (it is shell chrome, not the session model) and there is no tray in the
  Electron build yet.
- **`start_tailer`'s own 1 s loop** is present (`Transcript.start`), but the app currently drives
  it from `index.ts`; the Rust owns the thread. Same cadence, different owner — no behavioural
  difference, noted because the brief asked for behaviour-for-behaviour.
- **The image cache** (`extract_user_images` → `~/.operator/img-cache`) is ported as
  `cacheImage()` but is **not yet called from the user path** — `applyUser` records
  `images: []`. No transcript in the corpus exercised it, so wiring it blind would have been
  untested code. Listed as a known gap rather than claimed.

## Reproducing

```sh
cd electron && npm run probe:s1      # all three probes
npm test && npm run typecheck
```

The probes read the real `~/.operator/chat.db` and `~/.claude/projects` — the chat probe works on
a copy, and the tailer probe symlinks the transcript directory into a sandboxed `HOME` and only
ever reads.
