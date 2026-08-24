import { describe, it, expect } from 'vitest'
import {
  parsePsTable, descendantsOf, pgidsFor, selfPgidFrom,
  parseTaggedTable, envTag, staleTaggedRows,
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
