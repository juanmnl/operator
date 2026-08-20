import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The tailer finds transcripts under $HOME/.claude/projects, so HOME is redirected before the
// module loads. Pointing it at the real home would tail the user's live sessions.
const SANDBOX = mkdtempSync(join(tmpdir(), 'operator-tail-test-'))
process.env.HOME = SANDBOX
process.env.OPERATOR_DIR = join(SANDBOX, 'operator-home')

const { Transcript } = await import('./transcript')

const SESSION = '11111111-2222-3333-4444-555555555555'
const projectDir = join(SANDBOX, '.claude', 'projects', '-Users-dev-thing')
const file = join(projectDir, `${SESSION}.jsonl`)

const line = (o: unknown) => `${JSON.stringify(o)}\n`
const assistantText = (text: string) => line({ type: 'assistant', timestamp: '2026-08-20T10:00:00Z', message: { id: 'm1', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text }] } })

beforeAll(() => mkdirSync(projectDir, { recursive: true }))
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

const alive = () => true
const inactive = () => false

describe('the tailer, against a real file on disk', () => {
  it('finds the transcript by session uuid and reads a prompt into the session', async () => {
    writeFileSync(file, line({ type: 'user', timestamp: '2026-08-20T10:00:00Z', message: { content: 'fix the login button' } }))
    const t = new Transcript()
    t.register('t0', { claudeSessionId: SESSION, cwd: '/Users/dev/thing', projectId: 'p1' })
    await t.tick({ isAlive: alive, isActive: inactive })

    const s = t.sessions()[0]
    expect(s.summary).toBe('fix the login button')
    expect(s.projectName).toBe('thing')
    expect(s.terminalId).toBe('t0')
    expect((s.messages as unknown[]).length).toBe(1)
  })

  it('reads only what is NEW on the next tick, and does not replay', async () => {
    const t = new Transcript()
    t.register('t1', { claudeSessionId: SESSION, cwd: '/Users/dev/thing', projectId: 'p1' })
    await t.tick({ isAlive: alive, isActive: inactive })
    const before = (t.sessions()[0].messages as unknown[]).length

    appendFileSync(file, assistantText('here is the answer'))
    await t.tick({ isAlive: alive, isActive: inactive })
    const after = (t.sessions()[0].messages as unknown[]).length
    expect(after).toBe(before + 1)

    // A tick with nothing appended must add nothing.
    await t.tick({ isAlive: alive, isActive: inactive })
    expect((t.sessions()[0].messages as unknown[]).length).toBe(after)
  })

  it('LEAVES A PARTIAL TRAILING LINE for the next tick instead of losing the turn', async () => {
    const t = new Transcript()
    t.register('t2', { claudeSessionId: SESSION, cwd: '/Users/dev/thing', projectId: 'p1' })
    await t.tick({ isAlive: alive, isActive: inactive })
    const before = (t.sessions()[0].messages as unknown[]).length

    // Claude Code's append is not atomic, so half a line is a normal thing to observe.
    const whole = assistantText('split across two writes')
    const cut = Math.floor(whole.length / 2)
    appendFileSync(file, whole.slice(0, cut))
    await t.tick({ isAlive: alive, isActive: inactive })
    expect((t.sessions()[0].messages as unknown[]).length).toBe(before) // nothing yet — correct

    appendFileSync(file, whole.slice(cut))
    await t.tick({ isAlive: alive, isActive: inactive })
    // and now the WHOLE turn arrives, not a mangled half
    const msgs = t.sessions()[0].messages as Array<{ text: string }>
    expect(msgs.length).toBe(before + 1)
    expect(msgs[msgs.length - 1].text).toBe('split across two writes')
  })

  it('re-reads from zero when the file SHRANK (rotated), instead of seeking past its end', async () => {
    const t = new Transcript()
    t.register('t3', { claudeSessionId: SESSION, cwd: '/Users/dev/thing', projectId: 'p1' })
    await t.tick({ isAlive: alive, isActive: inactive })
    expect((t.sessions()[0].messages as unknown[]).length).toBeGreaterThan(1)

    writeFileSync(file, line({ type: 'user', timestamp: '2026-08-20T11:00:00Z', message: { content: 'a fresh, shorter file' } }))
    await t.tick({ isAlive: alive, isActive: inactive })
    const msgs = t.sessions()[0].messages as Array<{ text: string }>
    expect(msgs.length).toBe(1)
    expect(msgs[0].text).toBe('a fresh, shorter file')
  })

  it('emits a dispatch for an authored sentinel and NOT for a quoted one', async () => {
    writeFileSync(file, '')
    const t = new Transcript()
    t.register('t4', { claudeSessionId: SESSION, cwd: '/Users/dev/thing', projectId: 'p1' })
    await t.tick({ isAlive: alive, isActive: inactive })

    const seen: Array<{ role: string; task: string }> = []
    t.on('dispatch', (d) => seen.push(d as { role: string; task: string }))

    appendFileSync(file, assistantText('```\nOPERATOR-DISPATCH [code] quoted\n```\nOPERATOR-DISPATCH [design] real work'))
    await t.tick({ isAlive: alive, isActive: inactive })

    expect(seen).toEqual([{ id: expect.any(String), sessionId: SESSION, terminalId: 't4', role: 'design', task: 'real work' }])
  })

  it('emits a reply with the project id stamped on it', async () => {
    const t = new Transcript()
    t.register('t5', { claudeSessionId: SESSION, cwd: '/Users/dev/thing', projectId: 'proj-42' })
    await t.tick({ isAlive: alive, isActive: inactive })
    const seen: Array<Record<string, unknown>> = []
    t.on('reply', (r) => seen.push(r as Record<string, unknown>))

    appendFileSync(file, assistantText('OPERATOR-REPLY [operator] done here'))
    await t.tick({ isAlive: alive, isActive: inactive })
    expect(seen).toHaveLength(1)
    expect(seen[0].projectId).toBe('proj-42')
    expect(seen[0].to).toBe('operator')
    expect(seen[0].text).toBe('done here')
  })

  it('marks a session ended when its pty is gone, and reports it as a dead lane', async () => {
    const t = new Transcript()
    t.register('t6', { claudeSessionId: SESSION, cwd: '/Users/dev/thing', projectId: 'p1' })
    await t.tick({ isAlive: () => false, isActive: inactive })
    expect(t.sessions()[0].status).toBe('ended')
    expect(t.liveLanes(() => false)).toHaveLength(0)
  })

  it('reports pty activity as running, outranking a transcript that says otherwise', async () => {
    const t = new Transcript()
    t.register('t7', { claudeSessionId: SESSION, cwd: '/Users/dev/thing', projectId: 'p1' })
    await t.tick({ isAlive: alive, isActive: () => true })
    expect(t.liveLanes(alive)[0].phase).toBe('running')
  })

  it('exposes a durable identity that outlives a renderer respawn', () => {
    const t = new Transcript()
    t.register('t8', { claudeSessionId: SESSION, cwd: '/Users/dev/thing', projectId: 'p9' })
    expect(t.identity('t8')).toEqual({ claudeSessionId: SESSION, projectId: 'p9' })
    expect(t.identity('nope')).toBeNull()
  })
})
