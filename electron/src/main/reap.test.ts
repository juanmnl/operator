import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  parsePsTable, descendantsOf, pgidsFor, selfPgidFrom,
  parseTaggedTable, envTag, staleTaggedRows,
  laneStrays, expandStrays, reapTree,
} from './reap'

// A fake `ps -axo pid,ppid,pgid,command` table modelled on the real orphan snapshot in
// `dev/results/devserver-orphans-research.md`:
//
//   400 electron (us)            — our own group, must never be signalled
//   500 login shell              — the ONLY pid TerminalManager has ever known
//   501  └ claude                — same group as the shell
//   600  └ npm exec vite         — job control put it in its OWN group (600)
//   601     └ node vite          — group 600
//   602        └ esbuild         — group 600
//   700 an unrelated user process
//
// 600/601/602 are the orphans: a single-pid kill of 500 leaves all three running, which is
// exactly the shape of the ~20 live strays the research found.
const PS_TABLE = `  PID  PPID  PGID COMMAND
  400   399   400 /Applications/Operator.app/Contents/MacOS/Operator
  500     1   500 -zsh
  501   500   500 claude --settings {"tui":"default"}
  600   501   600 npm exec vite --port 1422 --strictPort
  601   600   600 node /w/node_modules/.bin/vite --port 1422 --strictPort
  602   601   600 esbuild --service=0.21.5 --ping
  700     1   700 /usr/bin/some-unrelated-thing
`

describe('parsePsTable', () => {
  it('drops the header and keeps the command column intact, spaces and all', () => {
    const rows = parsePsTable(PS_TABLE)
    expect(rows).toHaveLength(7)
    expect(rows[0]).toEqual({ pid: 400, ppid: 399, pgid: 400, command: '/Applications/Operator.app/Contents/MacOS/Operator' })
    expect(rows[3].command).toBe('npm exec vite --port 1422 --strictPort')
  })

  it('skips malformed rows instead of throwing — this runs on the quit path', () => {
    expect(parsePsTable('garbage\n\n  1 2\n  10 11 12 ok\n')).toEqual([
      { pid: 10, ppid: 11, pgid: 12, command: 'ok' },
    ])
  })

  it('reads an empty table as no rows', () => {
    expect(parsePsTable('')).toEqual([])
  })
})

describe('descendantsOf — the tree walk', () => {
  const rows = parsePsTable(PS_TABLE)

  it('collects the WHOLE tree under the login shell, across group boundaries', () => {
    // The point of the fix: 600/601/602 are in a different process group from the shell, and
    // are found anyway because at snapshot time they are still attached to it by ppid.
    expect([...descendantsOf(rows, 500)].sort((a, b) => a - b)).toEqual([500, 501, 600, 601, 602])
  })

  it('includes the root itself, so the shell is never dropped from the set', () => {
    expect(descendantsOf(rows, 600).has(600)).toBe(true)
  })

  it('walks from an interior node without reaching back up to its parent', () => {
    expect([...descendantsOf(rows, 601)].sort((a, b) => a - b)).toEqual([601, 602])
  })

  it('never walks from pid 1 — every orphan re-parents to launchd, and that is the whole machine', () => {
    expect(descendantsOf(rows, 1).size).toBe(0)
    expect(descendantsOf(rows, 0).size).toBe(0)
  })

  it('returns empty for a pid that is already gone', () => {
    expect(descendantsOf(rows, 99999).size).toBe(0)
  })

  it('ignores a non-integer root rather than walking something arbitrary', () => {
    expect(descendantsOf(rows, Number.NaN).size).toBe(0)
  })

  it('terminates on a cyclic table — a ps snapshot is not a consistent instant', () => {
    // 10 → 11 → 10. Without the seen-set this loops forever and hangs the quit path.
    const cyclic = parsePsTable('  10 11 10 a\n  11 10 10 b\n')
    expect([...descendantsOf(cyclic, 10)].sort((a, b) => a - b)).toEqual([10, 11])
  })
})

