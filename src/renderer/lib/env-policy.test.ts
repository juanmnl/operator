import { describe, it, expect } from 'vitest'
import { denyReason, isValidEnvName, validateEnvName } from './env-policy'

describe('denyReason — TWO reasons, and the UI must say which', () => {
  it('names Operator manages say so, and say it will be replaced at spawn', () => {
    const d = denyReason('PORT')!
    expect(d.reason).toBe('operator-manages')
    expect(d.message).toContain('Operator manages PORT')
    expect(d.message).toContain('replaced at spawn')
  })

  it('names Claude Code ignores say THAT — the worse one to get wrong, because it fails silently', () => {
    const d = denyReason('CLAUDE_CODE_ENTRYPOINT')!
    expect(d.reason).toBe('claude-ignores')
    expect(d.message).toContain('silently do nothing')
  })

  it('covers the whole CLAUDE_CODE_ family by prefix, plus CLAUDECODE exactly', () => {
    expect(denyReason('CLAUDE_CODE_ANYTHING_AT_ALL')?.reason).toBe('claude-ignores')
    expect(denyReason('CLAUDECODE')?.reason).toBe('claude-ignores')
  })

  it('does NOT deny the auth names that merely start with CLAUDE — taking those breaks a lane', () => {
    // The same closed-set rule `stripNestedSessionEnv` follows: a tempting `CLAUDE_*` wildcard
    // would swallow ANTHROPIC_API_KEY's neighbours and CLAUDE_CONFIG_DIR with it.
    expect(denyReason('CLAUDE_CONFIG_DIR')).toBeNull()
    expect(denyReason('ANTHROPIC_API_KEY')).toBeNull()
  })

  it('denies every terminal-capability name Operator sets to match the real pty', () => {
    for (const n of ['TERM', 'FORCE_COLOR', 'COLORTERM', 'COLORFGBG', 'TERM_PROGRAM']) {
      expect(denyReason(n)?.reason, n).toBe('operator-manages')
    }
  })

  it('denies the per-lane port names — pinning those gives every lane the same port', () => {
    for (const n of ['PORT', 'OPERATOR_DEV_PORT', 'OPERATOR_TERMINAL_ID', 'OPERATOR_APP_PID']) {
      expect(denyReason(n)?.reason, n).toBe('operator-manages')
    }
  })

  it('allows an ordinary name', () => {
    expect(denyReason('NODE_ENV')).toBeNull()
    expect(denyReason('VITE_API_BASE')).toBeNull()
  })

  it('is CASE-SENSITIVE, because the shell is — `port` is not `PORT`', () => {
    expect(denyReason('port')).toBeNull()
  })
})

describe('isValidEnvName', () => {
  it('accepts what a shell can export', () => {
    expect(isValidEnvName('NODE_ENV')).toBe(true)
    expect(isValidEnvName('_private')).toBe(true)
    expect(isValidEnvName('a1')).toBe(true)
  })
  it('refuses what it cannot', () => {
    for (const n of ['1ST', 'MY-VAR', 'MY VAR', 'MY.VAR', '', 'É']) expect(isValidEnvName(n), n).toBe(false)
  })
})

describe('validateEnvName — the one call a form makes', () => {
  it('complains about SHAPE before policy: the hyphen is the real problem here, not the denylist', () => {
    expect(validateEnvName('MY-VAR')).toContain('Letters, digits and underscores')
  })

  it('requires a name', () => {
    expect(validateEnvName('   ')).toBe('A name is required.')
  })

  it('passes the denial message straight through, so both surfaces say it identically', () => {
    expect(validateEnvName('PORT')).toBe(denyReason('PORT')!.message)
  })

  it('refuses a duplicate with the sentence that explains the consequence', () => {
    expect(validateEnvName('NODE_ENV', ['NODE_ENV'])).toBe('Already set above — the last one wins.')
  })

  it('trims before judging — a trailing space is a typo, not a different variable', () => {
    expect(validateEnvName('  NODE_ENV  ', ['NODE_ENV'])).toBe('Already set above — the last one wins.')
  })

  it('returns null for a good name', () => {
    expect(validateEnvName('API_BASE', ['NODE_ENV'])).toBeNull()
  })
})
