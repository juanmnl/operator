import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LastRunRecorder, parseLastRun, judgePreviousRun, shouldAutoResume, withLateReleases, processIsRunning,
  withBootLock, withCarried, CRASH_LOOP_MS, CRASH_LOOP_MAX_MS, RESUME_MAX_AGE_MS, HEARTBEAT_MS, type LastRun, type LiveLane,
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

  it('killAll at quit keeps every lane, and the run is marked clean before anything is killed', async () => {
    const { tm, rec, lane } = await managerWithRecorder()
    await lane('k-a')
    await lane('k-b')
    await rec.freeze() // teardown starts
    // Review M2: an update install or a logout can end the app during killAll. What is on disk
    // at this point is what the next boot reads.
    expect(read()).toMatchObject({ clean: true, lanes: [{ key: 'k-a' }, { key: 'k-b' }] })
    await tm.killAll()
    for (const p of ptys) p.exit(0) // the kills' exits arrive
    await rec.sync()
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
    await rec.freeze()
    await tm.killAll()
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

// The clock the boot tests run at: 17 minutes after `record()` last wrote.
const NOW = '2026-10-06T15:30:00.000Z'

describe('the next boot', () => {
  const recorder = (self = SELF, lanes: LiveLane[] = []) =>
    new LastRunRecorder({ file, self, lanes: () => lanes, openReleases: () => new Set(), now: () => NOW })

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

  // Review L1: a long resume queue outlasted a guard that counted from the hand-out.
  it('the crash-loop flag holds until CRASH_LOOP_MS after the renderer reports the resume queue finished', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      writeFileSync(file, JSON.stringify(record()))
      const rec = recorder()
      await rec.open({ isRunning: dead })
      expect(rec.previousRun()!.autoResume).toBe(true)
      await rec.sync()
      expect(read().crashResumed).toBe(true) // a crash now would be a crash loop
      vi.advanceTimersByTime(CRASH_LOOP_MS * 3) // the queue is still restoring lanes
      await rec.sync()
      expect(read().crashResumed).toBe(true)
      rec.crashResumeDone()
      vi.advanceTimersByTime(CRASH_LOOP_MS - 1)
      await rec.sync()
      expect(read().crashResumed).toBe(true) // the last lane may still take the app down
      vi.advanceTimersByTime(1)
      await rec.sync()
      expect(read().crashResumed).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('the crash-loop flag still clears after CRASH_LOOP_MAX_MS when the renderer never reports the queue finished', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      writeFileSync(file, JSON.stringify(record()))
      const rec = recorder()
      await rec.open({ isRunning: dead })
      rec.previousRun()
      vi.advanceTimersByTime(CRASH_LOOP_MAX_MS - 1)
      await rec.sync()
      expect(read().crashResumed).toBe(true)
      vi.advanceTimersByTime(1)
      await rec.sync()
      expect(read().crashResumed).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('an unclean record older than RESUME_MAX_AGE_MS is offered, not resumed', async () => {
    const old = new Date(Date.parse(NOW) - RESUME_MAX_AGE_MS - 1000).toISOString()
    writeFileSync(file, JSON.stringify(record({ updatedAt: old })))
    const rec = recorder()
    expect(await rec.open({ isRunning: dead })).toBe('unclean')
    const info = rec.previousRun()!
    expect(info).toMatchObject({ clean: false, autoResume: false })
    expect(info.lanes.map((l) => l.key)).toEqual(['k-qa', 'k-code']) // still on the card
    await rec.sync()
    expect(read().crashResumed).toBeUndefined()
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

// Review M1: boot claimed the file with `lanes: []` before anything had consumed the previous
// record, so a main crash in the first seconds of a run lost the previous run's lanes.
describe('the previous run is carried until the renderer has it', () => {
  const RUN2 = { pid: 5001, startedAt: '2026-10-06T15:29:00.000Z' }
  const RUN3 = { pid: 5002, startedAt: '2026-10-06T15:31:00.000Z' }
  const recorder = (self: { pid: number; startedAt: string }, lanes: () => LiveLane[] = () => []) =>
    new LastRunRecorder({ file, self, lanes, openReleases: () => new Set(), now: () => NOW })
  const keys = (info: { lanes: Array<{ key: string }> } | null) => info?.lanes.map((l) => l.key)

  it('a crash before the hand-out: the next boot still auto-resumes the lanes', async () => {
    writeFileSync(file, JSON.stringify(record()))
    const run2 = recorder(RUN2)
    await run2.open({ isRunning: dead })
    // Run 2's main dies here, before its renderer asked for anything.
    expect(read()).toMatchObject({ appPid: RUN2.pid, clean: false, lanes: [] })
    expect(read().carried?.lanes.map((l) => l.key)).toEqual(['k-qa', 'k-code'])
    const run3 = recorder(RUN3)
    expect(await run3.open({ isRunning: dead })).toBe('unclean')
    const info = run3.previousRun()!
    expect(keys(info)).toEqual(['k-qa', 'k-code'])
    expect(info.autoResume).toBe(true)
    expect(info.lanes.some((l) => l.offerOnly)).toBe(false)
  })

  it('a crash after the hand-out, before the renderer saved them: the next boot offers them', async () => {
    writeFileSync(file, JSON.stringify(record()))
    const run2 = recorder(RUN2)
    await run2.open({ isRunning: dead })
    expect(run2.previousRun()!.autoResume).toBe(true)
    await run2.sync()
    const run3 = recorder(RUN3)
    await run3.open({ isRunning: dead })
    const info = run3.previousRun()!
    expect(keys(info)).toEqual(['k-qa', 'k-code'])
    expect(info.autoResume).toBe(false) // crash loop, and the lanes are offer-only
    expect(info.lanes.every((l) => l.offerOnly)).toBe(true)
  })

  it('a clean quit, then a crash in the first seconds: the lanes are offered, not resumed', async () => {
    writeFileSync(file, JSON.stringify(record({ clean: true })))
    const run2 = recorder(RUN2)
    await run2.open({ isRunning: dead })
    run2.previousRun()
    const run3 = recorder(RUN3)
    expect(await run3.open({ isRunning: dead })).toBe('unclean')
    const info = run3.previousRun()!
    expect(keys(info)).toEqual(['k-qa', 'k-code'])
    expect(info.autoResume).toBe(false)
  })

  it('once the renderer has them, main stops carrying them', async () => {
    writeFileSync(file, JSON.stringify(record()))
    const run2 = recorder(RUN2)
    await run2.open({ isRunning: dead })
    run2.previousRun()
    await run2.previousRunTaken()
    expect(read().carried).toBeUndefined()
    const run3 = recorder(RUN3)
    await run3.open({ isRunning: dead })
    expect(keys(run3.previousRun())).toEqual([])
  })

  it('a carried lane resumed in this run is this run\'s lane, and is not carried again after it exits', async () => {
    writeFileSync(file, JSON.stringify(record()))
    let live: LiveLane[] = []
    const run2 = recorder(RUN2, () => live)
    await run2.open({ isRunning: dead })
    run2.previousRun()
    live = [{ terminalId: 't0', key: 'k-qa', cwd: '/r', startedAt: '2026-10-06T15:29:05.000Z' }]
    await run2.sync()
    expect(read().lanes.map((l) => l.key)).toEqual(['k-qa'])
    expect(read().carried?.lanes.map((l) => l.key)).toEqual(['k-code'])
    live = [] // it ended on its own
    await run2.sync()
    expect(read().lanes).toEqual([])
    expect(read().carried?.lanes.map((l) => l.key)).toEqual(['k-code'])
  })

  it('a clean quit before the renderer had them keeps them in the record', async () => {
    writeFileSync(file, JSON.stringify(record()))
    const run2 = recorder(RUN2)
    await run2.open({ isRunning: dead })
    await run2.freeze()
    expect(read().clean).toBe(true)
    const run3 = recorder(RUN3)
    expect(await run3.open({ isRunning: dead })).toBe('clean')
    expect(keys(run3.previousRun())).toEqual(['k-qa', 'k-code'])
  })

  it('released lanes are carried too, so the next boot does not rebuild their worktrees', async () => {
    writeFileSync(file, JSON.stringify(record({ released: [{ key: 'k-done', at: '2026-10-06T15:00:00.000Z' }] })))
    const run2 = recorder(RUN2)
    await run2.open({ isRunning: dead })
    const run3 = recorder(RUN3)
    await run3.open({ isRunning: dead })
    expect(run3.previousRun()!.released).toEqual(['k-done'])
  })
})

describe('updatedAt stays close to the end of the run', () => {
  it('an unchanged record is rewritten every HEARTBEAT_MS, and not more often', async () => {
    let now = Date.parse('2026-10-06T15:00:00.000Z')
    const rec = new LastRunRecorder({
      file, self: SELF, lanes: () => [{ terminalId: 't0', key: 'k', cwd: '/', startedAt: '' }], openReleases: () => new Set(),
      now: () => new Date(now).toISOString(),
    })
    await rec.open({ isRunning: dead })
    await rec.sync()
    const first = read().updatedAt
    now += HEARTBEAT_MS - 1
    await rec.sync()
    expect(read().updatedAt).toBe(first)
    now += 1
    await rec.sync()
    expect(read().updatedAt).toBe(new Date(now).toISOString())
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

  it('shouldAutoResume: unclean with lanes only, not after a run that crashed soon after auto-resuming, not past the age limit', () => {
    expect(shouldAutoResume(record(), 'unclean', NOW)).toBe(true)
    expect(shouldAutoResume(record({ clean: true }), 'clean', NOW)).toBe(false)
    expect(shouldAutoResume(record({ lanes: [] }), 'unclean', NOW)).toBe(false)
    expect(shouldAutoResume(record({ crashResumed: true }), 'unclean', NOW)).toBe(false)
    const at = (ms: number) => new Date(Date.parse(record().updatedAt) + ms).toISOString()
    expect(shouldAutoResume(record(), 'unclean', at(RESUME_MAX_AGE_MS))).toBe(true)
    expect(shouldAutoResume(record(), 'unclean', at(RESUME_MAX_AGE_MS + 1))).toBe(false)
    expect(shouldAutoResume(record({ updatedAt: 'garbage' }), 'unclean', NOW)).toBe(false)
    // Only offer-only lanes (carried from a clean quit): nothing to resume.
    expect(shouldAutoResume(record({ lanes: record().lanes.map((l) => ({ ...l, offerOnly: true })) }), 'unclean', NOW)).toBe(false)
  })

  it('withCarried: the carried lanes and releases join the record\'s own, without duplicates', () => {
    const r = record({
      lanes: [record().lanes[0]],
      released: [{ key: 'k-rel', at: 'x' }],
      carried: { lanes: [record().lanes[0], record().lanes[1], { key: 'k-rel', terminalId: 't1', cwd: '/', startedAt: '' }], released: [{ key: 'k-old', at: 'y' }] },
    })
    const m = withCarried(r)
    expect(m.lanes.map((l) => l.key)).toEqual(['k-qa', 'k-code'])
    expect(m.released.map((x) => x.key)).toEqual(['k-rel', 'k-old'])
    expect(m.carried).toBeUndefined()
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