describe('pgidsFor — what actually gets signalled', () => {
  const rows = parsePsTable(PS_TABLE)

  it('collapses the tree to its DISTINCT groups: one kill(-pgid) reaches vite and esbuild both', () => {
    expect(pgidsFor(rows, descendantsOf(rows, 500))).toEqual([500, 600])
  })

  it('EXCLUDES our own process group — reaching that kills Operator itself mid-quit', () => {
    const withUs = new Set([400, 500, 600])
    expect(pgidsFor(rows, withUs, 400)).toEqual([500, 600])
    // …and without the guard it would have been in the list, which is the point of the test.
    expect(pgidsFor(rows, withUs)).toEqual([400, 500, 600])
  })

  it('excludes pgid 0 and 1 — kill(0, …) means "my own group" and 1 is launchd', () => {
    const dangerous = parsePsTable('  50 1 0 a\n  51 1 1 b\n  52 1 52 c\n')
    expect(pgidsFor(dangerous, new Set([50, 51, 52]))).toEqual([52])
  })

  it('ignores pids that are not in the set', () => {
    expect(pgidsFor(rows, new Set([700]))).toEqual([700])
    expect(pgidsFor(rows, new Set())).toEqual([])
  })
})

describe('selfPgidFrom', () => {
  const rows = parsePsTable(PS_TABLE)
  it('finds our group in the same snapshot — Node exposes getpgid nowhere', () => {
    expect(selfPgidFrom(rows, 400)).toBe(400)
  })
  it('is undefined when we are somehow not in the table, which disables the guard rather than misfiring it', () => {
    expect(selfPgidFrom(rows, 12345)).toBeUndefined()
  })
})

// `ps -eww -o pid,pgid,command -E` — argv and the whole environment run together on one line.
const TAGGED = `  PID  PGID COMMAND
  600   600 npm exec vite --port 1422 PATH=/usr/bin OPERATOR_TERMINAL_ID=t3 OPERATOR_DEV_PORT=1422 OPERATOR_APP_PID=400 SHELL=/bin/zsh
  601   600 node vite --port 1422 OPERATOR_TERMINAL_ID=t3 OPERATOR_DEV_PORT=1422 OPERATOR_APP_PID=400
  800   800 npm exec vite --port 1423 OPERATOR_TERMINAL_ID=t0 OPERATOR_DEV_PORT=1423 OPERATOR_APP_PID=999
  900   900 some-old-build OPERATOR_TERMINAL_ID=t1
  700   700 /usr/bin/some-unrelated-thing PATH=/usr/bin
`

describe('envTag', () => {
  it('reads a value out of a ps -E row', () => {
    expect(envTag('a b OPERATOR_DEV_PORT=1422 c', 'OPERATOR_DEV_PORT')).toBe('1422')
  })
  it('will not match a key that is only a SUFFIX of another key', () => {
    expect(envTag('NOT_OPERATOR_APP_PID=7', 'OPERATOR_APP_PID')).toBeUndefined()
  })
  it('is undefined when the key is absent', () => {
    expect(envTag('PATH=/usr/bin', 'OPERATOR_TERMINAL_ID')).toBeUndefined()
  })
  it('reads an empty value as empty rather than as absent', () => {
    expect(envTag('X= Y=1', 'X')).toBe('')
  })
})

describe('parseTaggedTable', () => {
  it('keeps only Operator-tagged rows and pulls the three tags out', () => {
    const rows = parseTaggedTable(TAGGED)
    expect(rows.map((r) => r.pid)).toEqual([600, 601, 800, 900])
    expect(rows[0]).toMatchObject({ pid: 600, pgid: 600, terminalId: 't3', devPort: 1422, appPid: 400 })
  })

  it('leaves devPort/appPid undefined on a row from a build that did not set them', () => {
    const old = parseTaggedTable(TAGGED).find((r) => r.pid === 900)!
    expect(old.terminalId).toBe('t1')
    expect(old.devPort).toBeUndefined()
    expect(old.appPid).toBeUndefined()
  })
})

// The rows that made the naive rule untenable, taken verbatim in shape from a live
// `ps -eww -o pid,pgid,command -E` sweep of this machine. EVERY one of these carries
// `OPERATOR_TERMINAL_ID`, because a lane's env is inherited by everything it ever starts —
// including the app itself, when the app was launched from a tagged shell.
const NOT_ORPHANS = `  PID  PGID COMMAND
 93190 93190 /Applications/Operator.app/Contents/MacOS/Operator OPERATOR_TERMINAL_ID=t0 OPERATOR_DEV_PORT=1420
 93276 93276 claude OPERATOR_TERMINAL_ID=t0 OPERATOR_DEV_PORT=1420
  9061  9061 postgres -D /opt/homebrew/var/postgresql@16 -p 5433 OPERATOR_TERMINAL_ID=t0 OPERATOR_DEV_PORT=1420
`

