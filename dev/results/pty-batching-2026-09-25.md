# pty output batching — 2026-09-25

Branch `operator/d91080`, committed after 9b2bbae. Files: new `electron/src/main/pty-batch.ts` and `pty-batch.test.ts`, edited `electron/src/main/terminals.ts`, measurement harness in `dev/results/pty-batching-2026-09-25-scripts/`.

## Result

| Workload (4 shells) | Messages/s before | Messages/s after | KB/s before → after | Bytes per message before → after |
|---|---|---|---|---|
| Paced: claude-stream.bin (6192 B) every 50 ms per shell | **540.3** (3 runs, identical) | **77.1–77.2** (3 runs) | 474.8 → 474.2–474.8 | 1024 → 6299 |
| Flood: `cat` of the fixture in a loop | **17,437 / 17,617** (2 runs) | **248 / 250** (2 runs) | 15,323–15,482 → 14,705–14,912 | 1024 → median 62,990, max 66,218 |

- Paced workload: 7.0× fewer messages at the same byte rate. Each 50 ms tick now goes out as one message instead of about seven 1024-byte reads.
- Flood: about 70× fewer messages. The timer fires 62.5 times a second per shell and the 64 KB cap trips sometimes (max 66,218). Throughput in the main process is 2–5% lower in these two runs, which is within this harness's run-to-run spread.

### How this was measured, and how it differs from QA's number

- QA's figure (463 msg/s, 320 KB/s, median 800 characters) came from the Electron dev app over CDP. Their pacing script (`real.mjs`) is not in `perf-baseline-2026-09-25-scripts/`, so I rebuilt the workload from their description.
- I did not launch the GUI app. The harness bundles the real `TerminalManager` with esbuild (`electron` aliased to a stub) and runs it under plain Node, with real node-pty (N-API, loads outside Electron) and 4 real login shells from `spawnShell`.
- It counts calls to the data sink. In the app each call is exactly one `webContents.send` (`index.ts` broadcast).
- The chunk size agrees with QA's: node-pty reads at most 1024 bytes, and at the multibyte density of this output that is about 800 characters.
- The absolute rate differs: 540 vs 463 msg/s, and 475 vs 320 KB/s. I count bytes in main; QA counted characters in the renderer, with the app's IPC and a real renderer in the loop.
- Before and after were measured with the same harness on the same machine. Before was built against the pre-change `terminals.ts`.
- Not measured: renderer CPU with batching. With fewer, larger `term.write` calls it should not go up, but that is untested.

## What changed

- **`OutputBatcher` (pty-batch.ts).** It buffers raw bytes per terminal and sends one message when the first buffered read is 16 ms old (`FLUSH_MS`), or at once when the buffer reaches 64 KB (`FLUSH_BYTES`).
  - The timer starts at the first read after a flush. Later reads do not push it back, so a steady stream still goes out every 16 ms instead of waiting for a pause.
  - Bytes are concatenated in arrival order and never split or re-encoded.
  - `close()` flushes and switches to pass-through.
- **terminals.ts.** Each `Managed` has `out: OutputBatcher`, and both `onData` handlers (lanes and plain shells) push into it.
  - **Exit:** `onExit` calls `out.close()` before `this.onExit(...)`, so buffered output always precedes the exit event. A read that arrives after exit is sent straight away.
  - **Kill:** `kill()` calls `out.flush()` synchronously, before `reapAndForget` signals anything.
  - **History is pushed per flush, not per chunk.** Per chunk would be wrong. `history(id)` is what a renderer replays when it re-attaches. If history recorded bytes still waiting in the batch, a re-attach inside the 16 ms window would replay them and then receive them again from the flush. Per flush, history equals exactly what has been sent.
  - `lastActivityAt` is still stamped per read, so `activeWithin` reacts at once.
- **Latency cost.** Output can reach the renderer up to 16 ms later than before, including the echo of a keystroke. The renderer paints on animation frames, so this is up to one extra frame.
  - A leading-edge flush (send the first read after a quiet period at once, batch the rest) would remove the added echo latency.
  - Cost of that option: about one extra message per burst. On the paced workload, about 160 msg/s instead of 77.
  - Not done, because the brief asked for a timer.

## The utf8 path: not a correctness bug, comment corrected

The old comment claimed the renderer's streaming `TextDecoder` "is what stitches a multibyte character split across two pty reads". That is not so:

- node-pty 1.1.0 defaults to `encoding: 'utf8'` and calls `socket.setEncoding('utf8')` (`node_modules/node-pty/lib/unixTerminal.js:64,94-95`). Node's StringDecoder already holds back a split character until the rest arrives.
- Verified with real node-pty. `printf 'A\342\202'; sleep 0.3; printf '\254B\377C'` produced two `onData` chunks, `"A"` and `"€B�C"`. The split `€` was stitched in main, and `Buffer.from(chunk, 'utf8')` returned `e282ac`.
- Invalid bytes (`0xFF`) become U+FFFD in main. The renderer's `new TextDecoder()` (`TerminalPane.tsx:23`, `bridge.ts:77`, non-fatal) would have produced the same U+FFFD. The terminal sees the same text either way.

So there is no bug and no behaviour change; only the comment was rewritten. The round trip is decode in node-pty, then re-encode, then base64, then decode again in the renderer. Passing `encoding: null` would drop one decode and one encode in main. That is a small CPU saving and is not done here.

## Tests (electron/src/main/pty-batch.test.ts, 14)

- **Batcher:**
  - coalesces reads within one window, in order
  - the window runs from the first read, so a steady stream flushes during the stream
  - order is kept across windows
  - the 64 KB cap sends at once and clears the timer
  - a read larger than the cap is sent whole
  - a multibyte character split across reads arrives intact
  - `flush()` sends and cancels, with no empty messages
  - `close()` flushes, then passes later reads through with no timer
  - empty reads are ignored
- **Through `TerminalManager`, with node-pty faked:**
  - coalescing works
  - **buffered output precedes the exit event**, and a straggler after exit is sent at once
  - **output is flushed before a kill signals**
  - history holds only what has been sent
  - a flood arrives in cap-sized messages
- **Mutation checks:**
  - removing `out.close()` from the exit handler fails the exit-order test
  - removing `out.flush()` from `kill()` fails the kill test

## Verification

- `electron`: `npm run typecheck` exit 0; vitest 40 files, 695 tests passed (681 + 14).
- Root: `tsc --noEmit` exit 0; vitest 101 files, 1519 tests passed.
- Not verified in the running app: the Electron app was not launched. The next check is a lane streaming output in the dev app. Its output should look the same, and the renderer should receive about one message per 16 ms per busy lane.
