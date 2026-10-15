// The phase around a compaction, driven by real transcript fragments.
//
// `compact-idle` is Claude Code 2.1.299 records with the text replaced: a turn that ends
// (`end_turn`), then, 51 minutes later, an IDLE compaction — boundary, the `isCompactSummary`
// re-prime, attachments, and the `informational` notice "Compacted while idle, before the prompt
// cache expired". Nothing follows it: the lane is waiting for its next prompt. The 2.1.300 binary
// writes the same notice from the same path (`compactConversation`, between turns only).
//
// `compact-idle-after-hook` is Claude Code 2.1.295 records with the text replaced: a `/goal` Stop
// hook blocked the turn nine times and was overridden, so the turn ended on the hook's `isMeta`
// feedback record, with no assistant after it, then `turn_duration`. 54 minutes later the lane was
// compacted while idle.
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

  it('reads `waiting` without the notice: a boundary after `turn_duration` is an idle compaction', async () => {
    // The text-free rule, in case the notice's wording changes. Cut just before the notice.
    const lines = records('compact-idle')
    const notice = lines.findIndex((l) => JSON.parse(l).subtype === 'informational')
    const { phase, tick } = await tailer(`${lines.slice(0, notice).join('\n')}\n`)
    expect(phase()).toBe('waiting')
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + COMPACTING_CEILING_MS + 1000)
    await tick()
    expect(phase()).toBe('waiting')
  })

  it('without a `turn_duration` before it, reads `compacting` until the notice', async () => {
    // The notice is then what ends it.
    const lines = records('compact-idle').filter((l) => JSON.parse(l).subtype !== 'turn_duration')
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

describe('idle compaction after a turn that ended on a `user` record (2.1.295 records)', () => {
  const lines = records('compact-idle-after-hook')
  const at = (subtype: string) => lines.findIndex((l) => JSON.parse(l).subtype === subtype)

  it('reads `running` while the hook holds the turn open', async () => {
    // Cut after the hook's feedback record, before the turn ends: the turn is still in flight.
    const { phase } = await tailer(`${lines.slice(0, at('turn_duration')).join('\n')}\n`)
    expect(phase()).toBe('running')
  })

  it('reads `waiting` once `turn_duration` lands', async () => {
    const { phase } = await tailer(`${lines.slice(0, at('turn_duration') + 1).join('\n')}\n`)
    expect(phase()).toBe('waiting')
  })

  it('reads `waiting` after the idle compaction, and past the ceiling', async () => {
    // Before the fix this was `running`: the feedback record had set `lastWasUserPrompt` and
    // nothing cleared it, so once the notice ended the compaction the lane read busy.
    const { phase, tick } = await tailer(fixture('compact-idle-after-hook'))
    expect(phase()).toBe('waiting')
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + COMPACTING_CEILING_MS + 1000)
    await tick()
    expect(phase()).toBe('waiting')
  })

  it('the idle notice alone clears a stale prompt flag', async () => {
    // Without `turn_duration` the boundary reads as mid-turn, and the notice is what ends it. No
    // turn is in flight at that notice, so it must not fall back to `running`.
    const noTurnEnd = lines.filter((l) => JSON.parse(l).subtype !== 'turn_duration')
    const { phase } = await tailer(`${noTurnEnd.join('\n')}\n`)
    expect(phase()).toBe('waiting')
  })
})

describe('turn ended by an Escape interrupt (2.1.274 record shape)', () => {
  // A question declined with Escape: the tool result, then the interrupt as a text `user` record,
  // then `turn_duration`. No assistant follows.
  const ask = L({ type: 'assistant', isSidechain: false, timestamp: '2026-09-17T20:44:12.728Z', message: { id: 'm1', role: 'assistant', model: 'claude-opus-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_1', name: 'AskUserQuestion', input: {} }] } })
  const declined = L({ type: 'user', isSidechain: false, timestamp: '2026-09-17T20:44:47.119Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: "The user doesn't want to proceed with this tool use.", is_error: true }] } })
  const interrupt = L({ type: 'user', isSidechain: false, timestamp: '2026-09-17T20:44:47.122Z', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } })
  const turnEnd = L({ type: 'system', subtype: 'turn_duration', isSidechain: false, isMeta: false, timestamp: '2026-09-17T20:44:47.130Z' })

  it('reads `waiting` once the turn ends', async () => {
    const { phase } = await tailer(ask + declined + interrupt + turnEnd)
    expect(phase()).toBe('waiting')
  })
})

