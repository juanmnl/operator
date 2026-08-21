// Scenario parity with `src-tauri/src/transcript.rs`'s test module. Same situations, driven
// through the same public surface — a real file on disk and a tick — rather than by reaching
// into the Track, so these test the behaviour rather than the shape of the port.
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = mkdtempSync(join(tmpdir(), 'operator-s1-test-'))
process.env.HOME = SANDBOX
process.env.OPERATOR_DIR = join(SANDBOX, 'operator-home')
const { Transcript } = await import('./transcript')

const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const dir = join(SANDBOX, '.claude', 'projects', '-Users-dev-thing')
const file = join(dir, `${SESSION}.jsonl`)
mkdirSync(dir, { recursive: true })
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

const L = (o: unknown) => `${JSON.stringify(o)}\n`
const TS = '2026-08-20T10:00:00Z'
const assistant = (content: unknown[], extra: Record<string, unknown> = {}) =>
  L({ type: 'assistant', timestamp: TS, ...extra, message: { id: `m${Math.random()}`, model: 'claude-opus-5', stop_reason: 'end_turn', content } })
const user = (content: unknown) => L({ type: 'user', timestamp: TS, message: { content } })
const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input })
const toolResult = (id: string, content: unknown) => user([{ type: 'tool_result', tool_use_id: id, content }])

/** A fresh tailer over a freshly-written transcript. Each test owns the file. */
async function run(lines: string, opts: { isActive?: boolean } = {}) {
  writeFileSync(file, lines)
  const t = new Transcript()
  t.register('t0', { claudeSessionId: SESSION, cwd: '/Users/dev/thing', projectId: 'p1' })
  const chat: Array<[number, { kind: string; text: string; tool?: { name: string; output: string; outputChars: number; truncated: boolean } }]> = []
  t.on('chat', (_id, entries) => chat.push(...(entries as typeof chat)))
  await t.tick({ isAlive: () => true, isActive: () => opts.isActive ?? false })
  return { t, chat, session: t.sessions()[0] }
}

describe('tool calls become blocks', () => {
  it('a tool call and its result become ONE block with the output attached', async () => {
    const { session } = await run(
      assistant([toolUse('t1', 'Bash', { command: 'ls -la' })]) + toolResult('t1', 'a\nb\nc'),
    )
    const tools = (session.messages as Array<{ kind: string; tool?: { name: string; target?: string; output: string } }>).filter((m) => m.kind === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0].tool?.name).toBe('Bash')
    expect(tools[0].tool?.target).toBe('ls -la')
    expect(tools[0].tool?.output).toBe('a\nb\nc')
  })

  it('a large result is CAPPED and says how much there was', async () => {
    const big = 'x'.repeat(5000)
    const { session } = await run(assistant([toolUse('t1', 'Bash', { command: 'cat big' })]) + toolResult('t1', big))
    const tool = (session.messages as Array<{ kind: string; tool?: { output: string; outputChars: number; truncated: boolean } }>).find((m) => m.kind === 'tool')!.tool!
    expect(tool.output).toHaveLength(2000)
    expect(tool.outputChars).toBe(5000)
    expect(tool.truncated).toBe(true)
  })

  it('a small result is stored whole and NOT marked truncated', async () => {
    const { session } = await run(assistant([toolUse('t1', 'Bash', { command: 'echo hi' })]) + toolResult('t1', 'hi'))
    const tool = (session.messages as Array<{ kind: string; tool?: { output: string; truncated: boolean } }>).find((m) => m.kind === 'tool')!.tool!
    expect(tool.output).toBe('hi')
    expect(tool.truncated).toBe(false)
  })

  it('a block-array result is FLATTENED to its text, not stored as JSON', async () => {
    const { session } = await run(
      assistant([toolUse('t1', 'Read', { file_path: '/a.txt' })]) +
      toolResult('t1', [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }]),
    )
    const tool = (session.messages as Array<{ kind: string; tool?: { output: string } }>).find((m) => m.kind === 'tool')!.tool!
    expect(tool.output).toBe('line one\nline two')
  })

  it('a tool_result turn is NOT a user turn', async () => {
    const { session } = await run(assistant([toolUse('t1', 'Bash', { command: 'x' })]) + toolResult('t1', 'out'))
    expect((session.messages as Array<{ kind: string }>).filter((m) => m.kind === 'user')).toHaveLength(0)
  })

  it('lastToolName clears when the last open tool closes', async () => {
    const open = await run(assistant([toolUse('t1', 'Bash', { command: 'x' })]))
    expect(open.session.lastToolName).toBe('Bash')
    const closed = await run(assistant([toolUse('t1', 'Bash', { command: 'x' })]) + toolResult('t1', 'done'))
    expect(closed.session.lastToolName).toBeNull()
  })
})

