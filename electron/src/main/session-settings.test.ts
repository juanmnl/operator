import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = mkdtempSync(join(tmpdir(), 'operator-session-settings-'))
process.env.OPERATOR_DIR = SANDBOX
const s = await import('./session-settings')
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

describe('buildSessionSettings', () => {
  it('always carries tui — the one key that existed before this file did', () => {
    expect(s.buildSessionSettings({ tui: 'fullscreen' })).toEqual({ tui: 'fullscreen' })
  })

  // An empty object is a well-formed instruction that happens to say nothing, and this file is
  // merged at the HIGHEST precedence there is — so a future reader must not find one and take
  // it for an intentional empty set.
  it('omits an EMPTY block rather than writing a meaningless key', () => {
    expect(s.buildSessionSettings({ tui: 'default', env: {}, skillOverrides: {}, enabledPlugins: {} }))
      .toEqual({ tui: 'default' })
  })

  it('carries the blocks that have content', () => {
    expect(s.buildSessionSettings({
      tui: 'default',
      env: { NODE_ENV: 'staging' },
      skillOverrides: { 'framer-code-components': 'off' },
      enabledPlugins: { 'mattpocock-skills@claude-plugins-official': true },
    })).toEqual({
      tui: 'default',
      env: { NODE_ENV: 'staging' },
      skillOverrides: { 'framer-code-components': 'off' },
      enabledPlugins: { 'mattpocock-skills@claude-plugins-official': true },
    })
  })

  it('keeps an empty VALUE inside a non-empty env block — "" is a real setting', () => {
    expect(s.buildSessionSettings({ tui: 'default', env: { A: '' } }).env).toEqual({ A: '' })
  })
})

describe('writeSessionSettings', () => {
  it('writes the file under the session id and returns its path', () => {
    const path = s.writeSessionSettings('sess-1', { tui: 'default', env: { A: '1' } })!
    expect(path).toBe(join(SANDBOX, 'sessions', 'sess-1', 'settings.json'))
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ tui: 'default', env: { A: '1' } })
  })

  // The file lives outside the repo, is written by Operator, and outlives the run. 600 is what
  // makes "only this user can read it" true rather than merely intended.
  it('is mode 600', () => {
    const path = s.writeSessionSettings('sess-2', { tui: 'default' })!
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('is overwritten cleanly on a relaunch of the same session', () => {
    s.writeSessionSettings('sess-3', { tui: 'default', env: { A: '1' } })
    const path = s.writeSessionSettings('sess-3', { tui: 'fullscreen' })!
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ tui: 'fullscreen' })
  })

  // Never being able to launch a lane because a directory was not writable is strictly worse
  // than launching one without its env block, so this reports null and the caller falls back.
  it('returns null instead of throwing when the path cannot be written', () => {
    const prev = process.env.OPERATOR_DIR
    process.env.OPERATOR_DIR = '/dev/null/not-a-directory'
    expect(s.writeSessionSettings('sess-4', { tui: 'default' })).toBeNull()
    process.env.OPERATOR_DIR = prev
  })
})

// REMOTE CONTROL — the one key written even when false.
//
// Read out of the installed binary (2.1.261), not the help text: `remoteControlAtStartup`
// resolves as project/local `false` first, then the first of
// `["policySettings","flagSettings","userSettings"]`, then the legacy global config, then the org
// default — which is currently auto-ON. A `--settings` file is `flagSettings`, so it outranks the
// user's own settings and only an org policy beats it.
describe('remoteControlAtStartup', () => {
  it('is written as true for a lane that has it on', () => {
    expect(s.buildSessionSettings({ tui: 'default', remoteControlAtStartup: true }).remoteControlAtStartup).toBe(true)
  })

  it('IS WRITTEN when false — the whole point, because absent inherits an org default of ON', () => {
    const out = s.buildSessionSettings({ tui: 'default', remoteControlAtStartup: false })
    expect(out).toHaveProperty('remoteControlAtStartup', false)
    // Not merely falsy: the KEY has to be present in the serialised file.
    expect(JSON.parse(JSON.stringify(out))).toHaveProperty('remoteControlAtStartup')
  })

  it('is left out entirely when the caller says nothing, so a merge stays minimal', () => {
    expect(s.buildSessionSettings({ tui: 'default' })).not.toHaveProperty('remoteControlAtStartup')
  })

  it('does not disturb the other keys', () => {
    const out = s.buildSessionSettings({ tui: 'fullscreen', env: { A: '1' }, remoteControlAtStartup: false })
    expect(out).toEqual({ tui: 'fullscreen', env: { A: '1' }, remoteControlAtStartup: false })
  })
})
