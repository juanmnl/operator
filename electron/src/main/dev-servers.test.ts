import { describe, it, expect } from 'vitest'
import { laneStrays, abandonedLaneRows, type TaggedRow, type PsRow } from './reap'
import { devServerInventory, projectPathOf, stripEnvDump, ageSecondsFrom } from './dev-servers'
import { DEV_SERVER_RE, OPERATOR_BINARY_RE } from './port-alloc'

// Row shapes below are TRANSCRIBED from one `ps -eww -o pid,ppid,pgid,command -E` taken on the
// dev machine on 2026-09-05, not invented. That matters: the reason the port rule in
// `refuseStray` looked defensible for so long is that nobody had checked what the tag actually
// contains on a leaked server.
const tag = (o: Partial<TaggedRow> & { pid: number }): TaggedRow => ({
  pgid: o.pid, command: 'node vite', ...o,
})

const APP = 55647 // the live Operator in that snapshot

describe('hole 1 — a lane close must reap its ppid-1 servers', () => {
  // MEASURED: pid 28458, ppid 1, `node server.mjs`, OPERATOR_TERMINAL_ID=t14,
  // OPERATOR_DEV_PORT=1431, OPERATOR_APP_PID=55647 — while lane t14 was still open. A dev server
  // that reparented to launchd the moment the agent backgrounded it, so no `ppid` path from the
  // pty shell reaches it and the tree walk is blind to it.
  const reparented = tag({ pid: 28458, pgid: 28458, terminalId: 't14', devPort: 1431, appPid: APP, command: 'node server.mjs' })

  it('reaps it — the tag survives reparenting, which is the whole point of the tag', () => {
    const { reap, refused } = laneStrays([reparented], { terminalId: 't14', devPort: 1431, appPid: APP },
      { treePids: new Set(), selfPid: 1234, selfPgid: 99 })
    expect(reap.map((r) => r.pid)).toEqual([28458])
    expect(refused).toEqual([])
  })

  it('still refuses the same row when it belongs to a DIFFERENT Operator run', () => {
    const other = { ...reparented, appPid: 41111 }
    const { reap, refused } = laneStrays([other], { terminalId: 't14', devPort: 1431, appPid: APP },
      { treePids: new Set(), selfPid: 1234 })
    expect(reap).toEqual([])
    expect(refused[0].why).toContain('another Operator run')
  })

  // MEASURED, and the reason the untagged refusal is load-bearing rather than pedantic: a
  // Homebrew `postgres` (pid 9061, ppid 1) was carrying OPERATOR_TERMINAL_ID=t0 and
  // OPERATOR_DEV_PORT=1420 with NO app pid, because it had been started from a shell where those
  // were exported. Lane t0 was open at the time.
  it('REFUSES a stranger that merely inherited the tag — postgres, measured', () => {
    const postgres = tag({ pid: 9061, terminalId: 't0', devPort: 1420, appPid: undefined, command: 'postgres -D /opt/homebrew/var/postgresql@16' })
    const { reap, refused } = laneStrays([postgres], { terminalId: 't0', devPort: 1420, appPid: APP },
      { treePids: new Set(), selfPid: 1234 })
    expect(reap).toEqual([])
    expect(refused[0].why).toContain('no OPERATOR_APP_PID')
  })

  it('drops a row the tree walk already reaches, without calling it refused', () => {
    const { reap, refused } = laneStrays([reparented], { terminalId: 't14', devPort: 1431, appPid: APP },
      { treePids: new Set([28458]), selfPid: 1234 })
    expect(reap).toEqual([])
    expect(refused).toEqual([])
  })
})

