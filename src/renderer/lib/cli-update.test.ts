import { describe, it, expect, beforeEach } from 'vitest'
import {
  compareVersions, isOutOfDate, canRestartLane, pickAutoRestart, restartable, restartLaunchOptions,
  replaceTab, rekeyTasks, cliUpdateLabel, autoRestartEnabled, setAutoRestartEnabled, AUTO_RESTART_KEY,
  type RestartCandidate,
} from './cli-update'
import { buildArgs } from './launch-args'
import { joinReattach } from './session-reattach'

describe('compareVersions', () => {
  it('compares numerically, not as strings', () => {
    expect(compareVersions('2.1.268', '2.1.269')).toBe(-1)
    expect(compareVersions('2.1.99', '2.1.100')).toBe(-1)
    expect(compareVersions('2.10.0', '2.9.9')).toBe(1)
    expect(compareVersions('2.1.269', '2.1.269')).toBe(0)
  })

  it('ranks a release above its own prerelease', () => {
    expect(compareVersions('2.2.0-beta.1', '2.2.0')).toBe(-1)
    expect(compareVersions('2.2.0', '2.2.0-beta.1')).toBe(1)
  })
})

describe('isOutOfDate', () => {
  it('is true only when the lane is on an older version than installed', () => {
    expect(isOutOfDate('2.1.267', '2.1.268')).toBe(true)
    expect(isOutOfDate('2.1.268', '2.1.268')).toBe(false)
    // A lane started on a newer binary than the link now names (a downgrade) is not offered a restart.
    expect(isOutOfDate('2.1.269', '2.1.268')).toBe(false)
  })

  it('is false when either side is unknown', () => {
    expect(isOutOfDate(undefined, '2.1.268')).toBe(false)
    expect(isOutOfDate(null, '2.1.268')).toBe(false)
    expect(isOutOfDate('2.1.267', null)).toBe(false)
  })
})

describe('canRestartLane — the idle-only gate', () => {
  const s = (phase: string, status = 'active') => ({ phase, status } as { phase: 'idle'; status: 'active' })

  it('allows a lane between turns', () => {
    expect(canRestartLane(s('waiting'), false)).toBe(true)
    expect(canRestartLane(s('idle'), false)).toBe(true)
  })

  it('refuses a lane mid-turn or compacting', () => {
    expect(canRestartLane(s('running'), false)).toBe(false)
    expect(canRestartLane(s('compacting'), false)).toBe(false)
  })

  it('refuses a lane blocked on a permission prompt, which derives as running', () => {
    // An unanswered tool_use keeps `openTools` non-empty, so derivePhase returns `running`.
    expect(canRestartLane(s('running'), false)).toBe(false)
  })

  it('refuses an ended lane, an untracked one, and one with a prompt still queued', () => {
    expect(canRestartLane(s('waiting', 'ended'), false)).toBe(false)
    expect(canRestartLane(undefined, false)).toBe(false)
    expect(canRestartLane(s('waiting'), true)).toBe(false)
  })
})

describe('pickAutoRestart', () => {
  const lane = (terminalId: string, over: Partial<RestartCandidate> = {}): RestartCandidate => ({
    terminalId,
    claudeVersion: '2.1.267',
    session: { status: 'active', phase: 'waiting' },
    pendingSubmission: false,
    resumable: true,
    ...over,
  })

  it('takes the first idle out-of-date lane, in rail order', () => {
    expect(pickAutoRestart([lane('t1'), lane('t2')], '2.1.268', false)).toBe('t1')
  })

  it('takes nothing while a restart is in flight', () => {
    expect(pickAutoRestart([lane('t1')], '2.1.268', true)).toBeNull()
  })

  it('skips running, queued, ended, unresumable and current lanes', () => {
    const lanes = [
      lane('running', { session: { status: 'active', phase: 'running' } }),
      lane('queued', { pendingSubmission: true }),
      lane('ended', { ended: true }),
      lane('blank', { resumable: false }),
      lane('current', { claudeVersion: '2.1.268' }),
      lane('unknown', { claudeVersion: undefined }),
      lane('ok'),
    ]
    expect(pickAutoRestart(lanes, '2.1.268', false)).toBe('ok')
    expect(lanes.filter((l) => restartable(l, '2.1.268')).map((l) => l.terminalId)).toEqual(['ok'])
  })

  it('takes nothing when the installed version is unknown', () => {
    expect(pickAutoRestart([lane('t1')], null, false)).toBeNull()
  })
})

