import { describe, it, expect } from 'vitest'
import { sessionLabel, cleanSessionSummary } from './session-label'
import type { AgentSession } from '../../shared/types'

const s = (over: Partial<AgentSession> = {}): AgentSession => ({
  id: 's1', agentId: 'claude-code', workingDirectory: '/p', projectName: 'p',
  status: 'active', phase: 'idle', activity: [], activeSubagents: 0, lastToolName: null,
  startedAt: 't', lastActivityAt: 't', ...over,
} as AgentSession)

// The exact strings Operator injects (both the current and the original wording).
const NEW_INSTR = "First, make sure this project's dev server is up on the port Operator reserved for you (named in your system prompt): if that port already responds, another lane is serving the same code — just use it."
const OLD_INSTR = "First, start this project's dev server in the BACKGROUND on the port Operator reserved for you (named in your system prompt — pass it via --port or the PORT env), and don't block the terminal on it."

describe('cleanSessionSummary', () => {
  it('strips the injected dev-server preamble and keeps the real task', () => {
    expect(cleanSessionSummary(`${NEW_INSTR}\n\nFix the login button alignment`)).toBe('Fix the login button alignment')
    expect(cleanSessionSummary(`${OLD_INSTR}\n\nProfile the settings list`)).toBe('Profile the settings list')
  })

  it('returns undefined when the preamble is ALL there is', () => {
    // This is the case that made every dashboard row read identically.
    expect(cleanSessionSummary(NEW_INSTR)).toBeUndefined()
    expect(cleanSessionSummary(OLD_INSTR)).toBeUndefined()
  })

  it('leaves an ordinary summary alone, and drops injected plumbing turns', () => {
    expect(cleanSessionSummary('Extract the dispatch router')).toBe('Extract the dispatch router')
    expect(cleanSessionSummary('<local-command-stdout>ok')).toBeUndefined()
    expect(cleanSessionSummary(undefined)).toBeUndefined()
    // A genuine prompt may legitimately start with '<'.
    expect(cleanSessionSummary('<Modal> crashes on mount')).toBe('<Modal> crashes on mount')
  })
})

describe('sessionLabel', () => {
  const role = { id: 'code', name: 'Code', model: 'opus' }

  it('walks the ladder: custom name → lane → prompt → model → fallback', () => {
    expect(sessionLabel({ session: s({ summary: 'x' }), role, customName: 'My agent' })).toBe('My agent')
    expect(sessionLabel({ session: s({ summary: 'x' }), role })).toBe('Code')
    expect(sessionLabel({ session: s({ summary: 'Extract the router', model: 'opus' }) })).toBe('Extract the router')
    expect(sessionLabel({ session: s({ model: 'claude-opus-4-20250514' }) })).toBe('Opus')
    expect(sessionLabel({ session: s(), fallback: 'Session 2' })).toBe('Session 2')
    expect(sessionLabel({ session: s() })).toBe('Session')
  })

  it('does not label an agent with the dev-server preamble', () => {
    // Falls past the useless summary to the model rather than showing boilerplate.
    expect(sessionLabel({ session: s({ summary: NEW_INSTR, model: 'sonnet' }) })).toBe('Sonnet')
  })

  it('never uses the <synthetic> API-error placeholder as a name', () => {
    expect(sessionLabel({ session: s({ model: '<synthetic>' }), fallback: 'Session 3' })).toBe('Session 3')
  })
})