describe('hole 2 — a restarted server must not outlive its lane', () => {
  // MEASURED: lane t18 had THREE server trees alive at once (25919, 26903, 36462), each a
  // separate `npm`/`vite` under the el-encanto-8c5180 worktree. Every one carried the IDENTICAL
  // `OPERATOR_DEV_PORT=1432`, because that variable is the RESERVATION inherited from the pty —
  // not the port the process bound. Whatever each was actually serving, the tag could not say.
  const t18 = [
    tag({ pid: 25919, terminalId: 't18', devPort: 1432, appPid: APP }),
    tag({ pid: 26903, terminalId: 't18', devPort: 1432, appPid: APP }),
    tag({ pid: 36462, terminalId: 't18', devPort: 1432, appPid: APP }),
  ]

  it('reaps every one of a lane’s server trees, not just the newest', () => {
    const { reap } = laneStrays(t18, { terminalId: 't18', devPort: 1432, appPid: APP },
      { treePids: new Set(), selfPid: 1234 })
    expect(reap.map((r) => r.pid)).toEqual([25919, 26903, 36462])
  })

  // THE FIX. `refuseStray` used to return "OPERATOR_DEV_PORT=1434 is not this lane's 1432" for a
  // row whose reservation had drifted from the lane's current one, which leaked it permanently:
  // nothing else in the lifecycle ever revisits a row that a lane close declined.
  it('reaps a row whose reservation no longer matches the lane’s — this used to be refused', () => {
    const drifted = tag({ pid: 41000, terminalId: 't18', devPort: 1434, appPid: APP })
    const { reap, refused } = laneStrays([drifted], { terminalId: 't18', devPort: 1432, appPid: APP },
      { treePids: new Set(), selfPid: 1234 })
    expect(reap.map((r) => r.pid)).toEqual([41000])
    expect(refused).toEqual([])
  })

  it('reaps a row carrying no port at all for a lane that has one', () => {
    const untagged = tag({ pid: 41001, terminalId: 't18', devPort: undefined, appPid: APP })
    const { reap } = laneStrays([untagged], { terminalId: 't18', devPort: 1432, appPid: APP },
      { treePids: new Set(), selfPid: 1234 })
    expect(reap.map((r) => r.pid)).toEqual([41001])
  })

  it('and still never crosses to another lane — terminalId is what scopes a close', () => {
    const sibling = tag({ pid: 23838, terminalId: 't19', devPort: 1433, appPid: APP })
    const { reap, refused } = laneStrays([sibling], { terminalId: 't18', devPort: 1432, appPid: APP },
      { treePids: new Set(), selfPid: 1234 })
    expect(reap).toEqual([])
    expect(refused).toEqual([]) // another lane's row is not a near miss, so it is not reported
  })
})

describe('hole 4 — the live app sweeping its own abandoned lanes', () => {
  // MEASURED: OPERATOR_TERMINAL_ID=t28 processes carrying the live app pid, with no t28 lane
  // open anywhere in it. The boot sweep refuses these forever — their app pid is alive, which is
  // its single strongest reason to leave a row alone.
  const rows = [
    tag({ pid: 47945, terminalId: 't28', devPort: 1430, appPid: APP }),
    tag({ pid: 25919, terminalId: 't18', devPort: 1432, appPid: APP }),
  ]
  const open = new Set(['t18', 't19', 't24'])

  it('picks the lane that is not open here, and only that one', () => {
    const got = abandonedLaneRows(rows, { appPid: APP, openTerminalIds: open, selfPid: 1 })
    expect(got.map((r) => r.pid)).toEqual([47945])
  })

  it('leaves another Operator’s rows alone — live or dead, they are its business', () => {
    const foreign = [tag({ pid: 60000, terminalId: 't3', appPid: 41111 })]
    expect(abandonedLaneRows(foreign, { appPid: APP, openTerminalIds: open, selfPid: 1 })).toEqual([])
  })

  it('leaves an untagged row alone — same refusal as everywhere else', () => {
    const untagged = [tag({ pid: 9061, terminalId: 't0', appPid: undefined })]
    expect(abandonedLaneRows(untagged, { appPid: APP, openTerminalIds: new Set(), selfPid: 1 })).toEqual([])
  })

  it('never selects Operator itself, by pid or by group', () => {
    const self = [tag({ pid: APP, pgid: 7, terminalId: 't99', appPid: APP })]
    expect(abandonedLaneRows(self, { appPid: APP, openTerminalIds: new Set(), selfPid: APP })).toEqual([])
    const sameGroup = [tag({ pid: 60001, pgid: 7, terminalId: 't99', appPid: APP })]
    expect(abandonedLaneRows(sameGroup, { appPid: APP, openTerminalIds: new Set(), selfPid: APP, selfPgid: 7 })).toEqual([])
  })

  it('never selects launchd-parented pid/pgid 1', () => {
    const bad = [tag({ pid: 1, pgid: 1, terminalId: 't99', appPid: APP })]
    expect(abandonedLaneRows(bad, { appPid: APP, openTerminalIds: new Set(), selfPid: 999 })).toEqual([])
  })
})

