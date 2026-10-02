import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), 'operator-announce-log-')))
process.env.OPERATOR_DIR = SANDBOX
const { ANNOUNCE_LOG_MAX_BYTES, announceLogFile, logAnnounce } = await import('./announce-log')

afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

describe('announce log', () => {
  it('writes to ~/.operator/logs/announce.log, one timestamped line per call, in call order', async () => {
    expect(announceLogFile()).toBe(join(SANDBOX, 'logs', 'announce.log'))
    void logAnnounce('tab=t2 first')
    await logAnnounce('tab=t2 second\nwith a newline')
    const lines = readFileSync(announceLogFile(), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\S+ tab=t2 first$/)
    expect(lines[1]).toMatch(/ tab=t2 second with a newline$/)
  })

  it('drops the older half once the file passes the cap', async () => {
    mkdirSync(join(SANDBOX, 'logs'), { recursive: true })
    writeFileSync(announceLogFile(), 'old line\n'.repeat(ANNOUNCE_LOG_MAX_BYTES / 9 + 10))
    await logAnnounce('newest')
    expect(statSync(announceLogFile()).size).toBeLessThan(ANNOUNCE_LOG_MAX_BYTES)
    expect(readFileSync(announceLogFile(), 'utf8').trim().split('\n').at(-1)).toMatch(/ newest$/)
  })
})