describe('restartLaunchOptions — the resume shape', () => {
  it('resumes the same session with the lane\'s own model, effort and permission mode', () => {
    const o = restartLaunchOptions(
      { model: 'opus', effort: 'high', permissionMode: 'acceptEdits', projectId: '/repo', roleId: 'code' },
      'uuid-a',
      { orchestrationNote: 'You are the Code lane.', remoteControl: false },
    )
    expect(o).toMatchObject({ resumeSessionId: 'uuid-a', model: 'opus', effort: 'high', permissionMode: 'acceptEdits', projectId: '/repo', roleId: 'code', orchestrationNote: 'You are the Code lane.', remoteControl: false })
    // What main builds from it: ipc passes a sessionId too, and resume must win over it.
    expect(buildArgs(o, 'uuid-a')).toEqual(['--resume', 'uuid-a', '--permission-mode', 'acceptEdits', '--model', 'opus', '--effort', 'high'])
    expect(buildArgs(o, 'uuid-a')).not.toContain('--session-id')
  })

  it('leaves out defaults and carries the remote-control name only when there is one', () => {
    const o = restartLaunchOptions({ permissionMode: 'default' }, 'uuid-b', { remoteControl: true, remoteControlName: 'operator · Code' })
    expect(o).toEqual({ resumeSessionId: 'uuid-b', remoteControl: true, remoteControlName: 'operator · Code' })
    expect(buildArgs(o, 'uuid-b')).toEqual(['--resume', 'uuid-b', '--remote-control', 'operator · Code'])
  })
})

describe('restart in place', () => {
  it('swaps the tab in its own slot', () => {
    const tabs = [{ id: 't1', key: 'a' }, { id: 't2', key: 'b' }, { id: 't3', key: 'c' }]
    expect(replaceTab(tabs, 't2', { id: 't9', key: 'b' })).toEqual([{ id: 't1', key: 'a' }, { id: 't9', key: 'b' }, { id: 't3', key: 'c' }])
  })

  it('moves terminal-stamped tasks to the new terminal id, and returns the same array when none match', () => {
    const tasks = [{ id: 'x', terminalId: 't2' }, { id: 'y', terminalId: 't1' }, { id: 'z' }]
    expect(rekeyTasks(tasks, 't2', 't9')).toEqual([{ id: 'x', terminalId: 't9' }, { id: 'y', terminalId: 't1' }, { id: 'z' }])
    expect(rekeyTasks(tasks, 't7', 't9')).toBe(tasks)
  })

  // After a restart the pty has a NEW terminal id and the SAME Claude session id (`--resume`), while
  // the saved row can still carry the old terminal id. A renderer reload in that state must re-attach
  // the lane to its own record: same key, role and project, not a fresh unlabelled tab.
  it('a restarted lane re-attaches to its saved row by Claude session id', () => {
    const saved = [
      { key: 'lane-code', claudeSessionId: 'uuid-a', terminalId: 't3', roleId: 'code' },
      { key: 'lane-qa', claudeSessionId: 'uuid-b', terminalId: 't9', roleId: 'qa' },
    ]
    // t9 is the restarted Code lane; the recycled id belongs to QA's old row and must not win.
    const pairs = joinReattach([{ id: 't9', claudeSessionId: 'uuid-a' }], saved)
    expect(pairs[0].saved?.key).toBe('lane-code')
  })
})

describe('the header label and the auto-restart preference', () => {
  beforeEach(() => { localStorage.removeItem(AUTO_RESTART_KEY) })

  it('names the installed version', () => {
    expect(cliUpdateLabel('2.1.269')).toBe('Claude Code 2.1.269 available · Restart')
  })

  it('is off by default and remembers being turned on', () => {
    expect(autoRestartEnabled()).toBe(false)
    setAutoRestartEnabled(true)
    expect(autoRestartEnabled()).toBe(true)
    setAutoRestartEnabled(false)
    expect(autoRestartEnabled()).toBe(false)
  })
})