describe('staleTaggedRows — the guard that decides what may be signalled at all', () => {
  const rows = parseTaggedTable(TAGGED)
  // 400 is a DEAD Operator (the one that crashed), 999 is one running right now.
  const isAppAlive = (pid: number) => pid === 999

  it('accepts only rows that name a DEAD Operator in OPERATOR_APP_PID', () => {
    const stale = staleTaggedRows(rows, { selfPid: 111, isAppAlive })
    expect(stale.map((r) => r.pid)).toEqual([600, 601])
  })

  it('never reaps a lane THIS process spawned', () => {
    expect(staleTaggedRows(rows, { selfPid: 400, isAppAlive })).toEqual([])
  })

  it('never reaps a lane belonging to a second Operator running right now', () => {
    expect(staleTaggedRows(rows, { selfPid: 111, isAppAlive }).some((r) => r.pid === 800)).toBe(false)
  })

  // THE TEST THIS MODULE EXISTS FOR. The obvious rule — "tagged, and not obviously ours, so
  // reap it" — kills the running app, its live agents, and the user's database, all of which
  // were found carrying the tag on a real machine. A row with no app tag has an UNPROVABLE
  // owner, and the only safe answer to that is to leave it alone.
  it('REFUSES every untagged row: the running app, a live lane, and a user database all carry the terminal tag', () => {
    const notOrphans = parseTaggedTable(NOT_ORPHANS)
    expect(notOrphans).toHaveLength(3) // they really do all match the sweep
    expect(staleTaggedRows(notOrphans, { selfPid: 111, isAppAlive })).toEqual([])
  })

  it('refuses a row that IS this process, however it got tagged', () => {
    const us = parseTaggedTable('  555 555 Operator OPERATOR_TERMINAL_ID=t0 OPERATOR_APP_PID=1\n')
    expect(staleTaggedRows(us, { selfPid: 555, isAppAlive: () => false })).toEqual([])
  })

  it('spares a terminal id this run is currently running', () => {
    const stale = staleTaggedRows(rows, { selfPid: 111, isAppAlive, liveTerminalIds: new Set(['t3']) })
    expect(stale).toEqual([])
  })

  it('refuses pid/pgid 0 and 1 outright', () => {
    const edge = parseTaggedTable('  1 1 launchd OPERATOR_TERMINAL_ID=t9 OPERATOR_APP_PID=400\n')
    expect(staleTaggedRows(edge, { selfPid: 111, isAppAlive })).toEqual([])
  })
})


// ── Strays: the reparented dev servers the tree walk cannot reach ───────────────────────────
//
// Modelled on the real 2026-08-29 snapshot, which is the only reason the shapes below look
// arbitrary. Lane `t0` of THIS run (app pid 400) reserved port 1420. Also live on the machine:
//
//   - a `t0` from an eleven-day-old run of a DIFFERENT project (`mantel`). Same terminal id,
//     because ids are `t0`, `t1`, … per app run — this is the collision the app-pid gate is for.
//   - a `t0` with no app tag at all, from a build that predates the field.
//   - lane `t1`'s server, which is nobody else's business.
//
// `ppid 1` on all of them: they reparented to launchd when the shell that started them exited,
// which is what put them out of reach of `descendantsOf`.
const STRAY_PS = parsePsTable(`  PID  PPID  PGID COMMAND
  400   399   400 /Applications/Operator.app/Contents/MacOS/Operator
  500     1   500 -zsh
  501   500   500 claude --settings {"tui":"default"}
  900     1   900 npm exec vite --port 1420 --strictPort
  901   900   900 node /w/node_modules/.bin/vite --port 1420 --strictPort
  902   901   900 esbuild --service=0.21.5 --ping
`)

const STRAY_TAGGED = parseTaggedTable(`  PID  PGID COMMAND
  900   900 npm exec vite --port 1420 OPERATOR_TERMINAL_ID=t0 OPERATOR_DEV_PORT=1420 OPERATOR_APP_PID=400
  901   900 node vite --port 1420 OPERATOR_TERMINAL_ID=t0 OPERATOR_DEV_PORT=1420 OPERATOR_APP_PID=400
  910   910 npm exec vite --port 1420 OPERATOR_TERMINAL_ID=t0 OPERATOR_DEV_PORT=1420 OPERATOR_APP_PID=28793
  920   920 npm exec vite --port 1420 OPERATOR_TERMINAL_ID=t0 OPERATOR_DEV_PORT=1420
  930   930 node vite --port 1421 OPERATOR_TERMINAL_ID=t1 OPERATOR_DEV_PORT=1421 OPERATOR_APP_PID=400
  501   500 claude OPERATOR_TERMINAL_ID=t0 OPERATOR_DEV_PORT=1420 OPERATOR_APP_PID=400
`)

