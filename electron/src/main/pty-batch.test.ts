import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OutputBatcher, FLUSH_MS, FLUSH_BYTES } from './pty-batch'

// --- the batcher on its own ------------------------------------------------------------------

describe('OutputBatcher', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const make = () => {
    const sent: string[] = []
    const b = new OutputBatcher((buf) => sent.push(buf.toString('latin1')))
    return { b, sent }
  }

  it('sends reads that arrive within one window as ONE message, in arrival order', () => {
    const { b, sent } = make()
    for (const s of ['a', 'b', 'c', 'd']) b.push(Buffer.from(s))
    expect(sent).toEqual([])
    vi.advanceTimersByTime(FLUSH_MS)
    expect(sent).toEqual(['abcd'])
  })

  it('times the window from the FIRST read, so a steady stream still goes out every window', () => {
    const { b, sent } = make()
    // One read every 4 ms for 40 ms: a debounce that restarted on each read would send nothing.
    for (let i = 0; i < 10; i++) { b.push(Buffer.from(String(i))); vi.advanceTimersByTime(4) }
    vi.advanceTimersByTime(FLUSH_MS)
    expect(sent.join('')).toBe('0123456789') // nothing lost, nothing reordered…
    expect(sent.length).toBeGreaterThanOrEqual(2) // …and it did not wait for the stream to stop
    expect(sent.length).toBeLessThanOrEqual(4)
  })

  it('keeps order across windows', () => {
    const { b, sent } = make()
    b.push(Buffer.from('1')); b.push(Buffer.from('2'))
    vi.advanceTimersByTime(FLUSH_MS)
    b.push(Buffer.from('3'))
    vi.advanceTimersByTime(FLUSH_MS)
    expect(sent).toEqual(['12', '3'])
  })

  it('sends at once when the buffer reaches the size cap, without waiting for the timer', () => {
    const { b, sent } = make()
    const read = Buffer.alloc(1024, 0x41)
    for (let i = 0; i < FLUSH_BYTES / 1024 - 1; i++) b.push(read)
    expect(sent).toEqual([])
    b.push(read) // the read that reaches 64 KB
    expect(sent).toHaveLength(1)
    expect(sent[0].length).toBe(FLUSH_BYTES)
    // The flush cleared the timer: nothing more goes out when it would have fired.
    vi.advanceTimersByTime(FLUSH_MS)
    expect(sent).toHaveLength(1)
  })

  it('a single read larger than the cap goes out whole, not split', () => {
    const { b, sent } = make()
    b.push(Buffer.alloc(FLUSH_BYTES * 2, 0x42))
    expect(sent).toHaveLength(1)
    expect(sent[0].length).toBe(FLUSH_BYTES * 2)
  })

  it('never splits or alters bytes: a multibyte character across two reads arrives intact', () => {
    const got: Buffer[] = []
    const b = new OutputBatcher((buf) => got.push(buf))
    const euro = Buffer.from('€', 'utf8') // e2 82 ac
    b.push(euro.subarray(0, 2)); b.push(euro.subarray(2))
    vi.advanceTimersByTime(FLUSH_MS)
    expect(Buffer.concat(got).toString('utf8')).toBe('€')
  })

  it('flush() sends what is buffered now and cancels the pending timer', () => {
    const { b, sent } = make()
    b.push(Buffer.from('x'))
    b.flush()
    expect(sent).toEqual(['x'])
    vi.advanceTimersByTime(FLUSH_MS)
    expect(sent).toEqual(['x'])
    b.flush() // nothing buffered: no empty message
    expect(sent).toEqual(['x'])
  })

  it('close() flushes, then passes later reads straight through with no timer', () => {
    const { b, sent } = make()
    b.push(Buffer.from('before'))
    b.close()
    expect(sent).toEqual(['before'])
    b.push(Buffer.from('late'))
    expect(sent).toEqual(['before', 'late'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores an empty read', () => {
    const { b, sent } = make()
    b.push(Buffer.alloc(0))
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(FLUSH_MS)
    expect(sent).toEqual([])
  })
})

// --- wired into TerminalManager, with node-pty faked ---------------------------------------
//
// What matters here is ORDER against the exit event and against a kill: the renderer treats
// `terminal:exit` as the end of the stream, so a flush that landed after it would be output the
// pane never shows, and history that ran ahead of what was sent would be replayed twice.

type FakePty = { pid: number; data: (s: string) => void; exit: (code: number) => void; kill: () => void; write: () => void; resize: () => void }
const ptys: FakePty[] = []

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/tmp', getPath: () => '/tmp' } }))
vi.mock('node-pty', () => ({
  spawn: () => {
    let onData: (s: string) => void = () => {}
    let onExit: (e: { exitCode: number; signal?: number }) => void = () => {}
    const p = {
      pid: 0,
      onData: (cb: typeof onData) => { onData = cb },
      onExit: (cb: typeof onExit) => { onExit = cb },
      data: (s: string) => onData(s),
      exit: (code: number) => onExit({ exitCode: code }),
      kill: () => {},
      write: () => {},
      resize: () => {},
    }
    ptys.push(p as unknown as FakePty)
    return p
  },
}))
// The kill path's process-table reads: empty, so a test kill signals nothing real.
vi.mock('./reap', async (orig) => ({
  ...(await orig<typeof import('./reap')>()),
  snapshotPs: async () => [],
  sweepTagged: async () => [],
}))

describe('TerminalManager output batching', () => {
  beforeEach(() => { vi.useFakeTimers(); ptys.length = 0 })
  afterEach(() => { vi.useRealTimers() })

  async function manager() {
    const { TerminalManager } = await import('./terminals')
    const events: string[] = []
    const tm = new TerminalManager(
      (id, b64) => events.push(`data:${id}:${Buffer.from(b64, 'base64').toString('utf8')}`),
      (id, code) => events.push(`exit:${id}:${code}`),
    )
    const id = tm.spawnShell('/tmp')
    return { tm, events, id, pty: ptys[ptys.length - 1] }
  }

  it('coalesces reads into one message per window', async () => {
    const { events, id, pty } = await manager()
    pty.data('one '); pty.data('two '); pty.data('three')
    expect(events).toEqual([])
    vi.advanceTimersByTime(FLUSH_MS)
    expect(events).toEqual([`data:${id}:one two three`])
  })

  it('flushes buffered output BEFORE reporting the exit, and sends a read after exit as it comes', async () => {
    const { events, id, pty } = await manager()
    pty.data('last words')
    pty.exit(0)
    expect(events).toEqual([`data:${id}:last words`, `exit:${id}:0`])
    pty.data('straggler')
    expect(events).toEqual([`data:${id}:last words`, `exit:${id}:0`, `data:${id}:straggler`])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('flushes buffered output before a kill starts', async () => {
    const { tm, events, id, pty } = await manager()
    pty.data('mid-flight')
    const killing = tm.kill(id)
    expect(events).toEqual([`data:${id}:mid-flight`]) // synchronously, before any signal
    await vi.runAllTimersAsync()
    await killing
  })

  it('history holds exactly what has been sent, never bytes still waiting in the batch', async () => {
    const { tm, id, pty } = await manager()
    pty.data('sent')
    vi.advanceTimersByTime(FLUSH_MS)
    pty.data(' pending')
    // A renderer re-attaching now replays history, then receives the pending flush live.
    expect(Buffer.from(tm.history(id), 'base64').toString('utf8')).toBe('sent')
    vi.advanceTimersByTime(FLUSH_MS)
    expect(Buffer.from(tm.history(id), 'base64').toString('utf8')).toBe('sent pending')
  })

  it('a flood reaches the renderer in cap-sized messages, not one read at a time', async () => {
    const { events, pty } = await manager()
    const read = 'x'.repeat(1024)
    for (let i = 0; i < (FLUSH_BYTES / 1024) * 3; i++) pty.data(read)
    expect(events).toHaveLength(3)
  })
})
