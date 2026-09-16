import { describe, it, expect } from 'vitest'
import { createHiddenOutputBuffer } from './hidden-output'

// A pty-like stream: colored lines and cursor moves, the shape Claude Code draws with.
function ptyStream(minBytes: number): string {
  let out = ''
  let i = 0
  while (out.length < minBytes) {
    out += `\x1b[38;5;239mconst dark = ${i}\x1b[0m\r\n\x1b[2A\x1b[2K\x1b[1B`
    i++
  }
  return out
}

// Chunk sizes that cut the stream at arbitrary offsets, many of them inside escape sequences.
function chunk(s: string): string[] {
  const sizes = [7, 1, 13, 4096, 3, 65_536, 2, 511, 9]
  const chunks: string[] = []
  let at = 0
  let k = 0
  while (at < s.length) {
    const n = sizes[k++ % sizes.length]
    chunks.push(s.slice(at, at + n))
    at += n
  }
  return chunks
}

describe('createHiddenOutputBuffer', () => {
  it('delivers every byte, in order, when hidden output exceeds the cap', () => {
    const cap = 512_000
    const produced = ptyStream(cap * 3 + 12_345)
    const chunks = chunk(produced)
    expect(chunks.some((c) => c.endsWith('\x1b[38') || c.endsWith('\x1b'))).toBe(true) // escapes really are split

    const received: string[] = []
    const buf = createHiddenOutputBuffer(cap, (d) => received.push(d))
    for (const c of chunks) buf.push(c)
    expect(received.length).toBeGreaterThan(0) // the cap was hit while hidden
    received.push(buf.take()) // the pane activates

    expect(received.join('')).toBe(produced)
  })

  it('holds output below the cap without writing', () => {
    const received: string[] = []
    const buf = createHiddenOutputBuffer(100, (d) => received.push(d))
    buf.push('\x1b[38;5')
    buf.push(';239mhi')
    expect(received).toEqual([])
    expect(buf.take()).toBe('\x1b[38;5;239mhi')
    expect(buf.take()).toBe('')
  })
})
