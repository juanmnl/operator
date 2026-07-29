import { describe, it, expect } from 'vitest'
import type { AgentSession } from '../../shared/types'
import { chatSignal, toolVerb } from './chat-signal'

const s = (o: Partial<AgentSession>): AgentSession =>
  ({ status: 'active', phase: 'idle', lastToolName: null, activeSubagents: 0, ...o } as AgentSession)

describe('toolVerb', () => {
  it('turns the tool jargon into what the agent is doing', () => {
    expect(toolVerb('Edit')).toBe('Editing')
    expect(toolVerb('Bash')).toBe('Running a command')
    expect(toolVerb('Grep')).toBe('Searching')
    expect(toolVerb('Task')).toBe('Delegating')
  })

  it('names the SERVER for an MCP tool, not the whole underscore soup', () => {
    expect(toolVerb('mcp__chrome-devtools__navigate')).toBe('Using chrome-devtools')
  })

  it('falls back to the tool name for anything unknown, and to null for none', () => {
    expect(toolVerb('SomeNewTool')).toBe('Running SomeNewTool')
    expect(toolVerb(null)).toBeNull()
    expect(toolVerb(undefined)).toBeNull()
  })
})

describe('chatSignal', () => {
  it('says nothing at all when a live session is idle — the line takes no space', () => {
    expect(chatSignal(s({ phase: 'idle' }))).toBeNull()
    expect(chatSignal(undefined)).toBeNull()
  })

  it('reports the running tool, and only running/compacting may animate', () => {
    const run = chatSignal(s({ phase: 'running', lastToolName: 'Edit' }))!
    expect(run).toMatchObject({ kind: 'running', label: 'Editing', animate: true, interruptible: true })

    const comp = chatSignal(s({ phase: 'compacting' }))!
    expect(comp).toMatchObject({ kind: 'compacting', label: 'Compacting context', animate: true })

    // MOTION MEANS BUSY: waiting rests static and says so in words instead.
    const wait = chatSignal(s({ phase: 'waiting' }))!
    expect(wait).toMatchObject({ kind: 'waiting', label: 'Your turn', animate: false, interruptible: false })
  })

  it('says "Thinking" while running with no tool open', () => {
    expect(chatSignal(s({ phase: 'running', lastToolName: null })!)!.label).toBe('Thinking')
  })

  it('folds subagent count into the line', () => {
    expect(chatSignal(s({ phase: 'running', lastToolName: 'Task', activeSubagents: 3 }))!.label)
      .toBe('Delegating · 3 subagents')
    expect(chatSignal(s({ phase: 'running', lastToolName: 'Task', activeSubagents: 1 }))!.label)
      .toBe('Delegating · 1 subagent')
  })

  it('an ended session says so and is not interruptible', () => {
    expect(chatSignal(s({ status: 'ended', phase: 'running' }))!)
      .toMatchObject({ kind: 'ended', label: 'Session ended', animate: false, interruptible: false })
  })
})
