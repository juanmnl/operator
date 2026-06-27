// Ordered, chunked write queue for terminal input. The bridge's terminalWrite
// used to do a fire-and-forget `void invoke('terminal_write')`; two rapid writes
// (fast typing, key autorepeat, a paste interleaving with a drop) started
// independent async IPC trips whose arrival order at the Rust pty mutex was not
// guaranteed → transposed bytes. This serializes writes per terminal: chunk N+1
// is not even issued until N's invoke resolves, so the backend sees them in
// enqueue order regardless of IPC scheduling. Pure (the sender is injected) so
// the ordering is unit-testable without Tauri. See write-queue.test.ts.

export interface WriteQueue {
  /** Enqueue data for the terminal (split into ordered, UTF-8-safe chunks). */
  write(data: string): void
  /** Resolves once everything enqueued so far has been sent. */
  flush(): Promise<void>
  /** Chunks still queued or in flight (for tests / backpressure checks). */
  size(): number
}

/** Split `data` into ≤`maxChunk`-unit slices WITHOUT breaking a surrogate pair.
 *  A lone surrogate isn't valid UTF-8, so a chunk split mid-pair would be
 *  corrupted (U+FFFD) when Tauri serializes it to a Rust String. Bracketed-paste
 *  markers (ESC[200~/ESC[201~) don't need to stay whole: the pty sees an ordered
 *  byte stream, not framed messages, so a marker spanning two chunks is fine. */
export function chunkString(data: string, maxChunk: number): string[] {
  if (data.length <= maxChunk) return [data]
  const chunks: string[] = []
  let i = 0
  while (i < data.length) {
    let end = Math.min(i + maxChunk, data.length)
    // If the boundary lands just after a high surrogate, pull it into the next
    // chunk so the pair stays together.
    if (end < data.length) {
      const c = data.charCodeAt(end - 1)
      if (c >= 0xd800 && c <= 0xdbff) end -= 1
    }
    // Guard a pathologically small maxChunk that can't fit a single pair.
    if (end <= i) end = Math.min(i + 2, data.length)
    chunks.push(data.slice(i, end))
    i = end
  }
  return chunks
}

export function createWriteQueue(
  send: (data: string) => Promise<void>,
  opts: { maxChunk?: number } = {},
): WriteQueue {
  const maxChunk = opts.maxChunk ?? 4096
  let tail: Promise<void> = Promise.resolve()
  let pending = 0

  const enqueue = (chunk: string) => {
    pending++
    // Chain so each send awaits the previous. The `.catch` is INSIDE the chain so
    // a single failed write (a dead pty) drops that one chunk without breaking
    // ordering for everything queued after it.
    tail = tail
      .then(() => send(chunk))
      .catch(() => { /* dropped write; the rest of the queue still runs in order */ })
      .then(() => { pending-- })
  }

  return {
    write(data) {
      if (!data) return
      for (const chunk of chunkString(data, maxChunk)) enqueue(chunk)
    },
    flush() {
      return tail
    },
    size() {
      return pending
    },
  }
}
