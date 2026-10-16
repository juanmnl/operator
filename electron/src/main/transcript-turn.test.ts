// Which lanes `--resume` can open (QA final pass 2026-10-16, D2). A lane suspended before its first
// turn came back with "No conversation found" and was lost. Claude Code writes no transcript until it
// has something to keep, and with Remote Control on it writes one with no turn in it.
//
// The records are real Claude Code 2.1.301 shapes read from this machine's transcripts on 2026-10-16
// (ids and text shortened): a Remote Control lane that was never given a prompt, a `/usage` typed at
// a fresh lane (its caveat is `isMeta`, the command record is not), and an ordinary prompt.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionsWithTurn, hasUserTurn, Track } from './transcript'

const ID = {
  remoteOnly: '6efc47fc-bcff-4b82-8826-9231af5db666',
  caveatOnly: '1a2b3c4d-0000-4000-8000-000000000001',
  slashCommand: '7edbf7e0-22df-43b4-ba17-8a4ab34660d1',
  prompt: '1a2b3c4d-0000-4000-8000-000000000002',
  sidechainOnly: '1a2b3c4d-0000-4000-8000-000000000003',
  missing: 'd2c6d2a4-6ecd-461d-bbac-4858fec8c5fa',
}

const jsonl = (...records: object[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n'

const remoteControlRecords = (sessionId: string) => [
  { type: 'custom-title', customTitle: 'proj1-ac8e--qa', sessionId },
  { type: 'agent-name', agentName: 'proj1-ac8e--qa', sessionId },
  { type: 'mode', mode: 'normal', sessionId },
  { type: 'permission-mode', permissionMode: 'auto', sessionId },
  { type: 'bridge-session', sessionId, bridgeSessionId: 'cse_014x', lastSequenceNum: 0 },
  { parentUuid: null, isSidechain: false, type: 'system', subtype: 'bridge_status', content: '/remote-control is active', timestamp: '2026-10-16T19:05:00.000Z' },
  { type: 'last-prompt', leafUuid: '4158507c', sessionId },
  { type: 'cost-state', sessionId, totalCostUSD: 0 },
]
const caveat = { type: 'user', isMeta: true, isSidechain: false, timestamp: '2026-10-16T19:05:01.000Z', message: { role: 'user', content: '<local-command-caveat>The command below was run directly in Claude Code, not sent to the model.</local-command-caveat>' } }

let projects: string
beforeAll(async () => {
  projects = await mkdtemp(join(tmpdir(), 'op-turn-'))
  const a = join(projects, '-Users-x-proj1')
  const b = join(projects, '-Users-x-proj1-worktree')
  await mkdir(a); await mkdir(b)
  await writeFile(join(a, `${ID.remoteOnly}.jsonl`), jsonl(...remoteControlRecords(ID.remoteOnly)))
  await writeFile(join(a, `${ID.caveatOnly}.jsonl`), jsonl({ type: 'queue-operation', operation: 'enqueue', sessionId: ID.caveatOnly }, caveat))
  await writeFile(join(b, `${ID.slashCommand}.jsonl`), jsonl(
    { type: 'queue-operation', operation: 'enqueue', sessionId: ID.slashCommand },
    caveat,
    { type: 'user', isSidechain: false, timestamp: '2026-10-16T19:05:02.000Z', message: { role: 'user', content: '<command-name>/usage</command-name>\n<command-message>usage</command-message>' } },
  ))
  await writeFile(join(b, `${ID.prompt}.jsonl`), jsonl(
    ...remoteControlRecords(ID.prompt),
    { type: 'user', isSidechain: false, timestamp: '2026-10-16T19:06:00.000Z', message: { role: 'user', content: 'what does the rail draw for a suspended lane?' } },
  ))
  await writeFile(join(b, `${ID.sidechainOnly}.jsonl`), jsonl(
    { type: 'user', isSidechain: true, timestamp: '2026-10-16T19:06:00.000Z', message: { role: 'user', content: 'subagent brief' } },
  ))
})
afterAll(async () => { await rm(projects, { recursive: true, force: true }) })

describe('a transcript `--resume` can open', () => {
  it('has a user turn: a prompt or a typed slash command', async () => {
    expect(await sessionsWithTurn([ID.prompt, ID.slashCommand], projects)).toEqual([ID.prompt, ID.slashCommand])
  })

  it('has none when Claude Code wrote only Remote Control and title records (a lane never given a turn)', async () => {
    expect(await sessionsWithTurn([ID.remoteOnly], projects)).toEqual([])
  })

  it('has none with only a meta caveat or a subagent record', async () => {
    expect(await sessionsWithTurn([ID.caveatOnly, ID.sidechainOnly], projects)).toEqual([])
  })

  it('has none when there is no file for the id', async () => {
    expect(await sessionsWithTurn([ID.missing], projects)).toEqual([])
  })

  it('answers for a mixed list, once per id, and ignores what is not a session id', async () => {
    const got = await sessionsWithTurn([ID.missing, ID.prompt, ID.remoteOnly, ID.prompt, '../../etc/passwd'], projects)
    expect(got).toEqual([ID.prompt])
  })

  it('is empty when the projects directory is missing', async () => {
    expect(await sessionsWithTurn([ID.prompt], join(projects, 'nope'))).toEqual([])
  })

  it('reads a missing path as no turn rather than throwing', async () => {
    expect(await hasUserTurn(join(projects, 'nope.jsonl'))).toBe(false)
  })
})

// The renderer's failed-resume watch read `lastActivityAt`, which is "now" for a track that has read
// nothing, so a `--resume` that found no conversation read as having come back and its exit was
// taken for the lane finishing: no toast, and the lane left the rail.
describe('lastRecordAt', () => {
  it('is absent until a record is read, where lastActivityAt reads now', () => {
    const t = new Track('t0', { claudeSessionId: ID.missing, cwd: '/x', projectId: 'p' }, Date.now())
    const s = t.toSession('idle')
    expect(s.lastRecordAt).toBeUndefined()
    expect(s.lastActivityAt).toBeTruthy()
  })

  it('is the newest record\'s timestamp once one is read', () => {
    const t = new Track('t0', { claudeSessionId: ID.prompt, cwd: '/x', projectId: 'p' }, Date.now())
    t.apply({ type: 'user', isSidechain: false, timestamp: '2026-10-16T19:06:00.000Z', message: { role: 'user', content: 'hi' } })
    expect(t.toSession('waiting').lastRecordAt).toBe('2026-10-16T19:06:00.000Z')
  })
})
