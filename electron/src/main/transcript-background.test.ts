// Background tasks a lane's CLI started and has not seen finish, for idle-lane suspension
// (src/renderer/lib/idle-suspend.ts): ending the CLI ends them.
//
// The records are real Claude Code shapes (2.1.272–2.1.301, read from this machine's transcripts
// on 2026-10-16) with paths and prompts shortened: a Bash `run_in_background` result, an Agent's
// `Async agent launched` result, a command moved to the background at its timeout, and the
// `<task-notification>` that closes each, as a queued prompt, a `queued_command` attachment and a
// plain user turn.
import { describe, it, expect } from 'vitest'
import { Track, notifiedToolUseIds } from './transcript'

const SPAWN = Date.parse('2026-10-16T10:00:00.000Z')
const at = (s: number) => new Date(SPAWN + s * 1000).toISOString()

const track = (spawnedAt = SPAWN) => new Track('t0', { claudeSessionId: 's', cwd: '/x', projectId: 'p' }, spawnedAt)

const toolUse = (id: string, name: string, input: Record<string, unknown>, s: number) => ({
  type: 'assistant', isSidechain: false, timestamp: at(s),
  message: { model: 'claude-opus-5-5', id: `msg_${id}`, type: 'message', role: 'assistant', content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' },
})
const toolResult = (id: string, content: unknown, s: number) => ({
  type: 'user', isSidechain: false, timestamp: at(s),
  message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content, is_error: false }] },
})
const notification = (taskId: string, id: string, status = 'completed') =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${id}</tool-use-id>\n<output-file>/private/tmp/x/tasks/${taskId}.output</output-file>\n<status>${status}</status>\n<summary>Background command "npx vite --port 1444" completed (exit code 0)</summary>\n</task-notification>`

const bashBackground = (id: string, s: number) => [
  toolUse(id, 'Bash', { command: 'npx vite --port 1444 --strictPort', run_in_background: true }, s),
  toolResult(id, `Command running in background with ID: bmvt863b0. Output is being written to: /private/tmp/x/tasks/bmvt863b0.output. You will be notified when it completes. To check interim output, use Read on that file path.`, s + 1),
]

describe('background tasks from the transcript', () => {
  it('counts a Bash run_in_background until its notification is enqueued', () => {
    const t = track()
    for (const r of bashBackground('toolu_01Hg', 10)) t.apply(r)
    expect(t.toSession('waiting').backgroundTasks).toBe(1)
    t.apply({ type: 'queue-operation', operation: 'enqueue', timestamp: at(60), sessionId: 's', content: notification('bmvt863b0', 'toolu_01Hg') })
    expect(t.toSession('waiting').backgroundTasks).toBeUndefined()
  })

  it('counts an async Agent until its notification arrives as a queued_command attachment', () => {
    const t = track()
    t.apply(toolUse('toolu_01W9', 'Agent', { description: 'B3 comments', subagent_type: 'general-purpose', prompt: 'Read the brief' }, 10))
    t.apply(toolResult('toolu_01W9', [{ type: 'text', text: 'Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: a88914ba4ca8ea3da' }], 11))
    expect(t.toSession('waiting').backgroundTasks).toBe(1)
    t.apply({ type: 'attachment', isSidechain: false, timestamp: at(90), attachment: { type: 'queued_command', prompt: notification('a88914ba4ca8ea3da', 'toolu_01W9') } })
    expect(t.toSession('waiting').backgroundTasks).toBeUndefined()
  })

  it('counts a command moved to the background at its timeout, closed by a plain user turn', () => {
    const t = track()
    t.apply(toolUse('toolu_01Mv', 'Bash', { command: 'npm test' }, 10))
    t.apply(toolResult('toolu_01Mv', 'Command timed out and was moved to the background (ID: b413z3iax). Output is being written to: /private/tmp/x/tasks/b413z3iax.output', 130))
    expect(t.toSession('waiting').backgroundTasks).toBe(1)
    t.apply({ type: 'user', isSidechain: false, timestamp: at(200), message: { role: 'user', content: notification('b413z3iax', 'toolu_01Mv', 'killed') } })
    expect(t.toSession('waiting').backgroundTasks).toBeUndefined()
  })

  it('ignores an ordinary tool result', () => {
    const t = track()
    t.apply(toolUse('toolu_01Ls', 'Bash', { command: 'ls' }, 10))
    t.apply(toolResult('toolu_01Ls', 'a\nb\n', 11))
    expect(t.toSession('waiting').backgroundTasks).toBeUndefined()
  })

  it('does not count a background task the previous process started (a resumed transcript)', () => {
    // The transcript is read from the start after `--resume`; that process's task died with it.
    const t = track(SPAWN + 3_600_000)
    for (const r of bashBackground('toolu_old', 10)) t.apply(r)
    expect(t.toSession('waiting').backgroundTasks).toBeUndefined()
    for (const r of bashBackground('toolu_new', 3_700)) t.apply(r)
    expect(t.toSession('waiting').backgroundTasks).toBe(1)
  })

  it('reads every tool-use id a notification names', () => {
    expect(notifiedToolUseIds(notification('a', 'toolu_1') + notification('b', 'toolu_2'))).toEqual(['toolu_1', 'toolu_2'])
    expect(notifiedToolUseIds('<tool-use-id>toolu_1</tool-use-id>')).toEqual([])
  })
})