// The durable (session_id, seq) key. A tool row is written when the CALL is seen and rewritten
// when the RESULT lands — on the SAME seq, or the store gets two rows for one call.
describe('persistence queue', () => {
  it('queues the call, then RE-QUEUES the result at the same seq', async () => {
    const { chat } = await run(assistant([toolUse('t1', 'Bash', { command: 'x' })]) + toolResult('t1', 'out'))
    const toolRows = chat.filter(([, e]) => e.kind === 'tool')
    expect(toolRows).toHaveLength(2)
    expect(toolRows[0][0]).toBe(toolRows[1][0])          // same seq
    expect(toolRows[0][1].tool?.output).toBe('')          // the call, empty
    expect(toolRows[1][1].tool?.output).toBe('out')       // the result, filled
  })

  it('gives distinct entries distinct, increasing seqs', async () => {
    const { chat } = await run(user('first') + assistant([{ type: 'text', text: 'answer' }]))
    const seqs = chat.map(([s]) => s)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
  })
})

describe('the narration cap', () => {
  it('EVICTS TOOL BLOCKS BEFORE PROSE — a tool-heavy turn must not push out the answers', async () => {
    // 80 is the cap. 60 prose + 40 tool calls = 100 entries; the 20 over must come from tools.
    let lines = ''
    for (let i = 0; i < 60; i++) lines += assistant([{ type: 'text', text: `prose ${i}` }])
    for (let i = 0; i < 40; i++) lines += assistant([toolUse(`t${i}`, 'Bash', { command: `cmd ${i}` })])
    const { session } = await run(lines)
    const msgs = session.messages as Array<{ kind: string }>
    expect(msgs).toHaveLength(80)
    expect(msgs.filter((m) => m.kind === 'text')).toHaveLength(60)   // every answer survives
    expect(msgs.filter((m) => m.kind === 'tool')).toHaveLength(20)
  })

  it('falls back to dropping prose once there are no tool blocks left', async () => {
    let lines = ''
    for (let i = 0; i < 100; i++) lines += assistant([{ type: 'text', text: `prose ${i}` }])
    const { session } = await run(lines)
    const msgs = session.messages as Array<{ kind: string; text: string }>
    expect(msgs).toHaveLength(80)
    expect(msgs[0].text).toBe('prose 20')  // the OLDEST went, order preserved
    expect(msgs[79].text).toBe('prose 99')
  })

  it('caps the live tail only — everything is still queued for the store', async () => {
    let lines = ''
    for (let i = 0; i < 100; i++) lines += assistant([{ type: 'text', text: `prose ${i}` }])
    const { chat, session } = await run(lines)
    expect((session.messages as unknown[]).length).toBe(80)
    expect(chat).toHaveLength(100)   // nothing is lost, only deferred to chat.db
  })
})

describe('injected turns', () => {
  it('produce no narration and do not claim the summary', async () => {
    const { session, chat } = await run(user('<system-reminder>plumbing</system-reminder>') + user('the real task'))
    expect(session.summary).toBe('the real task')
    const users = (session.messages as Array<{ kind: string; text: string }>).filter((m) => m.kind === 'user')
    expect(users).toHaveLength(1)
    expect(users[0].text).toBe('the real task')
    expect(chat.filter(([, e]) => e.text.includes('plumbing'))).toHaveLength(0)
  })

  it('real prompts still reach chat', async () => {
    const { chat } = await run(user('do the thing'))
    expect(chat.filter(([, e]) => e.kind === 'user' && e.text === 'do the thing')).toHaveLength(1)
  })
})

// A prompt typed into a mid-turn lane leaves ONLY `queue-operation: enqueue`, never a `user`
// turn. Treating its absence as "undelivered" produced 52 false reports out of 62.
describe('queued prompts', () => {
  const enqueue = (content: string) => L({ type: 'queue-operation', operation: 'enqueue', timestamp: TS, content })

  it('records an enqueued prompt for the delivery loop', async () => {
    const { session } = await run(enqueue('queued work'))
    expect((session.queued as Array<{ kind: string; text: string }>).map((q) => q.text)).toEqual(['queued work'])
  })

  it('ignores queue noise that is not an enqueue', async () => {
    const { session } = await run(L({ type: 'queue-operation', operation: 'dequeue', timestamp: TS, content: 'x' }))
    expect(session.queued).toEqual([])
  })

  it('ignores injected and empty enqueues', async () => {
    const { session } = await run(enqueue('<system-reminder>x</system-reminder>') + enqueue('   '))
    expect(session.queued).toEqual([])
  })

  it('caps the queue and truncates a long prompt', async () => {
    let lines = ''
    for (let i = 0; i < 25; i++) lines += enqueue(`q${i}`)
    lines += enqueue('y'.repeat(5000))
    const { session } = await run(lines)
    const q = session.queued as Array<{ text: string }>
    expect(q).toHaveLength(20)                       // QUEUED_CAP
    expect(q[q.length - 1].text).toHaveLength(4001)  // PROMPT_TEXT_CAP + the ellipsis
    expect(q[q.length - 1].text.endsWith('…')).toBe(true)
  })
})

