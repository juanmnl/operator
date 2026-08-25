import { describe, it, expect } from 'vitest'
import { buildArgs, mcpConfigArg } from './launch-args'

describe('buildArgs', () => {
  it('pins a new session id', () => {
    expect(buildArgs({}, 'uuid-1')).toEqual(['--session-id', 'uuid-1'])
  })

  it('resume takes precedence over a session id', () => {
    expect(buildArgs({ resumeSessionId: 'old' }, 'uuid-1')).toEqual(['--resume', 'old'])
  })

  it('omits permission flag for default mode', () => {
    expect(buildArgs({ permissionMode: 'default' }, 'u')).toEqual(['--session-id', 'u'])
  })

  it('maps bypassPermissions to the skip flag', () => {
    expect(buildArgs({ permissionMode: 'bypassPermissions' }, 'u')).toEqual([
      '--session-id', 'u', '--dangerously-skip-permissions',
    ])
  })

  it('passes other permission modes through', () => {
    expect(buildArgs({ permissionMode: 'plan' }, 'u')).toEqual([
      '--session-id', 'u', '--permission-mode', 'plan',
    ])
  })

  it('splits allowedTools on whitespace and drops empties', () => {
    expect(buildArgs({ allowedTools: 'Read  Edit\tBash' }, 'u')).toEqual([
      '--session-id', 'u', '--allowedTools', 'Read', 'Edit', 'Bash',
    ])
  })

  it('appends a trimmed initial prompt, ignoring whitespace-only', () => {
    expect(buildArgs({ initialPrompt: '  hi  ' }, 'u')).toEqual(['--session-id', 'u', 'hi'])
    expect(buildArgs({ initialPrompt: '   ' }, 'u')).toEqual(['--session-id', 'u'])
  })

  it('composes every option in order', () => {
    expect(buildArgs({ model: 'opus', permissionMode: 'plan', initialPrompt: 'go' }, 'u')).toEqual([
      '--session-id', 'u', '--permission-mode', 'plan', '--model', 'opus', 'go',
    ])
  })
})

describe('mcpConfigArg — the client half of the artifact plane', () => {
  // The whole bug: this flag was never built, so `operator__report` was in no lane's tool list
  // from the day the Electron shell shipped. 0 of 13 live lanes had it; 0 calls in any transcript.
  it('names the operator server, pointed at the binary running us', () => {
    expect(JSON.parse(mcpConfigArg('/Applications/Operator.app/Contents/MacOS/Operator')))
      .toEqual({
        mcpServers: {
          operator: { command: '/Applications/Operator.app/Contents/MacOS/Operator', args: ['--mcp-serve'] },
        },
      })
  })

  // In dev `process.execPath` is the `electron` binary, which opens an empty shell and answers
  // nothing unless it is given the app directory first. Getting this wrong fails silently — the
  // lane launches fine and simply has no tool.
  it('passes the app path first in DEV, where execPath is electron itself', () => {
    const cfg = JSON.parse(mcpConfigArg('/repo/node_modules/.bin/electron', '/repo/electron'))
    expect(cfg.mcpServers.operator.args).toEqual(['/repo/electron', '--mcp-serve'])
  })

  it('is valid JSON on one line — it is passed inline as a CLI argument', () => {
    const s = mcpConfigArg('/x/Operator')
    expect(s.includes('\n')).toBe(false)
    expect(() => JSON.parse(s)).not.toThrow()
  })
})
