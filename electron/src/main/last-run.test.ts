import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LastRunRecorder, parseLastRun, judgePreviousRun, shouldAutoResume, withLateReleases, processIsRunning,
  withBootLock, CRASH_LOOP_MS, type LastRun, type LiveLane,
} from './last-run'

// --- TerminalManager's real lane table, with node-pty and the probes faked --------------------

type FakePty = { pid: number; exit: (code: number) => void }
const ptys: FakePty[] = []

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/tmp', getPath: () => '/tmp' } }))
vi.mock('node-pty', () => ({
  spawn: () => {
    let onExit: (e: { exitCode: number; signal?: number }) => void = () => {}
    const p = {
      pid: 0,
      onData: () => {},
      onExit: (cb: typeof onExit) => { onExit = cb },
      exit: (code: number) => onExit({ exitCode: code }),
      kill: () => {},
      write: () => {},
      resize: () => {},
    }
    ptys.push(p as unknown as FakePty)
    return p
  },
}))
vi.mock('./reap', async (orig) => ({
  ...(await orig<typeof import('./reap')>()),
  snapshotPs: async () => [],
  sweepTagged: async () => [],
}))
vi.mock('./port-alloc', async (orig) => ({
  ...(await orig<typeof import('./port-alloc')>()),
  allocatePort: async () => ({ port: undefined, shared: false }),
}))
vi.mock('./preview-cdp-port', async (orig) => ({
  ...(await orig<typeof import('./preview-cdp-port')>()),
  isElectronProject: async () => false,
}))
vi.mock('./session-settings', async (orig) => ({
  ...(await orig<typeof import('./session-settings')>()),
  writeSessionSettings: () => null,
}))
vi.mock('./login-shell', () => ({ loginShell: () => '/bin/sh' }))

let dir: string
let file: string
const SELF = { pid: 4242, startedAt: '2026-10-06T15:00:00.000Z' }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'last-run-'))
  file = join(dir, 'last-run.json')
  ptys.length = 0
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const read = (): LastRun => parseLastRun(readFileSync(file, 'utf8'))!
const dead = async () => false

function record(over: Partial<LastRun> = {}): LastRun {
  return {
    v: 1, appPid: 1250, appStartedAt: '2026-09-29T19:41:29.000Z', clean: false,
    lanes: [
      { key: 'k-qa', terminalId: 't60', cwd: '/r', claudeSessionId: 'c1', startedAt: '2026-10-01T00:00:00.000Z' },
      { key: 'k-code', terminalId: 't128', cwd: '/r-wt', claudeSessionId: 'c2', startedAt: '2026-10-02T00:00:00.000Z' },
    ],
    released: [],
    updatedAt: '2026-10-06T15:13:09.000Z',
    ...over,
  }
}

async function managerWithRecorder(openReleases: Set<string> = new Set()) {
  const { TerminalManager } = await import('./terminals')
  let rec: LastRunRecorder | null = null
  const tm = new TerminalManager(() => {}, () => {}, () => { void rec?.sync() })
  rec = new LastRunRecorder({ file, self: SELF, lanes: () => tm.liveLanes(), openReleases: () => openReleases })
  await rec.open({ isRunning: dead })
  const lane = async (key: string) => {
    const r = await tm.spawn({ cwd: dir, args: [], sessionId: `s-${key}`, tuiMode: 'default', colorScheme: 'dark', laneKey: key, projectId: 'p', roleId: key })
    tm.start(r.terminalId, 80, 24)
    return { id: r.terminalId, pty: ptys[ptys.length - 1] }
  }
  return { tm, rec: rec!, lane }
}

