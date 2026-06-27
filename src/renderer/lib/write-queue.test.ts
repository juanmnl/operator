import { describe, it, expect } from 'vitest'
import { createWriteQueue, chunkString } from './write-queue'

// A send stub that records what it was called with, in call order, and resolves
// after a staggered delay. The stagger would expose any reordering: without the
// FIFO chain, later (shorter-delay) sends could resolve/observe first.
function staggeredSend(record: string[], delayFor: (n: number) => number) {
  let n = 0
  return (data: string) => {
    record.push(data)
    const d = delayFor(n++)
    return new Promise<void>((res) => setTimeout(res, d))
  }
}

describe('chunkString', () => {
  it('returns the input unchanged when within the limit', () => {
    expect(chunkString('hello', 4096)).toEqual(['hello'])
  })

  it('splits into slices no larger than maxChunk and preserves the whole', () => {
    const s = 'x'.repeat(10000)
    const chunks = chunkString(s, 4096)
    expect(chunks.every((c) => c.length <= 4096)).toBe(true)
    expect(chunks.join('')).toBe(s)
  })

  it('never splits a surrogate pair', () => {
    // 5 four-byte emoji (each a UTF-16 surrogate pair) with a tiny chunk size.
    const s = '😀😁😂🤣😃'
    const chunks = chunkString(s, 3)
    expect(chunks.join('')).toBe(s)
    for (const c of chunks) {
      const first = c.charCodeAt(0)
      const last = c.charCodeAt(c.length - 1)
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false) // no leading low surrogate
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false) // no trailing high surrogate
    }
  })
})

describe('createWriteQueue', () => {
  it('sends chunks in enqueue order despite staggered async completion', async () => {
    const record: string[] = []
    // Earlier calls get LONGER delays — if sends ran concurrently the order would
    // scramble. The FIFO must keep them in order.
    const q = createWriteQueue(staggeredSend(record, (n) => 20 - n * 4))
    for (const ch of ['a', 'b', 'c', 'd', 'e']) q.write(ch)
    await q.flush()
    expect(record.join('')).toBe('abcde')
  })

  it('orders a later keystroke after every chunk of an earlier paste', async () => {
    const record: string[] = []
    const q = createWriteQueue(staggeredSend(record, () => 5), { maxChunk: 4 })
    q.write('PASTEPASTE') // 10 chars → 3 chunks at maxChunk 4
    q.write('x')
    await q.flush()
    expect(record.join('')).toBe('PASTEPASTEx')
    expect(record[record.length - 1]).toBe('x')
  })

  it('chunks a large write to the configured maxChunk', async () => {
    const record: string[] = []
    const q = createWriteQueue(staggeredSend(record, () => 0), { maxChunk: 100 })
    const big = 'y'.repeat(450)
    q.write(big)
    await q.flush()
    expect(record.every((c) => c.length <= 100)).toBe(true)
    expect(record.join('')).toBe(big)
  })

  it('isolates a failed send: later writes still run in order', async () => {
    const record: string[] = []
    let n = 0
    const q = createWriteQueue((data) => {
      record.push(data)
      n++
      return n === 2 ? Promise.reject(new Error('dead pty')) : Promise.resolve()
    })
    q.write('a')
    q.write('b') // this send rejects
    q.write('c')
    await q.flush()
    expect(record).toEqual(['a', 'b', 'c'])
  })

  it('tracks pending size and drains to zero', async () => {
    const q = createWriteQueue(() => new Promise<void>((res) => setTimeout(res, 5)), { maxChunk: 2 })
    q.write('abcd') // 2 chunks
    expect(q.size()).toBeGreaterThan(0)
    await q.flush()
    expect(q.size()).toBe(0)
  })
})
