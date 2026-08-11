import { describe, it, expect } from 'vitest'
import { joinReattach, tabSessionStatus, type LivePty, type SavedRow } from './session-reattach'
import { projectActivity } from './project-status'

const pty = (id: string, extra: Partial<LivePty> = {}): LivePty => ({ id, cwd: `/w/${id}`, ...extra })
const row = (key: string, extra: Partial<SavedRow & { projectId: string }> = {}) =>
  ({ key, ...extra }) as SavedRow & { projectId?: string }

/** The projection DashboardView's `localSessions` makes, reduced to the two fields the activity
 *  rollup reads. Kept here so the tests below can go all the way from "what the backend reported"
 *  to "what the rail shows", which is the only level the bug was ever visible at. */
const toActivitySessions = (
  tabs: Array<{ projectId?: string; ended?: boolean }>,
  tracked: Record<string, { status: string }> = {},
  keyOf: (t: { projectId?: string }) => string = () => '',
) => tabs.map((t) => ({ status: tabSessionStatus(t, tracked[keyOf(t)]), phase: 'idle' }))

describe('joinReattach — which saved row is which live pty', () => {
  it('joins on claudeSessionId, whatever the terminal ids say', () => {
    const saved = [row('k1', { claudeSessionId: 'uuid-a', terminalId: 't9' })]
    const [pair] = joinReattach([pty('t1', { claudeSessionId: 'uuid-a' })], saved)
    expect(pair.saved?.key).toBe('k1')
  })

  it('REGRESSION: a saved row with a stale terminalId never labels a different live pty', () => {
    // `terminalId` is a per-run counter (`t{n}` off an in-process AtomicU64), so `t3` from a
    // previous backend run and `t3` from this one are unrelated. Stapling the old row onto the new
    // pty is what put a project on the rail with a live lane it did not have.
    const saved = [row('k-old', { claudeSessionId: 'uuid-old', terminalId: 't3', projectId: 'el-encanto' })]
    const live = [pty('t3', { claudeSessionId: 'uuid-new' })]

    const [pair] = joinReattach(live, saved)
    expect(pair.saved).toBeUndefined()

    // …and therefore the old project has nothing live in it. This is the assertion the bug report
    // asked for, stated at the level the user sees: the rail.
    const tabs = joinReattach(live, saved).map((p) => ({ projectId: p.saved?.projectId }))
    const elEncanto = tabs.filter((t) => t.projectId === 'el-encanto')
    expect(projectActivity(toActivitySessions(elEncanto)).live).toBe(0)
  })

  it('a pty that names a session never falls back to an id match', () => {
    // The saved row has no uuid at all, so only the id could link them — and it must not, because
    // the pty DOES name a session and that name did not match.
    const saved = [row('k-legacy', { terminalId: 't4', projectId: 'mantel' })]
    const [pair] = joinReattach([pty('t4', { claudeSessionId: 'uuid-fresh' })], saved)
    expect(pair.saved).toBeUndefined()
  })

  it('still joins a genuinely legacy pty by id, where nothing else can', () => {
    // Neither side names a session: a row saved before the backend reported the uuid. The id is
    // the only link there is, and refusing it would lose the record for no gain.
    const saved = [row('k-legacy', { terminalId: 't4', projectId: 'mantel' })]
    const [pair] = joinReattach([pty('t4')], saved)
    expect(pair.saved?.key).toBe('k-legacy')
  })

  it('never lets one saved row label two ptys', () => {
    const saved = [row('k1', { claudeSessionId: 'uuid-a', terminalId: 't1' })]
    const pairs = joinReattach([pty('t1', { claudeSessionId: 'uuid-a' }), pty('t2')], saved)
    expect(pairs[0].saved?.key).toBe('k1')
    expect(pairs[1].saved).toBeUndefined()
  })

  it('returns an unmatched pty rather than dropping it', () => {
    // An unlabelled live pty is recoverable — the 5s re-stamp heals it from the backend's own
    // projectId. Dropping it would hide a running agent.
    const pairs = joinReattach([pty('t7', { claudeSessionId: 'uuid-z' })], [])
    expect(pairs).toHaveLength(1)
    expect(pairs[0].pty.id).toBe('t7')
  })
})

describe('tabSessionStatus — a dead tab stops counting', () => {
  it('REGRESSION: an ended tab is ended even though the observer has forgotten it', () => {
    // `get_sessions` returns only sessions it still considers active, so a lane that exits
    // vanishes from the tracked list. The old projection read that absence as "untracked" and
    // synthesised `status: 'active'`, which is how 52 saved sessions counted as live forever.
    expect(tabSessionStatus({ ended: true }, undefined)).toBe('ended')
  })

  it('an ended tab outranks a tracked session that still claims to be active', () => {
    expect(tabSessionStatus({ ended: true }, { status: 'active' })).toBe('ended')
  })

  it('a live tab defers to the observer, in that direction only', () => {
    expect(tabSessionStatus({}, { status: 'active' })).toBe('active')
    expect(tabSessionStatus({}, { status: 'ended' })).toBe('ended')
    expect(tabSessionStatus({}, undefined)).toBe('active')
  })
})

describe('the rail lets go of a project whose lanes are gone', () => {
  it('REGRESSION: ended tabs do not keep a project live', () => {
    const tabs = [
      { projectId: 'operator', ended: true },
      { projectId: 'operator', ended: true },
    ]
    expect(projectActivity(toActivitySessions(tabs), 3).live).toBe(0)
  })

  it('but one surviving lane still holds it', () => {
    const tabs = [
      { projectId: 'operator', ended: true },
      { projectId: 'operator' },
    ]
    expect(projectActivity(toActivitySessions(tabs), 3).live).toBe(1)
  })
})