describe('last-run.json lifecycle, from the live pty table', () => {
  it('a spawned lane is recorded, and the run is not clean while it runs', async () => {
    const { rec, lane } = await managerWithRecorder()
    await lane('k-a')
    await rec.sync()
    const r = read()
    expect(r.clean).toBe(false)
    expect(r.appPid).toBe(SELF.pid)
    expect(r.lanes.map((l) => [l.key, l.claudeSessionId, l.projectId, l.roleId])).toEqual([['k-a', 's-k-a', 'p', 'k-a']])
  })

  it('a lane that ends on its own leaves the file', async () => {
    const { rec, lane } = await managerWithRecorder()
    await lane('k-a')
    const b = await lane('k-b')
    b.pty.exit(0)
    await rec.sync()
    expect(read().lanes.map((l) => l.key)).toEqual(['k-a'])
  })

  it('a lane the renderer closes (kill outside quit) leaves the file', async () => {
    const { tm, rec, lane } = await managerWithRecorder()
    await lane('k-a')
    const b = await lane('k-b')
    await tm.kill(b.id)
    await rec.sync()
    expect(read().lanes.map((l) => l.key)).toEqual(['k-a'])
  })

  it('killAll at quit keeps every lane, and teardown marks the run clean', async () => {
    const { tm, rec, lane } = await managerWithRecorder()
    await lane('k-a')
    await lane('k-b')
    rec.freeze() // teardown starts
    await tm.killAll()
    for (const p of ptys) p.exit(0) // the kills' exits arrive
    await rec.sync()
    expect(read().clean).toBe(false)
    await rec.finish()
    const r = read()
    expect(r.clean).toBe(true)
    expect(r.lanes.map((l) => l.key)).toEqual(['k-a', 'k-b'])
    expect(tm.liveLanes()).toEqual([])
  })

  it('a crash leaves clean:false with the lanes that were running', async () => {
    const { rec, lane } = await managerWithRecorder()
    await lane('k-a')
    const b = await lane('k-b')
    await rec.sync()
    b.pty.exit(1) // ended on its own before the crash
    await rec.sync()
    // …and the process dies here: no freeze, no finish.
    const r = read()
    expect(r.clean).toBe(false)
    expect(r.lanes.map((l) => l.key)).toEqual(['k-a'])
  })

  it('a lane that called worktree_done leaves the lanes and is listed as released; a cancelled release puts it back', async () => {
    const open = new Set<string>()
    const { rec, lane } = await managerWithRecorder(open)
    const a = await lane('k-a')
    await lane('k-b')
    open.add(a.id)
    await rec.sync()
    expect(read().lanes.map((l) => l.key)).toEqual(['k-b'])
    expect(read().released.map((r) => r.key)).toEqual(['k-a'])
    open.delete(a.id) // new work cancelled the release
    await rec.sync()
    expect(read().lanes.map((l) => l.key).sort()).toEqual(['k-a', 'k-b'])
    expect(read().released).toEqual([])
  })

  it('a released lane stays released after its pty is gone, through quit', async () => {
    const open = new Set<string>()
    const { tm, rec, lane } = await managerWithRecorder(open)
    const a = await lane('k-a')
    open.add(a.id)
    await rec.sync()
    a.pty.exit(0)
    open.delete(a.id) // main settled the release on exit
    await rec.sync()
    rec.freeze()
    await tm.killAll()
    await rec.finish()
    expect(read().lanes).toEqual([])
    expect(read().released.map((r) => r.key)).toEqual(['k-a'])
  })

  it('a scratch shell is not a lane', async () => {
    const { tm, rec } = await managerWithRecorder()
    tm.spawnShell(dir)
    await rec.sync()
    expect(read().lanes).toEqual([])
  })
})

