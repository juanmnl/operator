import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// HOME is redirected before the module loads: `loadGlobal` reads ~/.claude, and pointing it at
// the real one would make these tests depend on the user's own settings.
const SANDBOX = mkdtempSync(join(tmpdir(), 'operator-prefs-test-'))
process.env.HOME = SANDBOX
const prefs = await import('./folder-prefs')

const PROJ = join(SANDBOX, 'proj')
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))
beforeAll(() => {
  mkdirSync(join(SANDBOX, '.claude'), { recursive: true })
  mkdirSync(join(PROJ, '.claude'), { recursive: true })
  writeFileSync(join(SANDBOX, '.claude', 'settings.json'), JSON.stringify({ effortLevel: 'high', keepMe: 1 }))
  writeFileSync(join(SANDBOX, '.claude', 'CLAUDE.md'), 'global rules\n')
  writeFileSync(join(PROJ, 'CLAUDE.md'), 'project rules\n')
})

describe('loadGlobal', () => {
  it('reports the three settings scopes in precedence order', async () => {
    const g = await prefs.loadGlobal()
    expect(g.settingsFiles.map((f) => f.scope)).toEqual(['managed', 'global', 'global-local'])
    expect(g.projectName).toBe('Global Claude')
  })

  it('marks managed settings READ-ONLY — they are the organisation\'s, not the user\'s', async () => {
    const g = await prefs.loadGlobal()
    expect(g.settingsFiles.find((f) => f.scope === 'managed')?.readOnly).toBe(true)
    expect(g.settingsFiles.filter((f) => f.scope !== 'managed').every((f) => !f.readOnly)).toBe(true)
  })

  it('a MISSING file is a normal state, not an error', async () => {
    const g = await prefs.loadGlobal()
    const managed = g.settingsFiles.find((f) => f.scope === 'managed')!
    expect(managed.exists).toBe(false)
    expect(managed.settings).toEqual({})   // empty, not null, not a throw
  })

  it('reads the settings it does find', async () => {
    const g = await prefs.loadGlobal()
    expect(g.settingsFiles.find((f) => f.scope === 'global')?.settings).toEqual({ effortLevel: 'high', keepMe: 1 })
  })
})

describe('loadFolder', () => {
  it('layers the project scopes on top of the global ones', async () => {
    const f = await prefs.loadFolder(PROJ)
    expect(f.settingsFiles.map((s) => s.scope)).toEqual(['managed', 'global', 'global-local', 'project', 'project-local'])
    expect(f.mdFiles.map((m) => m.scope)).toEqual(['global', 'project-nested', 'project'])
    expect(f.projectName).toBe('proj')
  })

  it('reads CLAUDE.md content where it exists', async () => {
    const f = await prefs.loadFolder(PROJ)
    expect(f.mdFiles.find((m) => m.scope === 'project')?.content).toBe('project rules\n')
    expect(f.mdFiles.find((m) => m.scope === 'project-nested')?.exists).toBe(false)
  })
})

describe('saveSettings', () => {
  it('MERGES rather than replaces — these files hold keys Operator has no UI for', async () => {
    const path = join(SANDBOX, '.claude', 'settings.json')
    await prefs.saveSettings(path, { effortLevel: 'low' })
    const after = JSON.parse(readFileSync(path, 'utf8'))
    expect(after.effortLevel).toBe('low')
    expect(after.keepMe).toBe(1)      // a key the editor never saw, still there
  })

  it('creates the file and its parent when absent', async () => {
    const path = join(SANDBOX, 'fresh', '.claude', 'settings.json')
    await prefs.saveSettings(path, { a: 1 })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ a: 1 })
  })

  it('writes a trailing newline, as the Rust does', async () => {
    const path = join(SANDBOX, 'nl', 'settings.json')
    await prefs.saveSettings(path, { a: 1 })
    expect(readFileSync(path, 'utf8').endsWith('}\n')).toBe(true)
  })

  it('merges TOP-LEVEL only, so a nested key can still be removed', async () => {
    // A deep merge would make it impossible to delete a nested key from the editor.
    const path = join(SANDBOX, 'deep', 'settings.json')
    await prefs.saveSettings(path, { permissions: { allow: ['a', 'b'] } })
    await prefs.saveSettings(path, { permissions: { allow: ['a'] } })
    expect(JSON.parse(readFileSync(path, 'utf8')).permissions).toEqual({ allow: ['a'] })
  })
})

describe('saveMd and createFile', () => {
  it('saveMd writes verbatim', async () => {
    const path = join(SANDBOX, 'md', 'CLAUDE.md')
    await prefs.saveMd(path, '# exact\n\n  spacing kept  \n')
    expect(readFileSync(path, 'utf8')).toBe('# exact\n\n  spacing kept  \n')
  })

  it('createFile seeds settings with {} and md with nothing', async () => {
    await prefs.createFile(join(SANDBOX, 'new', 'settings.json'), 'settings')
    await prefs.createFile(join(SANDBOX, 'new', 'CLAUDE.md'), 'md')
    expect(readFileSync(join(SANDBOX, 'new', 'settings.json'), 'utf8')).toBe('{}\n')
    expect(readFileSync(join(SANDBOX, 'new', 'CLAUDE.md'), 'utf8')).toBe('')
  })
})

describe('getMcpServers', () => {
  it('collects stdio servers from ~/.claude.json and the project .mcp.json, with their source', async () => {
    writeFileSync(join(SANDBOX, '.claude.json'), JSON.stringify({
      mcpServers: { paper: { type: 'stdio' }, obsidian: {} },
      claudeAiMcpEverConnected: ['linear'],
    }))
    writeFileSync(join(PROJ, '.mcp.json'), JSON.stringify({ mcpServers: { local: { type: 'http' } } }))
    const { servers } = await prefs.getMcpServers(PROJ)
    expect(servers).toEqual([
      { name: 'paper', type: 'stdio', source: '~/.claude.json' },
      // no `type` in the file → stdio, the Claude Code default
      { name: 'obsidian', type: 'stdio', source: '~/.claude.json' },
      // the cloud-connector list has no mcpServers entry and would otherwise be invisible
      { name: 'linear', type: 'cloud', source: 'cloud' },
      { name: 'local', type: 'http', source: '.mcp.json' },
    ])
  })

  it('is empty, not an error, when neither file exists', async () => {
    expect((await prefs.getMcpServers(join(SANDBOX, 'nowhere'))).servers.some((s) => s.source === '.mcp.json')).toBe(false)
  })
})
