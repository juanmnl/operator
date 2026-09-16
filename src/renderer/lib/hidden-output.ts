// Output that arrives for a HIDDEN terminal pane is held here instead of written to xterm,
// because xterm renders even when not visible and several background panes rendering at once
// overloaded WKWebView and corrupted the VISIBLE pane (eafc0e6).
//
// No byte may ever be dropped. A pty stream is one continuous program: dropping the oldest
// chunks once a cap was hit split escape sequences (a lane showed a literal `;239mconst …`,
// the head `ESC[38;5` gone) and lost cursor moves, so every later redraw landed on the wrong
// rows. When the held output reaches `cap`, it is written to xterm in full, in order, while
// the pane is still hidden. That costs one parse per `cap` bytes of background output, which
// keeps the load bound the buffer exists for.

export interface HiddenOutputBuffer {
  /** Hold `data`; writes everything held (including `data`) once the total reaches the cap. */
  push: (data: string) => void
  /** Everything held, in order, and clears the buffer. */
  take: () => string
}

export function createHiddenOutputBuffer(cap: number, write: (data: string) => void): HiddenOutputBuffer {
  let chunks: string[] = []
  let len = 0
  const take = () => {
    const buf = chunks.join('')
    chunks = []
    len = 0
    return buf
  }
  return {
    push: (data) => {
      chunks.push(data)
      len += data.length
      if (len >= cap) write(take())
    },
    take,
  }
}
