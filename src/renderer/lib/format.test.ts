import { describe, it, expect } from 'vitest'
import { relativeTime, fmtCost, fmtTokens, modelLabel, fmtDuration, fmtDur, isInjectedTurn, tildePath } from './format'

// relativeTime is anchored to Date.now(); build isos as offsets from "now" so the
// tests are deterministic regardless of wall-clock.
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

describe('relativeTime', () => {
  it('defaults to "just now" under a minute', () => {
    expect(relativeTime(ago(5_000))).toBe('just now')
    expect(relativeTime(ago(0))).toBe('just now')
  })

  it('renders seconds under a minute when subMinuteSeconds is set', () => {
    expect(relativeTime(ago(5_000), { subMinuteSeconds: true })).toBe('5s ago')
  })

  it('clamps future timestamps to the floor', () => {
    expect(relativeTime(new Date(Date.now() + 10_000).toISOString())).toBe('just now')
  })

  it('steps through minutes, hours, and days', () => {
    expect(relativeTime(ago(5 * 60_000))).toBe('5m ago')
    expect(relativeTime(ago(3 * 3_600_000))).toBe('3h ago')
    expect(relativeTime(ago(2 * 86_400_000))).toBe('2d ago')
  })
})

describe('fmtCost', () => {
  it('scales precision to magnitude', () => {
    expect(fmtCost(0)).toBe('$0.000')
    expect(fmtCost(0.123)).toBe('$0.123')
    expect(fmtCost(12.345)).toBe('$12.35') // 2dp rounds
    expect(fmtCost(123.4)).toBe('$123')
  })
})

describe('fmtTokens', () => {
  it('applies SI suffixes', () => {
    expect(fmtTokens(999)).toBe('999')
    expect(fmtTokens(1_000)).toBe('1.0k')
    expect(fmtTokens(1_500_000)).toBe('1.5M')
    expect(fmtTokens(1_234_567_890)).toBe('1.23B')
  })
})

describe('modelLabel', () => {
  it('strips the claude- prefix and spaces dashes', () => {
    expect(modelLabel('claude-opus-4-8')).toBe('opus 4 8')
    expect(modelLabel('gpt-4o')).toBe('gpt 4o')
    expect(modelLabel('')).toBe('')
  })
})

describe('fmtDuration', () => {
  it('formats coarse durations with an em-dash floor', () => {
    expect(fmtDuration(0)).toBe('—')
    expect(fmtDuration(-5)).toBe('—')
    expect(fmtDuration(45_000)).toBe('45s')
    expect(fmtDuration(12 * 60_000)).toBe('12m')
    expect(fmtDuration(2 * 3_600_000 + 30 * 60_000)).toBe('2h 30m')
  })
})

describe('fmtDur', () => {
  it('formats fine durations across unit boundaries', () => {
    expect(fmtDur(999)).toBe('999ms')
    expect(fmtDur(1_500)).toBe('1.5s') // 1 decimal under 10s
    expect(fmtDur(35_000)).toBe('35s') // no decimal from 10s
    expect(fmtDur(60_000)).toBe('1m') // exact minute drops seconds
    expect(fmtDur(65_000)).toBe('1m 5s')
  })
})

describe('isInjectedTurn', () => {
  it('matches Claude Code plumbing turns by exact prefix', () => {
    expect(isInjectedTurn('<local-command-caveat>Caveat: …')).toBe(true)
    expect(isInjectedTurn('  <command-name>/model</command-name>')).toBe(true)
    // The command's OUTPUT is injected too — it rendered as a fourth "YOU" turn, ANSI and all.
    expect(isInjectedTurn('<local-command-stdout>Set model to \x1b[1mSonnet 5\x1b[22m</local-command-stdout>')).toBe(true)
    expect(isInjectedTurn('<system-reminder>…')).toBe(true)
    expect(isInjectedTurn('<synthetic>')).toBe(true)
  })
  it('does NOT match genuine prompts that merely start with markup', () => {
    expect(isInjectedTurn('<Modal> crashes on mount, why?')).toBe(false)
    expect(isInjectedTurn('fix the header')).toBe(false)
  })
})

describe('tildePath', () => {
  it('collapses the macOS and Linux home dirs', () => {
    expect(tildePath('/Users/jane/Developer/operator')).toBe('~/Developer/operator')
    expect(tildePath('/home/jane/src/app')).toBe('~/src/app')
  })

  it('collapses the home dir itself, with no trailing slash left behind', () => {
    expect(tildePath('/Users/jane')).toBe('~')
  })

  it('leaves paths outside a home dir alone', () => {
    expect(tildePath('/opt/tools/repo')).toBe('/opt/tools/repo')
    expect(tildePath('/Usersland/jane/app')).toBe('/Usersland/jane/app')
    expect(tildePath('')).toBe('')
  })
})