describe('hole 3 — the inventory the user decides from', () => {
  const roots = ['/Users/dev/proj', '/Users/dev/.operator/worktrees']
  const base = {
    openTerminalIds: new Set(['t18']),
    appPid: APP,
    selfPid: 999,
    roots,
    isAppAlive: (pid: number) => pid === APP,
  }

  it('classifies the four owners distinctly', () => {
    const tagged = [
      tag({ pid: 100, terminalId: 't18', devPort: 1432, appPid: APP, command: '/Users/dev/proj/node_modules/.bin/vite' }),
      tag({ pid: 101, terminalId: 't28', devPort: 1430, appPid: APP, command: '/Users/dev/proj/node_modules/.bin/vite' }),
      tag({ pid: 102, terminalId: 't3', devPort: 1421, appPid: 41111, command: '/Users/dev/proj/node_modules/.bin/vite' }),
      tag({ pid: 103, terminalId: 't0', devPort: 1420, appPid: undefined, command: '/Users/dev/proj/node_modules/.bin/vite' }),
    ]
    const got = devServerInventory({ ...base, tagged, ps: [] })
    expect(Object.fromEntries(got.map((r) => [r.pid, r.owner]))).toEqual({
      100: 'live-lane', 101: 'abandoned-lane', 102: 'dead-app', 103: 'untagged',
    })
  })

  it('orders safest-to-kill first, so a careless click lands on the harmless row', () => {
    const tagged = [
      tag({ pid: 100, terminalId: 't18', appPid: APP, command: '/Users/dev/proj/x/vite' }),
      tag({ pid: 102, terminalId: 't3', appPid: 41111, command: '/Users/dev/proj/x/vite' }),
      tag({ pid: 101, terminalId: 't28', appPid: APP, command: '/Users/dev/proj/x/vite' }),
    ]
    expect(devServerInventory({ ...base, tagged, ps: [] }).map((r) => r.owner))
      .toEqual(['dead-app', 'abandoned-lane', 'live-lane'])
  })

  it('lists a TAGGED row whose command looks nothing like a dev server', () => {
    // Measured: t14's leak was `node server.mjs`. The tag outranks the command shape.
    const tagged = [tag({ pid: 28458, terminalId: 't14', devPort: 1431, appPid: APP, command: 'node /Users/dev/proj/server.mjs' })]
    expect(devServerInventory({ ...base, tagged, ps: [] })).toHaveLength(1)
  })

  it('finds an UNTAGGED dev server under a known root — the pre-tag orphan case', () => {
    const ps: PsRow[] = [{ pid: 200, ppid: 1, pgid: 200, command: 'node /Users/dev/.operator/worktrees/w1/node_modules/.bin/vite' }]
    const got = devServerInventory({ ...base, tagged: [], ps })
    expect(got.map((r) => [r.pid, r.owner, r.cwd])).toEqual([[200, 'untagged', '/Users/dev/.operator/worktrees/w1']])
  })

  it('REFUSES an untagged vite that is not under any root the user owns', () => {
    // The overreach guard. Without it this becomes a kill list for every dev server on the
    // machine, including work that has nothing to do with Operator.
    const ps: PsRow[] = [{ pid: 201, ppid: 1, pgid: 201, command: 'node /Users/dev/unrelated/node_modules/.bin/vite' }]
    expect(devServerInventory({ ...base, tagged: [], ps })).toEqual([])
  })

  it('never lists Operator’s own mcp-serve helpers, which carry the full tag set', () => {
    const tagged = [tag({ pid: 300, terminalId: 't18', appPid: APP, command: '/Applications/Operator.app/Contents/MacOS/Operator --mcp-serve' })]
    expect(devServerInventory({ ...base, tagged, ps: [] })).toEqual([])
  })

  it('never lists the lane’s own claude process', () => {
    const tagged = [tag({ pid: 301, terminalId: 't18', appPid: APP, command: 'claude --settings /Users/dev/.operator/sessions/x.json' })]
    expect(devServerInventory({ ...base, tagged, ps: [] })).toEqual([])
  })

  it('never lists Operator itself', () => {
    const tagged = [tag({ pid: 999, terminalId: 't18', appPid: APP, command: '/Users/dev/proj/vite' })]
    expect(devServerInventory({ ...base, tagged, ps: [] })).toEqual([])
  })

  it('does not double-list a pid present in both the tagged sweep and the plain table', () => {
    const tagged = [tag({ pid: 100, terminalId: 't18', appPid: APP, command: '/Users/dev/proj/node_modules/.bin/vite' })]
    const ps: PsRow[] = [{ pid: 100, ppid: 1, pgid: 100, command: '/Users/dev/proj/node_modules/.bin/vite' }]
    expect(devServerInventory({ ...base, tagged, ps })).toHaveLength(1)
  })
})

