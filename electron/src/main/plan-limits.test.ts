import { describe, it, expect, afterAll, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchPlanLimits, parseUsage, percentIn, resetsIn, parenLabel } from './plan-limits'

describe('field extractors', () => {
  it('reads the number immediately before the % sign', () => {
    expect(percentIn('Current session: 47% used')).toBe(47)
    expect(percentIn('Current week (all models): 8%')).toBe(8)
  })
  it('clamps above 100 and returns null with no percentage', () => {
    expect(percentIn('999%')).toBe(100)
    expect(percentIn('no number here')).toBeNull()
    expect(percentIn('% leading sign')).toBeNull()
  })
  it('reads the reset phrase', () => {
    expect(resetsIn('Current session: 47% · resets in 2h 14m')).toBe('in 2h 14m')
    expect(resetsIn('no reset here')).toBeNull()
  })
  it('reads a parenthesised label', () => {
    expect(parenLabel('Current week (Fable): 3%')).toBe('Fable')
    expect(parenLabel('Current week: 3%')).toBeNull()
  })
})

describe('parseUsage', () => {
  it('reads a full answer', () => {
    const r = parseUsage([
      'You are currently using your subscription.',
      'Current session: 47% · resets in 2h 14m',
      'Current week (all models): 8% · resets Thursday',
      'Current week (Fable): 3% · resets Thursday',
    ].join('\n'))
    expect(r.plan).toBe('You are currently using your subscription.')
    expect(r.sessionPct).toBe(47)
    expect(r.sessionResets).toBe('in 2h 14m')
    expect(r.weekPct).toBe(8)
    expect(r.modelLabel).toBe('Fable')
    expect(r.modelPct).toBe(3)
    expect(r.note).toBeUndefined()
  })

  it('treats an UNLABELLED weekly line as the overall one', () => {
    const r = parseUsage('Current week: 12% · resets Thursday')
    expect(r.weekPct).toBe(12)
    expect(r.modelPct).toBeUndefined()
  })

  it('stops at the contributing breakdown', () => {
    const r = parseUsage("Current session: 5%\nWhat's contributing\nCurrent week: 99%")
    expect(r.sessionPct).toBe(5)
    expect(r.weekPct).toBeUndefined() // past the heading — not a meter
  })

  it('SURFACES an unexpected answer as a note rather than as zeroes', () => {
    // An empty meter with no explanation is indistinguishable from a broken one.
    const r = parseUsage('Login required to view usage.')
    expect(r.sessionPct).toBeUndefined()
    expect(r.note).toContain('Login required')
  })

  it('notes an empty answer', () => {
    expect(parseUsage('').note).toMatch(/returned nothing/)
  })

  it('does not mistake a percentage line for the plan sentence', () => {
    const r = parseUsage('Your subscription is at 40%\nCurrent session: 40%')
    expect(r.plan).toBeUndefined()
  })
})

// THE REGRESSION. Packaged 0.17.0 ran `/bin/sh -ilc`, which reads `~/.profile` and never
// `~/.zshrc` — so `~/.local/bin` was off PATH and the card said "sh: claude: command not found"
// (plus "no job control", `sh -i` with no tty). Driven for real rather than mocked: a stand-in
// $SHELL on disk, which only gets to answer if the spawn actually honours SHELL.
describe('fetchPlanLimits runs through the USER\'S login shell', () => {
  const SHELL = process.env.SHELL
  const dir = mkdtempSync(join(tmpdir(), 'operator-shell-test-'))
  afterAll(() => { rmSync(dir, { recursive: true, force: true }) })
  afterEach(() => { if (SHELL === undefined) delete process.env.SHELL; else process.env.SHELL = SHELL })

  function fakeShell(body: string): string {
    const path = join(dir, `shell-${Math.abs(body.length)}-${body.charCodeAt(0)}.sh`)
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    return path
  }

  it('asks $SHELL, and parses what it answers', async () => {
    // A shell that knows where `claude` is — i.e. the user's own, which is the whole point.
    process.env.SHELL = fakeShell([
      `echo "argv: $1 $2" >&2`,
      'echo "You are currently using your subscription."',
      'echo "Current session: 42% · resets in 1h 5m"',
    ].join('\n'))
    const r = await fetchPlanLimits(true)
    expect(r.sessionPct).toBe(42)
    expect(r.sessionResets).toBe('in 1h 5m')
    expect(r.note).toBeUndefined() // no "command not found"
  })

  it('is invoked as an INTERACTIVE login shell — `-ilc`, as planlimits.rs does', async () => {
    // The shell echoes its own argv back, dressed as the plan line so the parser carries it out
    // (`plan` is the line mentioning a subscription without a percentage).
    process.env.SHELL = fakeShell('echo "subscription invoked as: $1 :: $2"')
    const r = await fetchPlanLimits(true)
    expect(r.plan).toBe("subscription invoked as: -ilc :: claude -p '/usage'")
  })
})
