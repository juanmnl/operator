import { describe, it, expect } from 'vitest'
import {
  resolveEnv, envForSettingsFile, envNamesToUnset, secretNames,
  resolveSkills, skillOverridesForSettingsFile, enabledPluginsForSettingsFile,
  type EnvEntry, type EnvLayer, type SkillLayer,
} from './resolve-session-config'

const project = (...entries: EnvEntry[]): EnvLayer => ({ origin: 'project', entries })
const lane = (...entries: EnvEntry[]): EnvLayer => ({ origin: 'lane', entries })
const run = (...entries: EnvEntry[]): EnvLayer => ({ origin: 'run', entries })

describe('resolveEnv — merge by NAME, per row', () => {
  // THE TEST THE DESIGN NAMES as the thing most likely to be built wrong: a lane that sets one
  // variable must not shadow the project's whole block.
  it('a lane pin overrides ONE variable and leaves the rest alone', () => {
    const rows = resolveEnv([
      project({ name: 'A', value: '1' }, { name: 'B', value: '2' }, { name: 'C', value: '3' }),
      lane({ name: 'B', value: 'lane-b' }),
    ])
    expect(rows).toEqual([
      { name: 'A', value: '1', origin: 'project' },
      { name: 'B', value: 'lane-b', origin: 'lane', shadowed: { value: '2', origin: 'project' } },
      { name: 'C', value: '3', origin: 'project' },
    ])
  })

  it('last writer wins across all three altitudes', () => {
    const rows = resolveEnv([
      project({ name: 'A', value: 'p' }),
      lane({ name: 'A', value: 'l' }),
      run({ name: 'A', value: 'r' }),
    ])
    expect(rows).toEqual([
      { name: 'A', value: 'r', origin: 'run', shadowed: { value: 'l', origin: 'lane' } },
    ])
  })

  it('keeps the position a name was FIRST seen at, so the list does not reshuffle while editing', () => {
    const rows = resolveEnv([
      project({ name: 'A', value: '1' }, { name: 'B', value: '2' }),
      run({ name: 'B', value: 'x' }, { name: 'C', value: '3' }),
    ])
    expect(rows.map((r) => r.name)).toEqual(['A', 'B', 'C'])
  })

  it('records NO shadow when a higher altitude merely restates the same value', () => {
    const rows = resolveEnv([project({ name: 'A', value: 'same' }), run({ name: 'A', value: 'same' })])
    expect(rows[0].shadowed).toBeUndefined()
    expect(rows[0].origin).toBe('run')
  })

  it('carries a tombstone as its own kind of row, not as an empty value', () => {
    const rows = resolveEnv([project({ name: 'A', value: '1' }), run({ name: 'A', unset: true })])
    expect(rows[0]).toMatchObject({ name: 'A', unset: true, origin: 'run' })
    expect(rows[0].value).toBeUndefined()
  })

  it('distinguishes an EMPTY value from a tombstone — presence tests disagree exactly there', () => {
    const rows = resolveEnv([run({ name: 'A', value: '' }, { name: 'B', unset: true })])
    expect(rows[0]).toEqual({ name: 'A', value: '', origin: 'run' })
    expect(rows[1]).toEqual({ name: 'B', unset: true, origin: 'run' })
  })

  it('carries a secret as a NAME, never a value', () => {
    const rows = resolveEnv([project({ name: 'RAILWAY_TOKEN', secret: 'railway' })])
    expect(rows[0]).toEqual({ name: 'RAILWAY_TOKEN', secret: 'railway', origin: 'project' })
    expect(JSON.stringify(rows)).not.toContain('value')
  })

  it('reads the repo layer as the lowest altitude', () => {
    const rows = resolveEnv([
      { origin: 'repo', entries: [{ name: 'A', value: 'repo' }] },
      project({ name: 'A', value: 'p' }),
    ])
    expect(rows[0]).toMatchObject({ origin: 'project', shadowed: { origin: 'repo', value: 'repo' } })
  })

  it('ignores nameless entries and empty layers rather than emitting a blank row', () => {
    expect(resolveEnv([])).toEqual([])
    expect(resolveEnv([{ origin: 'project' }])).toEqual([])
    expect(resolveEnv([project({ name: '', value: 'x' })])).toEqual([])
  })
})