describe('reading the ps row', () => {
  it('strips the environment dump `ps -E` appends', () => {
    expect(stripEnvDump('node vite --port 1432 OPERATOR_TERMINAL_ID=t18 HOME=/Users/dev'))
      .toBe('node vite --port 1432')
  })

  it('keeps an `=` that is part of an argument', () => {
    expect(stripEnvDump('node --define=x=1 script.js PATH=/usr/bin')).toBe('node --define=x=1 script.js')
  })

  it('leaves a command with no environment alone', () => {
    expect(stripEnvDump('node vite')).toBe('node vite')
  })

  it('cuts a project path at the node_modules boundary so it reads as the project', () => {
    expect(projectPathOf('node /Users/dev/proj/node_modules/.bin/vite', ['/Users/dev/proj']))
      .toBe('/Users/dev/proj')
  })

  it('answers undefined when nothing matches a known root', () => {
    expect(projectPathOf('node /elsewhere/vite', ['/Users/dev/proj'])).toBeUndefined()
  })

  it('reads an age from ps lstart, and refuses a value it cannot parse', () => {
    const now = Date.parse('Fri Sep 5 14:02:11 2026')
    expect(ageSecondsFrom('Fri Sep 5 14:00:11 2026', now)).toBe(120)
    expect(ageSecondsFrom('not a date', now)).toBeUndefined()
    // A clock skew that would make a process look negative-aged reports nothing, not a lie.
    expect(ageSecondsFrom('Fri Sep 5 14:05:11 2026', now)).toBeUndefined()
  })
})

// Blocker 4: the 10-minute sweep may only act on the boot sweep's gates. These pin the two
// filters it applies before the lease and port checks.
describe('the automatic sweep’s shape filters', () => {
  it('refuses Operator’s own binaries whatever tags they carry', () => {
    // Our helpers carry the full tag set on every lane, and a timer that kills them kills the app.
    for (const cmd of [
      '/Applications/Operator.app/Contents/MacOS/Operator --mcp-serve',
      '/Applications/Operator.app/Contents/Frameworks/Operator Helper.app/Contents/MacOS/Helper',
      '/Users/dev/app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
    ]) expect(OPERATOR_BINARY_RE.test(cmd)).toBe(true)
  })

  it('does not refuse a real dev server', () => {
    expect(OPERATOR_BINARY_RE.test('node /Users/dev/app/node_modules/.bin/vite --port 1425')).toBe(false)
  })

  it('recognises the dev servers this app’s projects actually run', () => {
    for (const cmd of ['node .../vite --port 1425', 'next-server', 'astro dev', 'tsx watch src/index.ts', 'nodemon server.js']) {
      expect(DEV_SERVER_RE.test(cmd)).toBe(true)
    }
  })

  it('does NOT recognise a build or a stray script as a dev server', () => {
    // The gate exists so the timer reclaims a port and nothing else — a build that outlived its
    // lane is for the Dev servers list, not for an automatic kill.
    for (const cmd of ['/bin/sh -c npm run build', 'node scripts/migrate.js', 'postgres -D /opt/homebrew/var']) {
      expect(DEV_SERVER_RE.test(cmd)).toBe(false)
    }
  })
})

// Medium 8: a live lane's rows must LOOK like a dev server; an abandoned or dead-app row need not.
describe('the live-lane shape gate', () => {
  const roots = ['/Users/dev/proj']
  const base = {
    openTerminalIds: new Set(['t18']), appPid: APP, selfPid: 999, roots,
    isAppAlive: (pid: number) => pid === APP,
  }

  it('hides a LIVE lane’s non-server processes — they had kill buttons under "dev servers"', () => {
    const tagged = [
      tag({ pid: 100, terminalId: 't18', appPid: APP, command: '/Users/dev/proj/node_modules/.bin/tsc --watch' }),
      tag({ pid: 101, terminalId: 't18', appPid: APP, command: 'node /Users/dev/proj/node_modules/.bin/vite' }),
    ]
    expect(devServerInventory({ ...base, tagged, ps: [] }).map((r) => r.pid)).toEqual([101])
  })

  it('KEEPS the relaxed match for an abandoned lane — that is where the real leak was', () => {
    // t14's measured leak was `node server.mjs`, which matches no dev-server pattern at all.
    const tagged = [tag({ pid: 200, terminalId: 't28', appPid: APP, command: 'node /Users/dev/proj/server.mjs' })]
    const got = devServerInventory({ ...base, tagged, ps: [] })
    expect(got.map((r) => [r.pid, r.owner])).toEqual([[200, 'abandoned-lane']])
  })

  it('keeps it for a dead app’s rows too', () => {
    const tagged = [tag({ pid: 201, terminalId: 't3', appPid: 41111, command: 'node /Users/dev/proj/server.mjs' })]
    expect(devServerInventory({ ...base, tagged, ps: [] })[0].owner).toBe('dead-app')
  })
})
