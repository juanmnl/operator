import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  RELOAD_HASH, RELOAD_LIMIT, RELOAD_WINDOW_MS,
  decideRecovery, errorPageUrl, logRendererGone, rendererGoneLogFile,
} from './renderer-recovery'

const crash = { reason: 'crashed', onErrorPage: false }

// The 2026-10-06 incident: the renderer died after 7 days and the window stayed black until the
// user quit, losing every lane.
describe('decideRecovery', () => {
  it('reloads after a crash or an OOM, and records the reload time', () => {
    expect(decideRecovery(crash, [], 1000)).toEqual({ action: 'reload', reloads: [1000] })
    expect(decideRecovery({ reason: 'oom', onErrorPage: false }, [], 1000).action).toBe('reload')
    expect(decideRecovery({ reason: 'killed', onErrorPage: false }, [], 1000).action).toBe('reload')
  })

  it('does nothing for clean-exit', () => {
    expect(decideRecovery({ reason: 'clean-exit', onErrorPage: false }, [], 1000)).toEqual({ action: 'none', reloads: [] })
  })

  it('reloads up to the limit inside the window, then shows the error page', () => {
    let reloads: number[] = []
    const actions: string[] = []
    for (let i = 0; i < RELOAD_LIMIT + 2; i++) {
      const d = decideRecovery(crash, reloads, 10_000 + i * 1000)
      reloads = d.reloads
      actions.push(d.action)
    }
    expect(actions).toEqual([...Array(RELOAD_LIMIT).fill('reload'), 'error-page', 'error-page'])
    expect(reloads).toHaveLength(RELOAD_LIMIT)
  })

  it('forgets reloads older than the window, so crashes days apart always reload', () => {
    const old = [0, 1000, 2000]
    expect(decideRecovery(crash, old, RELOAD_WINDOW_MS - 1).action).toBe('error-page')
    expect(decideRecovery(crash, old, RELOAD_WINDOW_MS)).toEqual({ action: 'reload', reloads: [1000, 2000, RELOAD_WINDOW_MS] })
    expect(decideRecovery(crash, old, 2000 + RELOAD_WINDOW_MS)).toEqual({ action: 'reload', reloads: [2000 + RELOAD_WINDOW_MS] })
  })

  it('does not reload or reshow when the error page itself dies, so it cannot loop', () => {
    expect(decideRecovery({ reason: 'crashed', onErrorPage: true }, [], 1000).action).toBe('none')
    expect(decideRecovery({ reason: 'crashed', onErrorPage: true }, [1, 2, 3], 4).action).toBe('none')
  })
})

describe('errorPageUrl', () => {
  it('is a data: page with a Reload link to the hash main watches, and escapes what it embeds', () => {
    const url = errorPageUrl('<crashed>', '/tmp/a&b/renderer-gone.log')
    expect(url.startsWith('data:text/html;charset=utf-8,')).toBe(true)
    const html = decodeURIComponent(url.slice(url.indexOf(',') + 1))
    expect(html).toContain(`href="${RELOAD_HASH}">Reload</a>`)
    expect(html).toContain('&#60;crashed&#62;')
    expect(html).toContain('/tmp/a&#38;b/renderer-gone.log')
    expect(html).not.toContain('<crashed>')
  })
})

describe('logRendererGone', () => {
  it('appends one JSON line per event under OPERATOR_DIR/logs', async () => {
    expect(rendererGoneLogFile()).toBe(join(process.env.OPERATOR_DIR!, 'logs', 'renderer-gone.log'))
    await logRendererGone({ at: '2026-10-06T10:17:15.000Z', reason: 'crashed', exitCode: 5, reloaded: true })
    await logRendererGone({ at: '2026-10-06T10:17:16.000Z', reason: 'crashed', exitCode: 5, reloaded: false })
    const lines = readFileSync(rendererGoneLogFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toEqual([
      { at: '2026-10-06T10:17:15.000Z', reason: 'crashed', exitCode: 5, reloaded: true },
      { at: '2026-10-06T10:17:16.000Z', reason: 'crashed', exitCode: 5, reloaded: false },
    ])
  })
})