const LANE = { terminalId: 't0', devPort: 1420, appPid: 400 }
const OPTS = { treePids: new Set([500, 501]), selfPid: 400, selfPgid: 400 }

describe('laneStrays', () => {
  it('reaps a reparented server that carries THIS lane and THIS Operator run', () => {
    const { reap } = laneStrays(STRAY_TAGGED, LANE, OPTS)
    expect(reap.map((r) => r.pid)).toEqual([900, 901])
  })

  it('REFUSES the same terminal id from another Operator run — the cross-project accident', () => {
    // pid 910 is `t0` too, and it is an eleven-day-old stray of a different project. Killing it
    // because this lane happens to share a per-run id is the one mistake that must not happen.
    const { reap, refused } = laneStrays(STRAY_TAGGED, LANE, OPTS)
    expect(reap.map((r) => r.pid)).not.toContain(910)
    expect(refused.find((r) => r.pid === 910)?.why).toMatch(/another Operator run/)
  })

  it('REFUSES a row with no OPERATOR_APP_PID — its owner is unprovable', () => {
    const { reap, refused } = laneStrays(STRAY_TAGGED, LANE, OPTS)
    expect(reap.map((r) => r.pid)).not.toContain(920)
    expect(refused.find((r) => r.pid === 920)?.why).toMatch(/no OPERATOR_APP_PID/)
  })

  it('ignores another lane entirely — not reaped, and not even reported as a near miss', () => {
    const { reap, refused } = laneStrays(STRAY_TAGGED, LANE, OPTS)
    expect(reap.map((r) => r.pid)).not.toContain(930)
    expect(refused.map((r) => r.pid)).not.toContain(930)
  })

  it('drops rows the tree walk already reaches, so nothing is counted twice', () => {
    // 501 is `claude`, tagged like everything else and squarely inside the tree.
    const { reap, refused } = laneStrays(STRAY_TAGGED, LANE, OPTS)
    expect(reap.map((r) => r.pid)).not.toContain(501)
    expect(refused.map((r) => r.pid)).not.toContain(501)
  })

  it('refuses a port that is not this lane’s reservation', () => {
    const other = laneStrays(STRAY_TAGGED, { ...LANE, devPort: 1499 }, OPTS)
    expect(other.reap).toEqual([])
    expect(other.refused.find((r) => r.pid === 900)?.why).toMatch(/is not this lane's 1499/)
  })

  it('never returns Operator itself, however it is tagged', () => {
    // The live sweep that informed this found the running Operator.app carrying
    // OPERATOR_TERMINAL_ID, because it had been launched from a tagged shell.
    const us = parseTaggedTable('  400 400 Operator OPERATOR_TERMINAL_ID=t0 OPERATOR_DEV_PORT=1420 OPERATOR_APP_PID=400\n')
    const { reap, refused } = laneStrays(us, LANE, { ...OPTS, treePids: new Set() })
    expect(reap).toEqual([])
    expect(refused[0].why).toMatch(/Operator itself/)
  })

  it('accepts any port when the lane never reserved one', () => {
    const { reap } = laneStrays(STRAY_TAGGED, { terminalId: 't0', appPid: 400 }, OPTS)
    expect(reap.map((r) => r.pid)).toEqual([900, 901])
  })
})

describe('expandStrays', () => {
  it('takes the stray’s own children too — they may have re-grouped since', () => {
    const rows = parseTaggedTable('  900 900 npm exec vite OPERATOR_TERMINAL_ID=t0 OPERATOR_APP_PID=400\n')
    expect([...expandStrays(STRAY_PS, rows)].sort((a, b) => a - b)).toEqual([900, 901, 902])
  })

  it('never walks from launchd', () => {
    const rows = parseTaggedTable('  1 1 launchd OPERATOR_TERMINAL_ID=t0 OPERATOR_APP_PID=400\n')
    expect(expandStrays(STRAY_PS, rows).size).toBe(0)
  })
})

// ── Escalation: SIGTERM, wait out the grace period, SIGKILL the survivors ────────────────────
//
// `process.kill` is the seam. Signal 0 is `isPidAlive`'s existence probe, so the fake answers
// that from a set the test controls; every other signal is recorded. Fake timers because the
// grace period is 1.5s of real polling and a test suite should not pay it.

/** Record every signal `reapTree` sends, and decide liveness from `alive`. */
function stubKill(alive: Set<number>) {
  const sent: Array<{ target: number; sig: string }> = []
  vi.spyOn(process, 'kill').mockImplementation(((target: number, sig: string | number) => {
    if (sig === 0) {
      if (!alive.has(target)) {
        const e = new Error('ESRCH') as NodeJS.ErrnoException
        e.code = 'ESRCH'
        throw e
      }
      return true
    }
    sent.push({ target, sig: String(sig) })
    return true
  }) as typeof process.kill)
  return sent
}

describe('reapTree escalation', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

  it('SIGTERMs the groups and stops there when the tree dies inside the grace period', async () => {
    vi.useFakeTimers()
    const sent = stubKill(new Set()) // nothing survives the first poll
    const p = reapTree(500, STRAY_PS, { selfPid: 400 })
    await vi.advanceTimersByTimeAsync(2000)
    const res = await p
    expect(sent.every((s) => s.sig === 'SIGTERM')).toBe(true)
    expect(res.escalated).toEqual([])
  })

  it('escalates to SIGKILL — BY GROUP — once the grace period is spent', async () => {
    vi.useFakeTimers()
    // 501 refuses to die. Escalating it alone would leave a supervisor free to respawn its
    // worker, so the second round is addressed to the group, exactly like the first.
    const sent = stubKill(new Set([501]))
    const p = reapTree(500, STRAY_PS, { selfPid: 400 })
    await vi.advanceTimersByTimeAsync(2000)
    const res = await p
    expect(res.escalated).toEqual([501])
    expect(sent.filter((s) => s.sig === 'SIGKILL')).toEqual([{ target: -500, sig: 'SIGKILL' }])
  })

  it('never signals our own group, even when Operator is INSIDE the tree being reaped', async () => {
    vi.useFakeTimers()
    // Not hypothetical: the live sweep found `Operator.app` itself carrying a lane's env tag,
    // because the user had launched it from a tagged shell. Here it is worse — pid 400 is a
    // descendant of the very shell being reaped, so `descendantsOf` hands it over and only the
    // self-guard stands between this and the app SIGKILLing itself mid-quit.
    const nested = parsePsTable(`  PID  PPID  PGID COMMAND
  500     1   500 -zsh
  501   500   500 claude
  400   501   400 /Applications/Operator.app/Contents/MacOS/Operator
`)
    const sent = stubKill(new Set([400, 500, 501]))
    const p = reapTree(500, nested, { selfPid: 400 })
    await vi.advanceTimersByTimeAsync(2000)
    const res = await p
    expect(res.found).toContain(400) // it really is in the blast radius…
    expect(res.pgids).toEqual([500]) // …and its group is still never signalled
    expect(sent.map((s) => s.target)).not.toContain(-400)
  })

  it('reaps the strays alongside the tree, in ONE grace period', async () => {
    vi.useFakeTimers()
    const sent = stubKill(new Set())
    const p = reapTree(500, STRAY_PS, { selfPid: 400, alsoReap: new Set([900, 901, 902]) })
    await vi.advanceTimersByTimeAsync(2000)
    const res = await p
    // Group 900 is the reparented server's, and it is signalled in the same pass as the tree's.
    expect(res.pgids).toEqual([500, 900])
    expect(sent).toContainEqual({ target: -900, sig: 'SIGTERM' })
    expect(res.found).toContain(902)
  })

  it('reaps strays with NO tree at all — the pty had already exited', async () => {
    vi.useFakeTimers()
    const sent = stubKill(new Set())
    const p = reapTree(0, STRAY_PS, { selfPid: 400, alsoReap: new Set([900, 901, 902]) })
    await vi.advanceTimersByTimeAsync(2000)
    const res = await p
    expect(res.pgids).toEqual([900])
    expect(sent).toEqual([{ target: -900, sig: 'SIGTERM' }])
    // rootPid 0 is never itself signalled — kill(0, …) means "my own process group".
    expect(sent.map((s) => s.target)).not.toContain(0)
  })
})
