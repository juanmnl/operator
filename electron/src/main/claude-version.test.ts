import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpath } from 'node:fs/promises'
import { ClaudeVersionWatcher, versionFromPath, versionFromOutput, type VersionDeps } from './claude-version'

describe('reading a version', () => {
  it('from the native installer target name', () => {
    expect(versionFromPath('/Users/x/.local/share/claude/versions/2.1.269')).toBe('2.1.269')
    expect(versionFromPath('/opt/claude/versions/2.2.0-beta.1')).toBe('2.2.0-beta.1')
  })

  it('not from a path that is not named by version', () => {
    expect(versionFromPath('/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js')).toBeNull()
    expect(versionFromPath('/usr/local/bin/claude')).toBeNull()
  })

  it('from `claude --version` output', () => {
    expect(versionFromOutput('2.1.269 (Claude Code)\n')).toBe('2.1.269')
    expect(versionFromOutput('command not found')).toBeNull()
  })
})

describe('ClaudeVersionWatcher, against a real symlink', () => {
  let dir = ''
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('follows the link, and reports a change once when the link moves', async () => {
    dir = mkdtempSync(join(tmpdir(), 'claude-version-'))
    const versions = join(dir, 'versions')
    mkdirSync(versions)
    writeFileSync(join(versions, '2.1.268'), '')
    writeFileSync(join(versions, '2.1.269'), '')
    const link = join(dir, 'claude')
    symlinkSync(join(versions, '2.1.268'), link)

    const onChange = vi.fn()
    const runVersion = vi.fn(async () => '')
    const w = new ClaudeVersionWatcher(onChange, { which: async () => link, realpath: (p) => realpath(p), runVersion })

    expect(await w.resolve()).toBe('2.1.268')
    expect(await w.resolve()).toBe('2.1.268')
    expect(onChange).toHaveBeenCalledTimes(1)

    // What the updater does: the link now points at the new binary.
    unlinkSync(link)
    symlinkSync(join(versions, '2.1.269'), link)
    expect(await w.resolve()).toBe('2.1.269')
    expect(w.installed()).toBe('2.1.269')
    expect(onChange).toHaveBeenLastCalledWith('2.1.269')
    expect(onChange).toHaveBeenCalledTimes(2)
    // Named by version, so the binary is never executed.
    expect(runVersion).not.toHaveBeenCalled()
  })
})

describe('ClaudeVersionWatcher — fallbacks', () => {
  const deps = (over: Partial<VersionDeps>): VersionDeps => ({
    which: async () => '/usr/local/bin/claude',
    realpath: async (p) => p,
    runVersion: async () => '',
    ...over,
  })

  it('runs --version once per resolved target when the name carries no version', async () => {
    const runVersion = vi.fn(async () => '2.0.5 (Claude Code)')
    const w = new ClaudeVersionWatcher(() => {}, deps({ realpath: async () => '/npm/claude-code/cli.js', runVersion }))
    expect(await w.resolve()).toBe('2.0.5')
    expect(await w.resolve()).toBe('2.0.5')
    expect(runVersion).toHaveBeenCalledTimes(1)
  })

  it('asks the shell again when the cached command path stops resolving', async () => {
    let first = true
    const which = vi.fn(async () => (first ? '/old/claude' : '/new/claude'))
    const realpathFn = vi.fn(async (p: string) => {
      if (p === '/old/claude' && !first) throw new Error('ENOENT')
      return p === '/new/claude' ? '/v/versions/2.1.300' : '/v/versions/2.1.200'
    })
    const w = new ClaudeVersionWatcher(() => {}, deps({ which, realpath: realpathFn }))
    expect(await w.resolve()).toBe('2.1.200')
    first = false
    expect(await w.resolve()).toBe('2.1.300')
    expect(which).toHaveBeenCalledTimes(2)
  })

  it('reports null, not a stale version, when nothing resolves', async () => {
    const onChange = vi.fn()
    const w = new ClaudeVersionWatcher(onChange, deps({ which: async () => null, realpath: async () => { throw new Error('ENOENT') } }))
    expect(await w.resolve()).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('shares one read between concurrent callers', async () => {
    const realpathFn = vi.fn(async () => '/v/versions/2.1.1')
    const w = new ClaudeVersionWatcher(() => {}, deps({ realpath: realpathFn }))
    await Promise.all([w.resolve(), w.resolve(), w.resolve()])
    expect(realpathFn).toHaveBeenCalledTimes(1)
  })
})
