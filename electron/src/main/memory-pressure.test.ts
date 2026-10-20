import { describe, it, expect, vi, afterEach } from 'vitest'
import { MemoryPressureWatcher, parsePressure, fakePressureFile, NORMAL_POLL_MS, ELEVATED_POLL_MS, NORMAL_CONFIRM_MS } from './memory-pressure'

describe('parsing the sysctl reading', () => {
  it('reads the level and the percent available', () => {
    expect(parsePressure('1\n66\n')).toEqual({ level: 1, freePercent: 66 })
    expect(parsePressure('2\n12\n')).toEqual({ level: 2, freePercent: 12 })
    expect(parsePressure('4\n3')).toEqual({ level: 4, freePercent: 3 })
  })

  it('keeps the level when the percent is missing or out of range', () => {
    expect(parsePressure('2\n')).toEqual({ level: 2, freePercent: undefined })
    expect(parsePressure('2\n140\n')).toEqual({ level: 2, freePercent: undefined })
    expect(parsePressure('  4  \n x\n')).toEqual({ level: 4, freePercent: undefined })
  })

  it('refuses a level the kernel does not use, and junk', () => {
    expect(parsePressure('3\n50\n')).toBeNull()
    expect(parsePressure('0\n')).toBeNull()
    expect(parsePressure('')).toBeNull()
    expect(parsePressure('sysctl: unknown oid\n')).toBeNull()
    expect(parsePressure('-1\n')).toBeNull()
  })
})

describe('the dev-only fake level', () => {
  it('is read from the file only in an unpackaged build', () => {
    expect(fakePressureFile(false, { OPERATOR_MEMORY_PRESSURE_FILE: '/tmp/p' })).toBe('/tmp/p')
    expect(fakePressureFile(true, { OPERATOR_MEMORY_PRESSURE_FILE: '/tmp/p' })).toBeNull()
    expect(fakePressureFile(false, {})).toBeNull()
  })
})

describe('the watcher', () => {
  afterEach(() => { vi.useRealTimers() })

  it('reports only changes, and polls faster above normal', async () => {
    vi.useFakeTimers()
    const readings = ['1\n60', '1\n58', '2\n20', '2\n18', '4\n5', '1\n70']
    const sample = vi.fn(async () => readings.shift() ?? '1\n70')
    const seen: number[] = []
    vi.setSystemTime(1000)
    const w = new MemoryPressureWatcher((p) => seen.push(p.level), sample)
    w.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(seen).toEqual([1])
    expect(w.current()).toEqual({ level: 1, freePercent: 60, at: 1000 })

    // Normal: nothing until the next 20 s poll.
    await vi.advanceTimersByTimeAsync(ELEVATED_POLL_MS)
    expect(sample).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(NORMAL_POLL_MS - ELEVATED_POLL_MS)
    expect(sample).toHaveBeenCalledTimes(2)
    expect(seen).toEqual([1])

    await vi.advanceTimersByTimeAsync(NORMAL_POLL_MS)
    expect(seen).toEqual([1, 2])
    // Elevated: every 5 s.
    await vi.advanceTimersByTimeAsync(ELEVATED_POLL_MS)
    expect(sample).toHaveBeenCalledTimes(4)
    expect(seen).toEqual([1, 2])
    expect(w.current()?.freePercent).toBe(18)
    await vi.advanceTimersByTimeAsync(ELEVATED_POLL_MS)
    expect(seen).toEqual([1, 2, 4])
    // Back to normal: reported only once it has held for NORMAL_CONFIRM_MS (review L1).
    await vi.advanceTimersByTimeAsync(ELEVATED_POLL_MS)
    expect(seen).toEqual([1, 2, 4])
    expect(w.current()?.level).toBe(4)
    await vi.advanceTimersByTimeAsync(NORMAL_CONFIRM_MS)
    expect(seen).toEqual([1, 2, 4, 1])
    w.stop()
  })

  it('does not report a drop to normal that lasts less than NORMAL_CONFIRM_MS', async () => {
    vi.useFakeTimers()
    let reading = '2\n20'
    const seen: number[] = []
    const w = new MemoryPressureWatcher((p) => seen.push(p.level), async () => reading)
    w.start()
    await vi.advanceTimersByTimeAsync(0)
    reading = '1\n40'
    await vi.advanceTimersByTimeAsync(NORMAL_CONFIRM_MS - ELEVATED_POLL_MS)
    reading = '2\n18'
    await vi.advanceTimersByTimeAsync(ELEVATED_POLL_MS * 2)
    // The flap never reached the renderer, and the normal stretch starts again from zero.
    reading = '1\n40'
    await vi.advanceTimersByTimeAsync(NORMAL_CONFIRM_MS - ELEVATED_POLL_MS)
    expect(seen).toEqual([2])
    await vi.advanceTimersByTimeAsync(ELEVATED_POLL_MS * 2)
    expect(seen).toEqual([2, 1])
    w.stop()
  })

  it('logs the first failed read and the recovery, not every failure', async () => {
    vi.useFakeTimers()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    let out: string | Error = '2\n20'
    const w = new MemoryPressureWatcher(() => {}, async () => { if (out instanceof Error) throw out; return out })
    w.start()
    await vi.advanceTimersByTimeAsync(0)
    log.mockClear()
    out = new Error('spawn EAGAIN')
    await vi.advanceTimersByTimeAsync(ELEVATED_POLL_MS * 3)
    out = 'garbage'
    await vi.advanceTimersByTimeAsync(ELEVATED_POLL_MS)
    expect(log.mock.calls.map((c) => String(c[0]))).toEqual(['[memory] pressure read failed (spawn EAGAIN); keeping level 2'])
    out = '2\n19'
    await vi.advanceTimersByTimeAsync(ELEVATED_POLL_MS)
    expect(String(log.mock.calls.at(-1)?.[0])).toBe('[memory] pressure read recovered after 4 failed reads')
    w.stop()
    log.mockRestore()
  })

  it('runs one polling loop when started again while a read is in flight', async () => {
    vi.useFakeTimers()
    let resolve!: (s: string) => void
    const sample = vi.fn(() => new Promise<string>((r) => { resolve = r }))
    const w = new MemoryPressureWatcher(() => {}, sample)
    w.start()
    const first = resolve
    w.start()
    first('1\n60')
    resolve('1\n60')
    await vi.advanceTimersByTimeAsync(0)
    sample.mockImplementation(async () => '1\n60')
    const before = sample.mock.calls.length
    await vi.advanceTimersByTimeAsync(NORMAL_POLL_MS * 3)
    expect(sample.mock.calls.length - before).toBe(3)
    w.stop()
  })

  it('keeps the last level when a read fails, and stops cleanly', async () => {
    vi.useFakeTimers()
    let fail = false
    const sample = vi.fn(async () => { if (fail) throw new Error('exec'); return '2\n20' })
    const seen: number[] = []
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const w = new MemoryPressureWatcher((p) => seen.push(p.level), sample)
    w.start()
    await vi.advanceTimersByTimeAsync(0)
    fail = true
    await vi.advanceTimersByTimeAsync(ELEVATED_POLL_MS)
    expect(seen).toEqual([2])
    expect(w.current()?.level).toBe(2)
    w.stop()
    const calls = sample.mock.calls.length
    await vi.advanceTimersByTimeAsync(NORMAL_POLL_MS * 3)
    expect(sample).toHaveBeenCalledTimes(calls)
    log.mockRestore()
  })
})
