// The phase around a compaction, driven by real transcript fragments.
//
// `compact-idle` is Claude Code 2.1.299 records with the text replaced: a turn that ends
// (`end_turn`), then, 51 minutes later, an IDLE compaction — boundary, the `isCompactSummary`
// re-prime, attachments, and the `informational` notice "Compacted while idle, before the prompt
// cache expired". Nothing follows it: the lane is waiting for its next prompt. The 2.1.300 binary
// writes the same notice from the same path (`compactConversation`, between turns only).
//
// `compact-midturn` is Claude Code 2.1.283 records with the text replaced: an auto-compaction in
// the middle of a turn — tool_use, its result, boundary, re-prime, attachments, then the model
// carrying on with another tool call.
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SANDBOX = mkdtempSync(join(tmpdir(), 'operator-compact-test-'))
process.env.HOME = SANDBOX
process.env.OPERATOR_DIR = join(SANDBOX, 'operator-home')
const { Transcript, COMPACTING_CEILING_MS } = await import('./transcript')

const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const dir = join(SANDBOX, '.claude', 'projects', '-Users-dev-thing')
const file = join(dir, `${SESSION}.jsonl`)
mkdirSync(dir, { recursive: true })
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))
afterEach(() => { vi.restoreAllMocks() })

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}.jsonl`, import.meta.url)), 'utf8')
const records = (name: string) => fixture(name).split('\n').filter(Boolean)
const L = (o: unknown) => `${JSON.stringify(o)}\n`

async function tailer(lines: string) {
  writeFileSync(file, lines)
  const t = new Transcript()
  t.register('t0', { claudeSessionId: SESSION, cwd: '/Users/dev/thing', projectId: 'p1' })
  const tick = (isActive = false) => t.tick({ isAlive: () => true, isActive: () => isActive })
  await tick()
  return { t, tick, phase: () => t.sessions()[0].phase }
}

describe('idle compaction (2.1.299 records)', () => {
  it('reads `waiting` once the idle notice lands, not `compacting` or `running`', async () => {
    const { phase } = await tailer(fixture('compact-idle'))
    expect(phase()).toBe('waiting')
  })

  it('still reads `waiting` after the compacting ceiling has passed', async () => {
    // Before the fix this was `running` for good: the re-prime had set `lastWasUserPrompt`, and
    // once the ceiling dropped the compacting claim, "prompt sent, response not started" was left.
    const { phase, tick } = await tailer(fixture('compact-idle'))
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + COMPACTING_CEILING_MS + 1000)
    await tick()
    expect(phase()).toBe('waiting')
  })

  it('reads `compacting` between the re-prime and the notice', async () => {
    // Cut just before the notice: the boundary and re-prime are written, the notice is not yet.
    const lines = records('compact-idle')
    const notice = lines.findIndex((l) => JSON.parse(l).subtype === 'informational')
    const { phase, tick } = await tailer(`${lines.slice(0, notice).join('\n')}\n`)
    expect(phase()).toBe('compacting')
    appendFileSync(file, `${lines[notice]}\n`)
    await tick()
    expect(phase()).toBe('waiting')
  })

  it('the re-prime is not announced as a work prompt', async () => {
    // The fragment's only `user` records are tool results and the re-prime; none is new work. A
    // `prompt` event here would tell the lane lifecycle that a released lane took up new work.
    writeFileSync(file, fixture('compact-idle'))
    const t = new Transcript()
    t.register('t0', { claudeSessionId: SESSION, cwd: '/Users/dev/thing', projectId: 'p1' })
    const prompts: unknown[] = []
    t.on('prompt', (e) => prompts.push(e))
    await t.tick({ isAlive: () => true, isActive: () => false })
    expect(prompts).toEqual([])
  })

  it('a prompt typed after it starts a turn as usual', async () => {
    const { phase, tick } = await tailer(fixture('compact-idle'))
    appendFileSync(file, L({ type: 'user', isSidechain: false, timestamp: '2026-10-14T07:10:00.000Z', message: { role: 'user', content: 'next task' } }))
    await tick()
    expect(phase()).toBe('running')
  })
})

describe('mid-turn compaction (2.1.283 records)', () => {
  it('reads `compacting` up to the re-prime and its attachments', async () => {
    const lines = records('compact-midturn')
    const firstAssistantAfter = lines.findIndex((l, i) => i > 2 && JSON.parse(l).type === 'assistant')
    const { phase } = await tailer(`${lines.slice(0, firstAssistantAfter).join('\n')}\n`)
    expect(phase()).toBe('compacting')
  })

  it('reads `running` once the model carries on with a tool call', async () => {
    const { phase } = await tailer(fixture('compact-midturn'))
    expect(phase()).toBe('running')
  })

  it('stays `running` past the ceiling if no record arrives, since the turn was mid-tool', async () => {
    // Cut before the model speaks again. The turn was in flight (last stop reason `tool_use`), so
    // dropping the compacting claim must fall back to running, not waiting.
    const lines = records('compact-midturn')
    const firstAssistantAfter = lines.findIndex((l, i) => i > 2 && JSON.parse(l).type === 'assistant')
    const { phase, tick } = await tailer(`${lines.slice(0, firstAssistantAfter).join('\n')}\n`)
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + COMPACTING_CEILING_MS + 1000)
    await tick()
    expect(phase()).toBe('running')
  })
})

describe('local slash commands (2.1.276 record shape)', () => {
  // `/model` at the end of a turn writes two `user` records and no assistant: the command echo and
  // its stdout. `/compact` goes through the same local-command path. Neither is a prompt to the
  // model, so neither may leave the lane reading `running`.
  const endTurn = L({ type: 'assistant', isSidechain: false, timestamp: '2026-09-20T15:34:00.000Z', message: { id: 'm1', role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } })
  const echo = L({ type: 'user', isSidechain: false, timestamp: '2026-09-20T15:35:00.852Z', message: { role: 'user', content: '<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>' } })
  const stdout = L({ type: 'user', isSidechain: false, timestamp: '2026-09-20T15:35:00.852Z', message: { role: 'user', content: '<local-command-stdout>Set model to `Fable 5.1` and saved as your default for new sessions</local-command-stdout>' } })

  it('a local command at the end of a turn leaves the lane `waiting`', async () => {
    const { phase } = await tailer(endTurn + echo + stdout)
    expect(phase()).toBe('waiting')
  })

  it('a prompt-type command still reads `running`: its expansion is an `isMeta` text record', async () => {
    // Shape from real 2.1.28x `/doctor` invocations: the echo, then the expanded prompt as an
    // `isMeta` user record with a text block, then the assistant.
    const promptEcho = L({ type: 'user', isSidechain: false, timestamp: '2026-09-20T15:36:00.000Z', message: { role: 'user', content: '<command-message>doctor</command-message>\n<command-name>/doctor</command-name>' } })
    const expansion = L({ type: 'user', isSidechain: false, isMeta: true, timestamp: '2026-09-20T15:36:00.001Z', message: { role: 'user', content: [{ type: 'text', text: '[expanded command prompt]' }] } })
    const { phase } = await tailer(endTurn + promptEcho + expansion)
    expect(phase()).toBe('running')
  })
})
