// Where a lane's transcripts live (review round 5, R5-1). A project may set CLAUDE_CONFIG_DIR, and
// its lanes then write under `$CLAUDE_CONFIG_DIR/projects`. The turn lookup only looked in
// `~/.claude/projects`, so every lane of such a project read as "never took a turn": the resume card
// left its rows out and a restore with `--resume` refused.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), 'operator-project-config-')))
process.env.OPERATOR_DIR = join(SANDBOX, 'operator')
const { effectiveConfigDir, laneProjectsDir } = await import('./project-config')
const { sessionsWithTurn } = await import('./transcript')

const LANE = '1a2b3c4d-0000-4000-8000-0000000000aa'
const ownConfig = join(SANDBOX, 'claude-work')
const home = join(SANDBOX, 'home')

beforeAll(() => {
  mkdirSync(process.env.OPERATOR_DIR!, { recursive: true })
  writeFileSync(join(process.env.OPERATOR_DIR!, 'projects.json'), JSON.stringify([
    { id: 'work', name: 'work', path: '/Users/x/work', env: [{ name: 'CLAUDE_CONFIG_DIR', value: ownConfig }, { name: 'FOO', value: 'bar' }] },
    { id: 'plain', name: 'plain', path: '/Users/x/plain', env: [{ name: 'FOO', value: 'bar' }] },
    { id: 'cleared', name: 'cleared', path: '/Users/x/cleared', env: [{ name: 'CLAUDE_CONFIG_DIR' }] },
    { id: 'relative', name: 'relative', path: '/Users/x/relative', env: [{ name: 'CLAUDE_CONFIG_DIR', value: '~/claude-work' }] },
  ]))
  // The lane's transcript, where Claude Code writes it for this project, with a prompt in it.
  mkdirSync(join(ownConfig, 'projects', '-Users-x-work'), { recursive: true })
  writeFileSync(join(ownConfig, 'projects', '-Users-x-work', `${LANE}.jsonl`), JSON.stringify(
    { type: 'user', isSidechain: false, timestamp: '2026-10-16T20:00:00.000Z', message: { role: 'user', content: 'fix the rail' } },
  ) + '\n')
  // And `~/.claude/projects`, which holds no file for it.
  mkdirSync(join(home, '.claude', 'projects', '-Users-x-work'), { recursive: true })
})
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

describe('a lane\'s config dir', () => {
  it('is the project\'s CLAUDE_CONFIG_DIR, ahead of Operator\'s own', () => {
    expect(effectiveConfigDir({ env: { CLAUDE_CONFIG_DIR: ownConfig } }, { CLAUDE_CONFIG_DIR: '/elsewhere' }, home)).toBe(ownConfig)
  })

  it('is Operator\'s own CLAUDE_CONFIG_DIR when the project sets none, and ~/.claude when neither does', () => {
    expect(effectiveConfigDir({}, { CLAUDE_CONFIG_DIR: '/elsewhere' }, home)).toBe('/elsewhere')
    expect(effectiveConfigDir({}, {}, home)).toBe(join(home, '.claude'))
  })

  it('is ~/.claude when the project unsets an inherited CLAUDE_CONFIG_DIR', () => {
    expect(effectiveConfigDir({ unsetEnv: ['CLAUDE_CONFIG_DIR'] }, { CLAUDE_CONFIG_DIR: '/elsewhere' }, home)).toBe(join(home, '.claude'))
  })

  it('is not known for a value that is not an absolute path', () => {
    expect(effectiveConfigDir({ env: { CLAUDE_CONFIG_DIR: '~/claude-work' } }, {}, home)).toBeNull()
    expect(effectiveConfigDir({ env: { CLAUDE_CONFIG_DIR: '' } }, {}, home)).toBeNull()
  })
})

describe('the projects directory a lane writes under, read from projects.json', () => {
  it('follows a project that sets CLAUDE_CONFIG_DIR', async () => {
    expect(await laneProjectsDir('work', {})).toBe(join(ownConfig, 'projects'))
  })

  it('is the inherited one for a project without it, and for a lane with no project', async () => {
    expect(await laneProjectsDir('plain', { CLAUDE_CONFIG_DIR: '/elsewhere' })).toBe('/elsewhere/projects')
    expect(await laneProjectsDir(undefined, { CLAUDE_CONFIG_DIR: '/elsewhere' })).toBe('/elsewhere/projects')
    expect(await laneProjectsDir('cleared', { CLAUDE_CONFIG_DIR: '/elsewhere' })).toMatch(/\/\.claude\/projects$/)
  })

  it('is not known for a project id that matches nothing, or a relative CLAUDE_CONFIG_DIR', async () => {
    expect(await laneProjectsDir('gone', {})).toBeNull()
    expect(await laneProjectsDir('relative', {})).toBeNull()
  })

  it('finds the turn of a lane in that project, which ~/.claude/projects reads as none', async () => {
    const projects = await laneProjectsDir('work', {})
    expect(await sessionsWithTurn([{ id: LANE, projects }])).toEqual({ turn: [LANE], none: [] })
    // The round-5 lookup, for contrast: the default directory has no file for this lane.
    expect(await sessionsWithTurn([{ id: LANE, projects: join(home, '.claude', 'projects') }])).toEqual({ turn: [], none: [LANE] })
  })

  it('leaves a lane of a project it cannot resolve unknown, never "no turn"', async () => {
    expect(await sessionsWithTurn([{ id: LANE, projects: await laneProjectsDir('gone', {}) }])).toEqual({ turn: [], none: [] })
  })
})