describe('what reaches the settings file', () => {
  const rows = resolveEnv([project(
    { name: 'NODE_ENV', value: 'staging' },
    { name: 'EMPTY', value: '' },
    { name: 'GONE', unset: true },
    { name: 'RAILWAY_TOKEN', secret: 'railway' },
    { name: 'PORT', value: '9999' },
  )])

  it('writes plain values, INCLUDING an empty one', () => {
    expect(envForSettingsFile(rows)).toMatchObject({ NODE_ENV: 'staging', EMPTY: '' })
  })

  it('NEVER writes a secret — the file is plaintext on disk and outlives the run', () => {
    const written = envForSettingsFile(rows)
    expect(written).not.toHaveProperty('RAILWAY_TOKEN')
    expect(JSON.stringify(written)).not.toContain('railway')
  })

  it('never writes a tombstone: the file has no way to say "remove this name"', () => {
    expect(envForSettingsFile(rows)).not.toHaveProperty('GONE')
    // …so the only place it CAN be honoured is the pty env, by deleting the name before exec.
    expect(envNamesToUnset(rows)).toEqual(['GONE'])
  })

  it('drops a denied name as a backstop against a hand-edited projects.json', () => {
    expect(envForSettingsFile(rows, (n) => n === 'PORT')).not.toHaveProperty('PORT')
    expect(envForSettingsFile(rows)).toHaveProperty('PORT') // …and only when asked to
  })

  it('hands the spawn path secret NAMES to resolve, not values', () => {
    expect(secretNames(rows)).toEqual(['railway'])
  })
})

describe('resolveSkills — the same per-row rule', () => {
  const p = (policy: SkillLayer['policy']): SkillLayer => ({ origin: 'project', policy })
  const r = (policy: SkillLayer['policy']): SkillLayer => ({ origin: 'run', policy })

  it('turning ONE skill off at a higher altitude keeps the twelve below it', () => {
    const resolved = resolveSkills([
      p({ overrides: { a: 'off', b: 'name-only', c: 'on' } }),
      r({ overrides: { b: 'off' } }),
    ])
    expect(resolved.overrides).toEqual([
      { name: 'a', mode: 'off', origin: 'project' },
      { name: 'b', mode: 'off', origin: 'run' },
      { name: 'c', mode: 'on', origin: 'project' },
    ])
  })

  it('merges plugin toggles the same way', () => {
    const resolved = resolveSkills([
      p({ plugins: { 'x@m': true, 'y@m': false } }),
      r({ plugins: { 'y@m': true } }),
    ])
    expect(resolved.plugins).toEqual([
      { plugin: 'x@m', enabled: true, origin: 'project' },
      { plugin: 'y@m', enabled: true, origin: 'run' },
    ])
  })

  it('is empty for empty input rather than inventing defaults', () => {
    expect(resolveSkills([])).toEqual({ overrides: [], plugins: [] })
    expect(resolveSkills([{ origin: 'project' }])).toEqual({ overrides: [], plugins: [] })
  })

  // Verified against the real CLI: a per-session `{"framer-code-components":"on"}` turned on a
  // skill the user's own ~/.claude/settings.json had `off`. Dropping `on` as "the default"
  // would throw away the only way to re-enable a globally-disabled skill for one project.
  it('WRITES an explicit "on" — absent means on only when nothing below says otherwise', () => {
    const resolved = resolveSkills([p({ overrides: { 'framer-code-components': 'on' } })])
    expect(skillOverridesForSettingsFile(resolved)).toEqual({ 'framer-code-components': 'on' })
  })

  it('writes plugin toggles straight through — Claude Code'+ "'" + 's own key, unchanged', () => {
    const resolved = resolveSkills([p({ plugins: { 'mattpocock-skills@claude-plugins-official': false } })])
    expect(enabledPluginsForSettingsFile(resolved)).toEqual({ 'mattpocock-skills@claude-plugins-official': false })
  })
})
