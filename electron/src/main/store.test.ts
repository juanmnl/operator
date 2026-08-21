import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = mkdtempSync(join(tmpdir(), 'operator-store-test-'))
process.env.OPERATOR_DIR = SANDBOX
const store = await import('./store')
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

describe('the durable JSON stores', () => {
  it('round-trips projects, sessions and role defaults', async () => {
    await store.saveProjects([{ id: 'p1', name: 'x' }])
    expect(await store.loadProjects()).toEqual([{ id: 'p1', name: 'x' }])
    await store.saveSessions([{ terminalId: 't0' }])
    expect(await store.loadSessions()).toEqual([{ terminalId: 't0' }])
    await store.saveRoleDefaults({ code: { model: 'opus' } })
    expect(await store.loadRoleDefaults()).toEqual({ code: { model: 'opus' } })
  })

  it('defaults an ABSENT store to empty rather than throwing', async () => {
    process.env.OPERATOR_DIR = join(SANDBOX, 'nothing-here')
    expect(await store.loadProjects()).toEqual([])
    expect(await store.loadSessions()).toEqual([])
    // An OBJECT for role defaults, not an array — it is keyed by role id, and empty means
    // "inherit everything", which is the state before the user configures anything.
    expect(await store.loadRoleDefaults()).toEqual({})
    process.env.OPERATOR_DIR = SANDBOX
  })

  it('reads a CORRUPT store as empty — an app that cannot boot is worse than one that boots empty', async () => {
    const dir = mkdtempSync(join(SANDBOX, 'corrupt-'))
    writeFileSync(join(dir, 'projects.json'), '{ this is not json')
    process.env.OPERATOR_DIR = dir
    expect(await store.loadProjects()).toEqual([])
    process.env.OPERATOR_DIR = SANDBOX
  })

  // serde_json without `preserve_order` writes object keys SORTED. `JSON.stringify` writes them
  // in insertion order, so the first fresh save from the Electron build would have rewritten
  // every object in a different order from the Tauri build's.
  it('writes keys SORTED, matching serde_json', async () => {
    await store.saveProjects([{ path: '/x', name: 'z', id: 'p1', createdAt: 't' }])
    const written = readFileSync(join(SANDBOX, 'projects.json'), 'utf8')
    const keys = [...written.matchAll(/^    "(\w+)":/gm)].map((m) => m[1])
    expect(keys).toEqual([...keys].sort())
    expect(keys).toEqual(['createdAt', 'id', 'name', 'path'])
  })

  it('sorts NESTED objects too', async () => {
    await store.saveRoleDefaults({ zeta: { model: 'opus', effort: 'high' }, alpha: { b: 1, a: 2 } })
    const written = readFileSync(join(SANDBOX, 'role-defaults.json'), 'utf8')
    expect(written.indexOf('"alpha"')).toBeLessThan(written.indexOf('"zeta"'))
    expect(written.indexOf('"effort"')).toBeLessThan(written.indexOf('"model"'))
  })

  it('does NOT reorder arrays — order is meaning there', async () => {
    // railOrder, tasks, sessions: position carries information. Only object KEYS are sorted.
    await store.saveProjects([{ id: 'b' }, { id: 'a' }])
    expect((await store.loadProjects() as Array<{ id: string }>).map((p) => p.id)).toEqual(['b', 'a'])
  })

  it('writes through a temp file and an atomic rename, leaving no .tmp behind', async () => {
    await store.saveProjects([{ id: 'p' }])
    const { readdirSync } = await import('node:fs')
    expect(readdirSync(SANDBOX).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('backupProjects REJECTS when there is nothing to back up — no backup, no write', async () => {
    const dir = mkdtempSync(join(SANDBOX, 'nobackup-'))
    process.env.OPERATOR_DIR = dir
    // The caller's contract is "no backup, no write": a migration that proceeds without one is
    // how a roster is lost with nothing to restore from. Unlike the saves, this must reject.
    await expect(store.backupProjects('stamp')).rejects.toThrow()
    process.env.OPERATOR_DIR = SANDBOX
  })

  it('backupProjects copies the file and returns its path', async () => {
    await store.saveProjects([{ id: 'to-back-up' }])
    const path = await store.backupProjects('2026-08-21')
    expect(path).toContain('backups/projects-2026-08-21.json')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual([{ id: 'to-back-up' }])
  })

  it('operatorDir honours OPERATOR_DIR, else ~/.operator', () => {
    expect(store.operatorDir()).toBe(SANDBOX)
    const saved = process.env.OPERATOR_DIR
    delete process.env.OPERATOR_DIR
    expect(store.operatorDir()).toMatch(/\.operator$/)
    process.env.OPERATOR_DIR = saved
  })
})
