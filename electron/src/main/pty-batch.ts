// Coalesce a pty's output into fewer IPC messages.
//
// node-pty hands over one read at a time, and a read on macOS is at most 1024 bytes. Forwarded one
// read per `webContents.send`, a lane printing Claude Code's output at a few hundred KB/s costs
// the main process and the renderer several hundred messages a second (measured 2026-09-25:
// 463 msg/s at 320 KB/s for 4 shells, dev/results/perf-baseline-2026-09-25.md). The renderer
// paints once per frame whatever the message count, so a message per read buys nothing.
//
// So each terminal buffers its reads and sends them as one message when the first buffered read
// is FLUSH_MS old, or at once when the buffer reaches FLUSH_BYTES. The timer starts at the first
// read after a flush and is not pushed back by later reads, so a steady stream still goes out every
// FLUSH_MS rather than waiting for a pause. Bytes are concatenated in arrival order and never
// split or re-encoded, so the renderer receives the same byte stream in fewer pieces.
//
// ORDER AGAINST EXIT is the caller's half: it must `close()` before it reports the exit, and
// `flush()` before it starts killing the process, so no output arrives after, or is lost with,
// the exit event.

/** How long the first buffered read waits for company. About one frame at 60 Hz: the renderer
 *  cannot show output sooner than its next paint anyway. */
export const FLUSH_MS = 16

/** Send at once past this size, so a flood (`cat` of a large file) is not held in main memory
 *  and delivered as one oversized message. */
export const FLUSH_BYTES = 64 * 1024

export interface BatchTimers {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

const realTimers: BatchTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as NodeJS.Timeout),
}

export class OutputBatcher {
  private chunks: Buffer[] = []
  private bytes = 0
  private timer: unknown = null
  private closed = false

  constructor(
    private readonly sink: (data: Buffer) => void,
    private readonly timers: BatchTimers = realTimers,
    private readonly flushMs = FLUSH_MS,
    private readonly flushBytes = FLUSH_BYTES,
  ) {}

  push(chunk: Buffer): void {
    if (!chunk.length) return
    this.chunks.push(chunk)
    this.bytes += chunk.length
    // After `close()` there is no timer left to wait for: pass each read straight through, in order.
    if (this.closed || this.bytes >= this.flushBytes) {
      this.flush()
      return
    }
    if (this.timer === null) this.timer = this.timers.set(() => { this.timer = null; this.flush() }, this.flushMs)
  }

  /** Send whatever is buffered now, as one message. A no-op when nothing is. */
  flush(): void {
    if (this.timer !== null) {
      this.timers.clear(this.timer)
      this.timer = null
    }
    if (!this.chunks.length) return
    const data = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.bytes)
    this.chunks = []
    this.bytes = 0
    this.sink(data)
  }

  /** Flush, and stop batching: the process has exited, so any read that still arrives is sent as
   *  it comes rather than left on a timer that could fire after the exit was reported. */
  close(): void {
    this.flush()
    this.closed = true
  }
}