describe('phase, end to end', () => {
  it('is running while a tool is open, waiting once it closes', async () => {
    const open = await run(assistant([toolUse('t1', 'Bash', { command: 'x' })]))
    expect(open.t.liveLanes(() => true)[0].phase).toBe('running')
    const closed = await run(assistant([toolUse('t1', 'Bash', { command: 'x' })]) + toolResult('t1', 'done'))
    expect(closed.t.liveLanes(() => true)[0].phase).toBe('waiting')
  })

  it('pty activity outranks the transcript', async () => {
    const { t } = await run(assistant([{ type: 'text', text: 'done' }]), { isActive: true })
    expect(t.liveLanes(() => true)[0].phase).toBe('running')
  })
})

describe('subagents', () => {
  it('counts a sidechain in and out', async () => {
    const { session } = await run(
      assistant([{ type: 'text', text: 'delegating' }]) +
      assistant([{ type: 'text', text: 'sub work' }], { isSidechain: true }) +
      assistant([{ type: 'text', text: 'back' }]),
    )
    expect(session.activeSubagents).toBe(0)
    const kinds = (session.activity as Array<{ toolName: string }>).map((a) => a.toolName)
    expect(kinds).toContain('Subagent started')
    expect(kinds).toContain('Subagent finished')
  })

  it('does not read the lane MODEL off a subagent turn', async () => {
    const { session } = await run(
      L({ type: 'assistant', timestamp: TS, message: { id: 'm1', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'a' }] } }) +
      L({ type: 'assistant', timestamp: TS, isSidechain: true, message: { id: 'm2', model: 'claude-haiku-4-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'b' }] } }),
    )
    expect(session.model).toBe('claude-opus-5')
  })
})

describe('usage totals', () => {
  it('counts a message id ONCE however often it is re-emitted', async () => {
    const turn = (id: string) => L({ type: 'assistant', timestamp: TS, message: { id, model: 'm', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 }, content: [{ type: 'text', text: 'x' }] } })
    const { session } = await run(turn('same') + turn('same') + turn('other'))
    expect(session.usage).toEqual({ input: 20, output: 10, cacheRead: 4 })
  })
})

describe('dispatch and reply sentinels, through the tailer', () => {
  it('emits a dispatch for an authored sentinel only', async () => {
    writeFileSync(file, '')
    const t = new Transcript()
    t.register('t0', { claudeSessionId: SESSION, cwd: '/Users/dev/thing', projectId: 'proj' })
    await t.tick({ isAlive: () => true, isActive: () => false })
    const seen: Array<Record<string, unknown>> = []
    t.on('dispatch', (d) => seen.push(d as Record<string, unknown>))
    appendFileSync(file, assistant([{ type: 'text', text: '```\nOPERATOR-DISPATCH [qa] quoted\n```\nOPERATOR-DISPATCH [qa] real work' }]))
    await t.tick({ isAlive: () => true, isActive: () => false })
    expect(seen).toHaveLength(1)
    expect(seen[0].role).toBe('qa')
    expect(seen[0].task).toBe('real work')
  })

  it('emits a reply stamped with the project id', async () => {
    writeFileSync(file, '')
    const t = new Transcript()
    t.register('t0', { claudeSessionId: SESSION, cwd: '/Users/dev/thing', projectId: 'proj' })
    await t.tick({ isAlive: () => true, isActive: () => false })
    const seen: Array<Record<string, unknown>> = []
    t.on('reply', (r) => seen.push(r as Record<string, unknown>))
    appendFileSync(file, assistant([{ type: 'text', text: 'OPERATOR-REPLY [operator] finished' }]))
    await t.tick({ isAlive: () => true, isActive: () => false })
    expect(seen).toHaveLength(1)
    expect(seen[0].projectId).toBe('proj')
    expect(seen[0].text).toBe('finished')
  })

  it('does NOT fire a sentinel that appears in a thinking block', async () => {
    writeFileSync(file, '')
    const t = new Transcript()
    t.register('t0', { claudeSessionId: SESSION, cwd: '/Users/dev/thing', projectId: 'proj' })
    await t.tick({ isAlive: () => true, isActive: () => false })
    const seen: unknown[] = []
    t.on('dispatch', (d) => seen.push(d))
    appendFileSync(file, assistant([{ type: 'thinking', thinking: 'OPERATOR-DISPATCH [qa] considering it' }]))
    await t.tick({ isAlive: () => true, isActive: () => false })
    expect(seen).toEqual([])   // considering a directive is not issuing one
  })
})
