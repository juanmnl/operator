// The `asking` phase: a lane whose latest turn has an AskUserQuestion call with no result yet.
//
// The fixtures are real Claude Code 2.1.259 records with the text replaced: an assistant message
// streamed as three records sharing one message id (thinking, text, then the tool_use), and the
// user record that carries the tool_result. The answered and declined results are the two result
// shapes the CLI writes for this tool.
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SANDBOX = mkdtempSync(join(tmpdir(), 'operator-asking-test-'))
process.env.HOME = SANDBOX
process.env.OPERATOR_DIR = join(SANDBOX, 'operator-home')
const { Transcript, derivePhase } = await import('./transcript')
const { isBusy } = await import('./quit')
const { aggregateState } = await import('./tray-anim')

const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const dir = join(SANDBOX, '.claude', 'projects', '-Users-dev-thing')
const file = join(dir, `${SESSION}.jsonl`)
mkdirSync(dir, { recursive: true })
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}.jsonl`, import.meta.url)), 'utf8')

async function tailer(lines: string) {
  writeFileSync(file, lines)
  const t = new Transcript()
  t.register('t0', { claudeSessionId: SESSION, cwd: '/Users/dev/thing', projectId: 'p1' })
  const tick = (isActive = false) => t.tick({ isAlive: () => true, isActive: () => isActive })
  await tick()
  return { t, tick, phase: () => t.sessions()[0].phase }
}

describe('asking — detection from real transcript records', () => {
  it('an AskUserQuestion with no result is `asking`, not `running`', async () => {
    const { phase } = await tailer(fixture('asking-open'))
    expect(phase()).toBe('asking')
  })

  it('stays `asking` while the pty is busy, because the question dialog redraws as the user moves through it', async () => {
    const { phase } = await tailer(fixture('asking-open'))
    expect(phase()).toBe('asking')
    const again = await tailer(fixture('asking-open'))
    await again.tick(true)
    expect(again.phase()).toBe('asking')
  })

  it('clears the moment the answer lands', async () => {
    const { phase, tick } = await tailer(fixture('asking-open'))
    expect(phase()).toBe('asking')
    const answered = fixture('asking-answered')
    appendFileSync(file, answered.slice(fixture('asking-open').length))
    await tick()
    expect(phase()).not.toBe('asking')
  })

  it('an answered question read from the start is not asking', async () => {
    const { phase } = await tailer(fixture('asking-answered'))
    expect(phase()).not.toBe('asking')
  })

  it('a declined question (Esc, an error result) clears it too', async () => {
    const { phase } = await tailer(fixture('asking-declined'))
    expect(phase()).not.toBe('asking')
  })

  it('a subagent’s AskUserQuestion does not make the lane asking', async () => {
    const side = fixture('asking-open').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l))
      .map((r) => (r.type === 'assistant' ? { ...r, isSidechain: true } : r))
      .map((r) => JSON.stringify(r)).join('\n') + '\n'
    const { phase } = await tailer(side)
    expect(phase()).not.toBe('asking')
  })

  it('a PERMISSION PROMPT cannot be told apart and reads `running` — the transcript writes nothing until it is decided', async () => {
    // Checked against real rejected Bash calls: the tool_use is the last record for the whole time
    // the prompt is on screen, and the next record is the result. That is also exactly what a
    // long-running Bash looks like, so claiming `asking` here would be wrong for every slow tool.
    const { phase } = await tailer(fixture('permission-pending'))
    expect(phase()).toBe('running')
  })
})

describe('derivePhase with a question open', () => {
  it('asking outranks an open tool (the question IS an open tool) but not a compaction', () => {
    expect(derivePhase(true, 'tool_use', false, false, true)).toBe('asking')
    expect(derivePhase(true, 'tool_use', false, true, true)).toBe('compacting')
    expect(derivePhase(true, 'tool_use', false, false)).toBe('running')
  })
})

describe('asking in the main process', () => {
  it('holds quit: a lane blocked on a question is the lane the guard exists for', () => {
    expect(isBusy('asking')).toBe(true)
  })

  it('the tray shows asking even while another lane is busy', () => {
    expect(aggregateState([{ phase: 'running' }, { phase: 'asking' }])).toBe('asking')
    expect(aggregateState([{ phase: 'asking' }, { phase: 'running' }])).toBe('asking')
    expect(aggregateState([{ phase: 'running' }, { phase: 'waiting' }])).toBe('busy')
    expect(aggregateState([{ phase: 'waiting' }])).toBe('your-turn')
  })
})