describe('what ends `turnEnded`', () => {
  // `turnEnded` makes a boundary read as an idle compaction. Anything that starts a turn must clear
  // it, or every compaction before that turn's first assistant record would read as idle.
  const turnEnd = L({ type: 'system', subtype: 'turn_duration', isSidechain: false, isMeta: false, timestamp: '2026-10-14T10:00:00.000Z' })
  const prompt = L({ type: 'user', isSidechain: false, timestamp: '2026-10-14T10:05:00.000Z', message: { role: 'user', content: 'carry on' } })
  const boundary = L({ type: 'system', subtype: 'compact_boundary', isSidechain: false, timestamp: '2026-10-14T10:05:30.000Z' })
  const reply = L({ type: 'assistant', isSidechain: false, timestamp: '2026-10-14T10:05:01.000Z', message: { id: 'm-main', role: 'assistant', model: 'claude-opus-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_m', name: 'Read', input: {} }] } })
  const result = L({ type: 'user', isSidechain: false, timestamp: '2026-10-14T10:05:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_m', content: 'ok' }] } })

  it('a boundary straight after `turn_duration` reads as idle', async () => {
    const { phase } = await tailer(turnEnd + boundary)
    expect(phase()).toBe('waiting')
  })

  it('a real prompt clears it: a boundary before the reply reads `compacting`', async () => {
    const { phase } = await tailer(turnEnd + prompt + boundary)
    expect(phase()).toBe('compacting')
  })

  it('a main-thread assistant record clears it', async () => {
    // A turn with no `user` record (2.1.296: a prompt enqueued during `/login`), here without the
    // enqueue so only the assistant record can clear it.
    const { phase } = await tailer(turnEnd + reply + result + boundary)
    expect(phase()).toBe('compacting')
  })

  it('a subagent assistant record does not', async () => {
    const side = L({ type: 'assistant', isSidechain: true, timestamp: '2026-10-14T10:05:01.000Z', message: { id: 'm-side', role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'found it' }] } })
    const { phase } = await tailer(turnEnd + side + boundary)
    expect(phase()).toBe('waiting')
  })

  it('a main-thread enqueue clears it: a turn is about to start', async () => {
    const enqueue = L({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-14T10:05:00.000Z', content: 'keep going' })
    const { phase } = await tailer(turnEnd + enqueue + boundary)
    expect(phase()).toBe('compacting')
  })
})

describe('a prompt between an idle compaction and its notice', () => {
  // The 2.1.300 binary releases the turn guard before it appends the notice, so a queued prompt
  // can start its turn in between. The notice must not clear that turn's prompt flag.
  const lines = records('compact-idle')
  const prompt = L({ type: 'user', isSidechain: false, timestamp: '2026-10-11T22:00:00.000Z', message: { role: 'user', content: 'next task' } })
  const withPromptBeforeNotice = (ls: string[]) => {
    const notice = ls.findIndex((l) => JSON.parse(l).subtype === 'informational')
    return `${ls.slice(0, notice).join('\n')}\n${prompt}${ls.slice(notice).join('\n')}\n`
  }

  it('reads `running` after the notice when the boundary followed `turn_duration`', async () => {
    const { phase } = await tailer(withPromptBeforeNotice(lines))
    expect(phase()).toBe('running')
  })

  it('reads `running` after the notice when there was no `turn_duration`', async () => {
    const noTurnEnd = lines.filter((l) => JSON.parse(l).subtype !== 'turn_duration')
    const { phase } = await tailer(withPromptBeforeNotice(noTurnEnd))
    expect(phase()).toBe('running')
  })
})

describe('`!` bash mode (2.1.270–2.1.296 record shape)', () => {
  // The input, then one `user` string with its output. Claude Code then queries the model: 144 of
  // the 145 commands on disk were followed by an assistant record, 4.2 s later at the median.
  const turnEnd = L({ type: 'system', subtype: 'turn_duration', isSidechain: false, isMeta: false, timestamp: '2026-10-02T14:11:00.000Z' })
  const input = L({ type: 'user', isSidechain: false, timestamp: '2026-10-02T14:11:25.249Z', message: { role: 'user', content: '<bash-input>git status</bash-input>' } })
  const output = L({ type: 'user', isSidechain: false, timestamp: '2026-10-02T14:11:25.400Z', message: { role: 'user', content: '<bash-stdout>On branch main</bash-stdout><bash-stderr></bash-stderr>' } })
  const reply = L({ type: 'assistant', isSidechain: false, timestamp: '2026-10-02T14:11:29.600Z', message: { id: 'm2', role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Clean tree.' }] } })
  const replyEnd = L({ type: 'system', subtype: 'turn_duration', isSidechain: false, isMeta: false, timestamp: '2026-10-02T14:11:29.700Z' })
  const boundary = L({ type: 'system', subtype: 'compact_boundary', isSidechain: false, timestamp: '2026-10-02T14:11:27.000Z' })
  // Shape from the one real no-query case (2.1.272, a command moved to the background).
  const caveat = L({ type: 'user', isSidechain: false, isMeta: true, timestamp: '2026-10-02T14:11:25.248Z', message: { role: 'user', content: '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>' } })

  it('reads `running` from the command until the reply, then `waiting`', async () => {
    const { phase, tick } = await tailer(turnEnd + input + output)
    expect(phase()).toBe('running')
    appendFileSync(file, reply + replyEnd)
    await tick()
    expect(phase()).toBe('waiting')
  })

  it('a compaction before the reply reads `compacting`', async () => {
    const { phase } = await tailer(turnEnd + input + output + boundary)
    expect(phase()).toBe('compacting')
  })

  it('after a `<local-command-caveat>` the command is not sent to the model: reads `waiting`', async () => {
    const { phase } = await tailer(turnEnd + caveat + input + output)
    expect(phase()).toBe('waiting')
  })

  it('the caveat covers its own command only', async () => {
    const { phase } = await tailer(turnEnd + caveat + input + output + input + output)
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
