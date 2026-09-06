import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'

// THE SEAM, tested through the REAL `handle()` and a REAL store.
//
// This file exists because of QA report #653. `dispatch` returned the store's row shape
// (`address`) while its own description — and the coordinator's prompt — told the model to read
// `to`, so every real `send` outcome left the calling lane with no address to send to. Both ends
// were unit-tested and both passed: `resolveDispatch` produced a correct `to`, `dispatchVerdict`
// returned a correct `address`, and nothing looked at the join. The types did not catch it either,
// because the verdict was carried as `Record<string, unknown>`.
//
// So the assertions below are deliberately about the WIRE — the exact JSON text a lane receives —
// rather than about either side's internals. A test that asserted "the outcome is send" would
// have passed throughout the bug.

const SANDBOX = mkdtempSync(join(tmpdir(), 'operator-mcp-'))
process.env.OPERATOR_DIR = SANDBOX
process.env.OPERATOR_TERMINAL_ID = 't7'
process.env.OPERATOR_PROJECT_ID = 'p1'
process.env.OPERATOR_ROLE_ID = 'operator'

const { handle } = await import('./mcp-serve')
const { ArtifactStore } = await import('./chat-store')
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

let store: InstanceType<typeof ArtifactStore>
beforeEach(() => {
  store = new ArtifactStore()
  for (const r of store.openDispatches()) store.answerDispatch(r.id, { outcome: 'refused' })
})

const call = (name: string, args: Record<string, unknown>) =>
  handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })

/** Answer the next open request the way the app does — FROM ANOTHER PROCESS.
 *
 *  It has to be another process. `awaitVerdict` blocks its own thread on `Atomics.wait`, so a
 *  `setTimeout` on this thread can never fire while the tool is waiting, and the call would hang
 *  until its 15s timeout. That is not a flaw in the test: it is the shape of the thing. In
 *  production the answerer IS a different process, and a test that could answer in-thread would be
 *  testing an arrangement that does not exist.
 *
 *  Spawned BEFORE the blocking call, so it is already polling when the row appears.
 */
function callAnswered(name: string, args: Record<string, unknown>, verdict: Record<string, unknown>) {
  const require_ = createRequire(import.meta.url)
  const better = require_.resolve('better-sqlite3')
  const child = spawn(process.execPath, [
    join(__dirname, '__fixtures__', 'dispatch-answerer.cjs'),
    better, join(SANDBOX, 'artifacts.db'), JSON.stringify(verdict),
  ], { stdio: 'ignore' })
  try {
    return call(name, args)
  } finally {
    child.kill()
  }
}

/** Pull the JSON a lane would actually receive out of the MCP envelope. */
function wireOf(res: unknown): Record<string, unknown> {
  const r = res as { result?: { content?: Array<{ text?: string }>; isError?: boolean } }
  expect(r.result?.isError).not.toBe(true)
  return JSON.parse(r.result!.content![0].text!)
}

describe('the tools are exposed under the names a prompt can call', () => {
  it('lists `dispatch` and `reply` BARE, so they namespace to mcp__operator__<tool>', () => {
    // Named `operator__dispatch` they would expose as `mcp__operator__operator__dispatch`, which
    // matches nothing any prompt tells a lane to call — the failure already recorded in this
    // module's own header for `report`.
    const res = handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) as
      { result: { tools: Array<{ name: string }> } }
    const names = res.result.tools.map((t) => t.name)
    expect(names).toContain('dispatch')
    expect(names).toContain('reply')
    expect(names.some((n) => n.startsWith('operator__'))).toBe(false)
  })
})

describe('dispatch — the wire contract', () => {
  it('returns `to`, the field its own description tells the model to read', () => {
    // QA #653. The store column is `address`; stringifying the row shipped that name and the
    // lane had nothing to send to.
    const wire = wireOf(callAnswered('dispatch', { lane: 'code', task: 'do the thing' },
      { outcome: 'send', address: 'uds:/tmp/cc-socks/2001.sock', text: 'go' }))
    expect(wire.to).toBe('uds:/tmp/cc-socks/2001.sock')
    expect(wire.text).toBe('go')
    expect(wire.outcome).toBe('send')
    // …and the internal column name never reaches the wire.
    expect(wire).not.toHaveProperty('address')
  })

  it('the description and the payload agree on the field name', () => {
    // The check that would have caught this without a round trip at all: the tool's own text
    // promises a field, so the payload has to carry that field.
    const res = handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) as
      { result: { tools: Array<{ name: string; description: string }> } }
    const desc = res.result.tools.find((t) => t.name === 'dispatch')!.description
    expect(desc).toContain('`to`')
    expect(desc).not.toContain('`address`')
  })

  it('carries `launching` through with no address, because the lane sends nothing', () => {
    const wire = wireOf(callAnswered('dispatch', { lane: 'code', task: 'x' },
      { outcome: 'launching', reason: 'code is not running' }))
    expect(wire.outcome).toBe('launching')
    expect(wire.to).toBeUndefined()
    expect(wire.reason).toContain('not running')
  })

  it('carries `refused` with its reason', () => {
    const wire = wireOf(callAnswered('dispatch', { lane: 'code', task: 'x' },
      { outcome: 'refused', reason: 'delivery brake: hop limit' }))
    expect(wire.outcome).toBe('refused')
    expect(wire.reason).toMatch(/hop limit/)
  })
})

describe('reply — the same contract', () => {
  it('returns `to` and `text` for a send', () => {
    const wire = wireOf(callAnswered('reply', { lane: 'review', line: 'the tests pass' },
      { outcome: 'send', address: 'uds:/tmp/cc-socks/2002.sock', text: 'ack' }))
    expect(wire.to).toBe('uds:/tmp/cc-socks/2002.sock')
    expect(wire.text).toBe('ack')
  })
})

describe('dispatch — refusals that never reach the app', () => {
  it('refuses a call with no lane or no body, and opens no request', () => {
    const before = store.openDispatches().length
    for (const args of [{ lane: '', task: 'x' }, { lane: 'code', task: '   ' }, {}]) {
      const r = call('dispatch', args) as { result?: { isError?: boolean } }
      expect(r.result?.isError).toBe(true)
    }
    expect(store.openDispatches().length).toBe(before)
  })
})
