import { describe, it, expect } from 'vitest'
import { buildArgs } from './launch-args'

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