describe('the next boot', () => {
  const recorder = (self = SELF, lanes: LiveLane[] = []) =>
    new LastRunRecorder({ file, self, lanes: () => lanes, openReleases: () => new Set() })

  it('a crashed run is unclean, and its lanes are handed out for auto-resume exactly once, oldest first', async () => {
    writeFileSync(file, JSON.stringify(record()))
    const rec = recorder()
    expect(await rec.open({ isRunning: dead })).toBe('unclean')
    const first = rec.previousRun()!
    expect(first.clean).toBe(false)
    expect(first.autoResume).toBe(true)
    expect(first.lanes.map((l) => l.key)).toEqual(['k-qa', 'k-code'])
    // A renderer reload asks again: same lanes, no second auto-resume.
    expect(rec.previousRun()!.autoResume).toBe(false)
    await rec.sync()
    // This run claimed the file, and says it auto-resumed (the crash-loop guard reads that).
    expect(read().appPid).toBe(SELF.pid)
    expect(read().crashResumed).toBe(true)
  })

  it('the crash-loop flag clears once the auto-resuming run has lived CRASH_LOOP_MS', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      writeFileSync(file, JSON.stringify(record()))
      const rec = recorder()
      await rec.open({ isRunning: dead })
      expect(rec.previousRun()!.autoResume).toBe(true)
      await rec.sync()
      expect(read().crashResumed).toBe(true) // a crash now would be a crash loop
      vi.advanceTimersByTime(CRASH_LOOP_MS)
      await rec.sync()
      expect(read().crashResumed).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a clean quit is offered, not resumed', async () => {
    writeFileSync(file, JSON.stringify(record({ clean: true })))
    const rec = recorder()
    expect(await rec.open({ isRunning: dead })).toBe('clean')
    expect(rec.previousRun()).toMatchObject({ clean: true, autoResume: false })
  })

  it('no file: nothing from main, the renderer uses its own snapshot', async () => {
    const rec = recorder()
    expect(await rec.open({ isRunning: dead })).toBe('none')
    expect(rec.previousRun()).toBeNull()
    expect(existsSync(file)).toBe(true) // claimed for this run
  })

  it('the app that wrote it still running: not a crash, and the file is left to it', async () => {
    const body = JSON.stringify(record())
    writeFileSync(file, body)
    const rec = new LastRunRecorder({ file, self: SELF, lanes: () => [{ terminalId: 't0', key: 'mine', cwd: '/x', startedAt: 'x' }], openReleases: () => new Set() })
    expect(await rec.open({ isRunning: async () => true })).toBe('other-instance')
    expect(rec.previousRun()).toBeNull()
    await rec.sync()
    expect(readFileSync(file, 'utf8')).toBe(body)
  })

  it('two boots racing over one crashed record: exactly one reads it as a crash', async () => {
    writeFileSync(file, JSON.stringify(record()))
    const a = recorder({ pid: 5001, startedAt: '2026-10-06T15:29:00.000Z' })
    const b = recorder({ pid: 5002, startedAt: '2026-10-06T15:29:00.500Z' })
    // Only the crashed app (1250) is dead; each new boot sees the other as running.
    const isRunning = async (pid: number) => pid !== 1250
    const verdicts = await Promise.all([a.open({ isRunning }), b.open({ isRunning })])
    expect([...verdicts].sort()).toEqual(['other-instance', 'unclean'])
    const owner = verdicts[0] === 'unclean' ? a : b
    expect([a, b].filter((r) => r.previousRun()?.autoResume)).toStrictEqual([owner])
    expect([a, b].map((r) => r === owner)).toContain(true)
    await owner.sync() // the auto-resume note's write
    expect(existsSync(`${file}.lock`)).toBe(false)
  })

  it('a lane that released after the last write is caught from that run\'s release rows', async () => {
    writeFileSync(file, JSON.stringify(record()))
    const rec = recorder()
    await rec.open({
      isRunning: dead,
      releasesOf: (pid, since) => {
        expect([pid, since]).toEqual(['1250', '2026-09-29T19:41:29.000Z'])
        return [
          { terminalId: 't128', at: '2026-10-06T15:14:00.000Z', outcome: null },
          { terminalId: 't60', at: '2026-10-06T15:14:00.000Z', outcome: 'cancelled: new work after release' },
        ]
      },
    })
    const info = rec.previousRun()!
    expect(info.lanes.map((l) => l.key)).toEqual(['k-qa'])
    expect(info.released).toEqual(['k-code'])
    await rec.sync() // the auto-resume note's write
  })

  it('a stale lock from a boot that died does not stop this one', async () => {
    writeFileSync(`${file}.lock`, '999999') // no such pid
    expect(await withBootLock(file, async () => 'ran', { waitMs: 100 })).toBe('ran')
  })
})

describe('the clean/unclean decision', () => {
  it('judgePreviousRun', () => {
    expect(judgePreviousRun(null, SELF, false)).toBe('none')
    expect(judgePreviousRun(record({ clean: true }), SELF, false)).toBe('clean')
    expect(judgePreviousRun(record(), SELF, false)).toBe('unclean')
    expect(judgePreviousRun(record(), SELF, true)).toBe('other-instance')
    expect(judgePreviousRun(record({ clean: true }), SELF, true)).toBe('other-instance')
  })

  it('shouldAutoResume: unclean with lanes only, and not after a run that crashed soon after auto-resuming', () => {
    expect(shouldAutoResume(record(), 'unclean')).toBe(true)
    expect(shouldAutoResume(record({ clean: true }), 'clean')).toBe(false)
    expect(shouldAutoResume(record({ lanes: [] }), 'unclean')).toBe(false)
    expect(shouldAutoResume(record({ crashResumed: true }), 'unclean')).toBe(false)
  })

  it('withLateReleases ignores a release filed before the lane started (a reused terminal id)', () => {
    const r = withLateReleases(record(), [{ terminalId: 't60', at: '2026-09-30T00:00:00.000Z', outcome: 'removed' }])
    expect(r.lanes.map((l) => l.key)).toEqual(['k-qa', 'k-code'])
  })

  it('processIsRunning: a recycled pid with another start time is not the recorded app', async () => {
    const self = process.pid // alive
    const lstart = (iso: string) => async () => new Date(iso).toString()
    expect(await processIsRunning(self, '2026-10-06T15:00:00.000Z', lstart('2026-10-06T15:00:03.000Z'))).toBe(true)
    expect(await processIsRunning(self, '2026-10-06T15:00:00.000Z', lstart('2026-08-12T09:00:00.000Z'))).toBe(false)
    expect(await processIsRunning(self, '2026-10-06T15:00:00.000Z', async () => '')).toBe(false)
    expect(await processIsRunning(self, '2026-10-06T15:00:00.000Z', async () => { throw new Error('no ps') })).toBe(true)
    expect(await processIsRunning(999999, '2026-10-06T15:00:00.000Z', lstart('2026-10-06T15:00:00.000Z'))).toBe(false)
  })
})
